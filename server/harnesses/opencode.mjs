/**
 * Harness adapter: OpenCode — sessions in a SQLite database, not on disk.
 *
 * Each build keeps its own database next to the others: `opencode.db` for
 * stable, `opencode-dev.db` for the dev build (review builds land beside them
 * as `opencode-review-<port>.db` and are deliberately not read — ephemeral).
 * Every file present is scanned and its threads tagged with which build owns
 * them, because a session id only resolves in the app that wrote it.
 *
 * That last point bounds what opening can promise. `opencode://` is claimed by
 * every installed build and the OS routes it to exactly one of them, so a deep
 * link for a session from another build fronts an app that does not know that
 * id. There is nothing to address a single build with — the scheme is shared.
 *
 * Each database holds one row per session in `session` (id, directory, title,
 * model as JSON, `time_*` in epoch ms) with transcript parts in `part`
 * (`session_id`, `data`). Task/subagent runs are child rows with `parent_id`
 * set — not conversations anybody had, so they are hidden. Turn state comes
 * from the transcript tail, not from any status row: only a tool call frozen
 * past its grace period reads as parked on the user (waiting/unread) — a
 * fresh one is the model mid-thought, even when still `pending`, because
 * parts are born pending while arguments stream in. The grace is tool-aware
 * (`question` never legitimately executes; `bash`/`task` can run for many
 * minutes), and everything is freshness-gated so crashed sidecars' fossil
 * `running` parts stay buried.
 *
 * Opening is a per-session deep link against the desktop's local server:
 * `opencode://open-session?server=sidecar&session=<id>` activates the tab for
 * that session. The CLI resume (`opencode --session <id>`) rides along with it,
 * which is what lands on the session on Linux when no app claims the scheme —
 * there the server runs the command in a terminal instead.
 *
 * Read-only, without exception, and no subprocess anywhere.
 */
import path from 'node:path'
import os from 'node:os'
import { exists, findExecutable, num } from '../lib/fsutil.mjs'

const HOME = os.homedir()
const DATA_DIR = path.join(HOME, '.local', 'share', 'opencode')
/** The stable database first, then the dev build's — every file present is read. */
export const defaultDbFiles = () => [path.join(DATA_DIR, 'opencode.db'), path.join(DATA_DIR, 'opencode-dev.db')]
/** Overridable for tests to a single file, the way `BOT_CROSSING_CURSOR_PROJECTS` is. */
const dbFiles = () => (process.env.BOT_CROSSING_OPENCODE_DB ? [process.env.BOT_CROSSING_OPENCODE_DB] : defaultDbFiles())

/** Prefixed, per the contract in `server/harnesses/README.md`. */
const ID = (raw) => `opencode:${raw}`

/** Session ids look like `ses_f53ca9820ffeU8ASs3LX19bw51`. */
const SESSION_ID = /^ses_[A-Za-z0-9]+$/
// The type check matters wherever an id came back from the page: `RegExp.test`
// stringifies, so a one-element array holding a valid id would pass the pattern
// and then travel on as an array.
const isSessionId = (v) => typeof v === 'string' && SESSION_ID.test(v)
const isAbsDir = (v) => typeof v === 'string' && path.isAbsolute(v)

/**
 * `node:sqlite` is imported lazily and its absence is survivable, the same
 * shape `codex.mjs` ended up in: it needs Node 22.13, which `package.json`
 * asks for — but asking is not enforcing, and a top level import would take
 * the whole server down on an older Node rather than costing one harness.
 */
let sqlitePromise
const sqliteApi = () => (sqlitePromise ??= import('node:sqlite').catch(() => null))

/**
 * `model` is a JSON string like `{"id":"…","providerID":"…","variant":"…"}` on
 * recent versions and a plain id on older ones. Either way the card wants the
 * id; anything unparseable degrades to empty rather than throwing the scan.
 */
function modelId(raw) {
  if (typeof raw !== 'string') return ''
  const text = raw.trim()
  if (!text) return ''
  if (!text.startsWith('{')) return text
  try {
    const id = JSON.parse(text)?.id
    return typeof id === 'string' ? id : ''
  } catch {
    return ''
  }
}

function projectOf(directory) {
  const dir = isAbsDir(directory) ? directory : ''
  return { projectPath: dir, project: dir ? path.basename(dir) : 'unknown' }
}

/** Transcript bytes per session, in one query — the field buildings are scaled on. */
function partSizes(db, tables) {
  if (!tables.has('part')) return new Map()
  try {
    const cols = new Set(db.prepare('PRAGMA table_info(part)').all().map((r) => r.name))
    if (!cols.has('session_id') || !cols.has('data')) return new Map()
    const rows = db.prepare('SELECT session_id, SUM(LENGTH(data)) AS bytes FROM part GROUP BY session_id').all()
    return new Map(rows.map((r) => [r.session_id, num(r.bytes)]))
  } catch {
    return new Map()
  }
}

/**
 * How recently a session must have moved to count as "now".
 *
 * One sidecar serves every session, so there is no per-thread process to
 * probe — and a `running` part can be a fossil from a dead server (seen in
 * the wild: an `edit` still `running` three days later). Anything older than
 * this window reads as history, never as work. Same duration as the Claude
 * adapter's window, for the same reason.
 */
const ACTIVE_WINDOW_MS = 30 * 60 * 1000

/**
 * How long an open tool call may sit without an update before it reads as
 * parked on the user rather than executing. `question` never legitimately
 * runs — it asks and waits — so its grace is short. `bash` and `task` can
 * run for many minutes, so theirs is long; everything else finishes in
 * seconds when it is actually executing.
 */
const QUESTION_GRACE_MS = 90 * 1000
const TOOL_PARKED_GRACE_MS = 3 * 60 * 1000
/**
 * How long a finished tool call still counts as the turn in motion. Without
 * this the astronaut drops to idle in the gap between one tool completing and
 * the next starting — mid-task sessions flicker working/idle every poll.
 */
const WORKING_GRACE_MS = 2 * 60 * 1000
const LONG_TOOL_PARKED_GRACE_MS = 15 * 60 * 1000
const LONG_TOOLS = new Set(['bash', 'task'])
/**
 * How long the latest text must sit untouched before a trailing question
 * counts. Streaming text ends with `?` mid-sentence all the time; only a
 * settled turn asking reads as parked.
 */
const TEXT_SETTLED_MS = 60 * 1000

/**
 * Per-session turn state from transcript tails, in aggregate queries —
 * never one query per session, the scan runs on a poll.
 *
 * Pending approvals and questions live only in the sidecar's memory, so what
 * the database can say is where the transcript stopped — and `pending` does
 * NOT mean parked: parts are born `pending` with empty input while arguments
 * stream in, and flip to `running` on the `tool-call` event, while approvals
 * park an already-`running` call. Either way, only a call frozen past its
 * grace period reads as parked; a fresh one is the model mid-thought. The
 * grace is tool-aware because a `question` never legitimately executes while
 * a `bash` can run for many minutes.
 */
function turnStates(db, tables, now) {
  const out = new Map()
  const blank = () => ({ parked: 0, active: 0, endsWithQuestion: false, questionAt: 0, errorAt: 0, progressAt: 0, workAt: 0, errorTimed: true, lastRole: '' })
  const cutoff = now - ACTIVE_WINDOW_MS
  if (tables.has('part')) {
    try {
      const cols = new Set(db.prepare('PRAGMA table_info(part)').all().map((r) => r.name))
      if (!cols.has('session_id') || !cols.has('data')) return out
      if (cols.has('time_updated')) {
        // Open tool calls — one row each, evaluated in JS because the grace
        // depends on which tool is parked.
        const rows = db
          .prepare(
            `SELECT session_id, json_extract(data,'$.tool') AS tool,
              json_extract(data,'$.state.status') AS status, time_updated
             FROM part
             WHERE json_extract(data,'$.type') = 'tool'
               AND json_extract(data,'$.state.status') IN ('pending','running')
               AND time_updated > ${cutoff}`
          )
          .all()
        for (const r of rows) {
          if (typeof r.session_id !== 'string' || !r.session_id) continue
          const entry = out.get(r.session_id) ?? blank()
          const grace =
            r.tool === 'question'
              ? QUESTION_GRACE_MS
              : LONG_TOOLS.has(r.tool)
                ? LONG_TOOL_PARKED_GRACE_MS
                : TOOL_PARKED_GRACE_MS
          if (now - num(r.time_updated) > grace) entry.parked += 1
          else entry.active += 1
          out.set(r.session_id, entry)
        }
      } else {
        // Ancient schema without `time_updated`: count every open call as
        // active and let the session timestamp bound fossils instead.
        const rows = db
          .prepare(
            `SELECT session_id, COUNT(*) AS open
             FROM part
             WHERE json_extract(data,'$.type') = 'tool'
               AND json_extract(data,'$.state.status') IN ('pending','running')
             GROUP BY session_id`
          )
          .all()
        for (const r of rows) {
          if (typeof r.session_id !== 'string' || !r.session_id) continue
          const entry = out.get(r.session_id) ?? blank()
          entry.active += num(r.open)
          out.set(r.session_id, entry)
        }
      }
      // Latest tool outcome per session, for the error rule: an error only
      // slumps the astronaut while nothing newer supersedes it.
      if (cols.has('time_updated')) {
        const rows = db
          .prepare(
            `SELECT session_id,
              MAX(CASE WHEN json_extract(data,'$.type') = 'tool'
                AND json_extract(data,'$.state.status') = 'error' THEN time_updated ELSE 0 END) AS error_at,
              MAX(CASE WHEN json_extract(data,'$.type') = 'tool'
                AND json_extract(data,'$.state.status') IN ('completed','running','pending')
                THEN time_updated ELSE 0 END) AS progress_at,
              MAX(CASE WHEN json_extract(data,'$.type') = 'tool'
                AND json_extract(data,'$.state.status') IN ('completed','running','pending')
                AND json_extract(data,'$.tool') != 'question'
                THEN time_updated ELSE 0 END) AS work_at
            FROM part GROUP BY session_id`
          )
          .all()
        for (const r of rows) {
          if (typeof r.session_id !== 'string' || !r.session_id) continue
          const entry = out.get(r.session_id) ?? blank()
          entry.errorAt = num(r.error_at)
          entry.progressAt = num(r.progress_at)
          entry.workAt = num(r.work_at)
          entry.errorTimed = true
          out.set(r.session_id, entry)
        }
      } else {
        const rows = db
          .prepare(
            `SELECT session_id,
              SUM(CASE WHEN json_extract(data,'$.type') = 'tool'
                AND json_extract(data,'$.state.status') = 'error' THEN 1 ELSE 0 END) AS error_at
            FROM part GROUP BY session_id`
          )
          .all()
        for (const r of rows) {
          if (typeof r.session_id !== 'string' || !r.session_id) continue
          const entry = out.get(r.session_id) ?? blank()
          entry.errorAt = num(r.error_at)
          entry.progressAt = 0
          entry.workAt = 0
          entry.errorTimed = false
          out.set(r.session_id, entry)
        }
      }
    } catch {
      /* a session mid-write — no turn state this pass */
    }
  }
  if (tables.has('message')) {
    try {
      const cols = new Set(db.prepare('PRAGMA table_info(message)').all().map((r) => r.name))
      if (cols.has('session_id') && cols.has('data') && cols.has('time_created')) {
        // Newest first, so the first row seen per session is its latest message.
        const rows = db
          .prepare(`SELECT session_id, json_extract(data,'$.role') AS role FROM message ORDER BY time_created DESC`)
          .all()
        const seen = new Set()
        for (const r of rows) {
          if (typeof r.session_id !== 'string' || !r.session_id || seen.has(r.session_id)) continue
          seen.add(r.session_id)
          const entry = out.get(r.session_id) ?? blank()
          entry.lastRole = typeof r.role === 'string' ? r.role : ''
          out.set(r.session_id, entry)
        }
      }
    } catch {
      /* a session mid-write — roles stay unknown */
    }
  }
  // Newest assistant text per session: a turn that ends asking is parked on
  // the user even though every tool call completed — the `question` tool is
  // not the only way the agent asks. Only the shape counts (ends with a
  // question mark); only the latest text counts (an answered question keeps
  // working, which the tool rules already report).
  if (tables.has('part')) {
    try {
      const cols = new Set(db.prepare('PRAGMA table_info(part)').all().map((r) => r.name))
      if (cols.has('session_id') && cols.has('data') && cols.has('time_created') && cols.has('time_updated')) {
        const rows = db
          .prepare(
            `SELECT session_id, json_extract(data,'$.text') AS text, time_updated FROM part
             WHERE json_extract(data,'$.type') = 'text' ORDER BY time_created DESC`
          )
          .all()
        const seen = new Set()
        for (const r of rows) {
          if (typeof r.session_id !== 'string' || !r.session_id || seen.has(r.session_id)) continue
          seen.add(r.session_id)
          if (typeof r.text !== 'string') continue
          const trimmed = r.text.trim().replace(/["'”’)\]]+$/, '')
          if (!trimmed.endsWith('?')) continue
          const entry = out.get(r.session_id) ?? blank()
          entry.endsWithQuestion = true
          entry.questionAt = num(r.time_updated)
          out.set(r.session_id, entry)
        }
      }
    } catch {
      /* a session mid-write — no question check this pass */
    }
  }
  return out
}

/** One database file's threads. Exported so tests can point at fixtures directly. */
export async function scanDbFile(dbFile) {
  const sqlite = await sqliteApi()
  if (!sqlite?.DatabaseSync) return []
  // Which build owns these threads — a session id only resolves in its own app.
  const source = path.basename(dbFile) === 'opencode-dev.db' ? 'dev-db' : 'db'
  let db
  try {
    db = new sqlite.DatabaseSync(dbFile, { readOnly: true })
  } catch {
    // A WAL database whose shared-memory file cannot be used refuses a
    // read-only open. Better no threads from this build this pass than no scan.
    return []
  }
  try {
    const tables = new Set(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name)
    )
    if (!tables.has('session')) return []
    const columns = new Set(db.prepare('PRAGMA table_info(session)').all().map((r) => r.name))
    for (const required of ['id', 'directory']) {
      if (!columns.has(required)) return []
    }
    // Every column is probed before it is named: this is undocumented private
    // state and a `SELECT` naming a column that has gone throws away the pass.
    const select = (name, fallback) => (columns.has(name) ? `${name}` : `${fallback} AS ${name}`)
    const rows = db
      .prepare(
        `SELECT id, directory,
          ${select('title', "''")}, ${select('model', "''")},
          ${select('parent_id', 'NULL')}, ${select('time_archived', 'NULL')},
          ${select('time_created', '0')}, ${select('time_updated', '0')}
        FROM session`
      )
      .all()
    const sizes = partSizes(db, tables)
    const now = Date.now()
    const cutoff = now - ACTIVE_WINDOW_MS
    const turns = turnStates(db, tables, now)
    const out = []
    for (const row of rows) {
      if (typeof row.id !== 'string' || !row.id) continue
      if (row.parent_id != null) continue // a task run, not a conversation
      const { projectPath, project } = projectOf(row.directory)
      const cwd = isAbsDir(row.directory) ? row.directory : ''
      // Where the transcript stopped decides the astronaut's posture: a call
      // frozen past its grace is parked on the user, as is a settled turn
      // whose last word is a question; a fresh call, or an unanswered-you
      // prompt, means the agent holds the turn. An error only slumps it
      // while it is the latest tool outcome — newer completed work means the
      // turn recovered. Archived threads are home regardless of what their
      // tail says.
      const turn = turns.get(row.id) ?? { parked: 0, active: 0, endsWithQuestion: false, questionAt: 0, errorAt: 0, progressAt: 0, workAt: 0, errorTimed: true, lastRole: '' }
      const fresh = now - num(row.time_updated) < ACTIVE_WINDOW_MS
      const archived = row.time_archived != null
      const asked = turn.endsWithQuestion && turn.active === 0 && turn.lastRole === 'assistant' && now - turn.questionAt > TEXT_SETTLED_MS
      const waiting = !archived && fresh && (turn.parked > 0 || asked)
      // A tool finished seconds ago is still the turn in motion — the next
      // call (or the verdict on this one) has simply not landed yet. A
      // completed `question` is settled asking, not work, so it is tracked
      // separately and excluded here.
      const recentWork = now - turn.workAt < WORKING_GRACE_MS
      const running = !archived && fresh && !waiting && (turn.active > 0 || turn.lastRole === 'user' || recentWork)
      const errored = turn.errorTimed
        ? turn.errorAt > turn.progressAt && turn.errorAt > cutoff
        : turn.errorAt > 0
      out.push({
        id: ID(row.id),
        title: String(row.title || '').trim() || 'Untitled thread',
        preview: '',
        project,
        projectPath,
        worktree: '',
        cwd,
        gitBranch: '',
        model: modelId(row.model),
        effort: '',
        createdAt: num(row.time_created),
        lastActivityAt: num(row.time_updated),
        // OpenCode records no focus history, so "have you looked at this" is
        // unknowable — not false. A parked turn overrides that: waiting is
        // the only way a thread can ask for anything at all.
        lastFocusedAt: 0,
        unread: waiting,
        running,
        hasError: errored,
        starred: false,
        routine: '',
        prState: '',
        archived: row.time_archived != null,
        sizeBytes: sizes.get(row.id) || 0,
        source,
        canOpen: isSessionId(row.id) && isAbsDir(cwd),
        ref: { sessionId: row.id, cwd },
      })
    }
    return out
  } catch {
    return []
  } finally {
    try {
      db.close()
    } catch {
      /* already gone */
    }
  }
}

async function scanThreads() {
  const threads = await Promise.all(dbFiles().map((f) => scanDbFile(f)))
  return threads.flat()
}

/**
 * Where the `opencode` CLI is. PATH first, then the places its installer puts
 * it — never inside an application bundle.
 */
const CLI_DIRS = [path.join(HOME, '.opencode', 'bin'), path.join(HOME, '.local', 'bin')]
const cliBinary = () => findExecutable('opencode', CLI_DIRS)

/**
 * Opens the exact session in the desktop app. `server=sidecar` addresses the
 * desktop's own local server; the CLI resume rides along for Linux, where the
 * server runs it in a terminal when no app claims the scheme.
 */
async function openThread(ref) {
  const sessionId = ref?.sessionId
  const cwd = ref?.cwd
  if (!isSessionId(sessionId) || !isAbsDir(cwd)) {
    return { ok: false, error: 'No openable OpenCode session on that thread' }
  }
  const url = `opencode://open-session?${new URLSearchParams({ server: 'sidecar', session: sessionId })}`
  const bin = await cliBinary()
  const command = bin ? { argv: [bin, '--session', sessionId], cwd } : undefined
  return { ok: true, url, command }
}

/** `opencode://new-session?directory=…` is the link the app actually answers. */
async function newSession(dir) {
  if (!isAbsDir(dir)) return { ok: false, error: 'That folder is not somewhere OpenCode can open' }
  const url = `opencode://new-session?${new URLSearchParams({ directory: dir })}`
  const bin = await cliBinary()
  const command = bin ? { argv: [bin, dir], cwd: dir } : undefined
  return { ok: true, url, command }
}

/**
 * Why a present OpenCode might still look thin. Without this the Node case is
 * invisible: the databases are simply skipped and nothing says why.
 */
async function diagnostic() {
  const found = (await Promise.all(dbFiles().map((f) => exists(f)))).some(Boolean)
  if (!found) return ''
  if (!(await sqliteApi())?.DatabaseSync) {
    return `OpenCode threads need Node 22.13 or newer (running ${process.versions.node})`
  }
  return ''
}

export default {
  id: 'opencode',
  name: 'OpenCode',
  detect: async () => (await Promise.all(dbFiles().map((f) => exists(f)))).some(Boolean),
  diagnostic,
  scanThreads,
  openThread,
  newSession,
  paths: { dir: DATA_DIR },
}
