/**
 * Harness adapter: OpenCode — sessions in a local SQLite database.
 *
 * Each build keeps its own database: `opencode.db` for stable, `opencode-dev.db`
 * for the dev build (review builds land beside them as `opencode-review-<port>.db`
 * and are deliberately not read — ephemeral). Every file present is scanned.
 * `$OPENCODE_DB` names one file outright; `$BOT_CROSSING_OPENCODE_DB` does the
 * same for fixture tests.
 *
 * One bound on opening: `opencode://` is claimed by every installed build and
 * the OS routes it to exactly one of them, so a session id only resolves in
 * the app that wrote it. There is nothing to address a single build with —
 * the scheme is shared.
 *
 * OpenCode v2 moved its sessions into a `session_v2` table and inline their
 * messages into `session_message` (`type` column, content embedded in the row's
 * `data`). An upgraded database keeps the legacy `session` table around, but
 * only as whatever it held before the upgrade — so when `session_v2` exists it
 * is read and the legacy table is left alone. A build that never migrated has
 * no `session_v2` and takes the legacy path, both shapes side by side because
 * stable and dev databases are written by different OpenCode versions.
 *
 * Only top-level sessions count as threads — child rows with `parent_id` set
 * are the task tool's subagents, and OpenCode's own session list filters them
 * the same way. Including them would stand hundreds of astronauts on the map
 * that nobody ever talked to.
 *
 * Read-only, without exception, and no subprocess anywhere.
 */
import path from 'node:path'
import os from 'node:os'
import { exists, findExecutable, num } from '../lib/fsutil.mjs'

const HOME = os.homedir()

/** Where this machine keeps OpenCode databases, honouring XDG like the app does. */
const dataDir = () => {
  const xdg = process.env.XDG_DATA_HOME
  if (typeof xdg === 'string' && xdg) return path.join(xdg, 'opencode')
  return path.join(HOME, '.local', 'share', 'opencode')
}

/** The stable database first, then the dev build's — every file present is read. */
export const defaultDbFiles = () => {
  const files = [path.join(dataDir(), 'opencode.db'), path.join(dataDir(), 'opencode-dev.db')]
  if (process.platform === 'darwin' && !process.env.XDG_DATA_HOME) {
    const mac = path.join(HOME, 'Library', 'Application Support', 'opencode')
    files.push(path.join(mac, 'opencode.db'), path.join(mac, 'opencode-dev.db'))
  }
  return files
}

/**
 * Which files to read. `$BOT_CROSSING_OPENCODE_DB` (fixtures) and `$OPENCODE_DB`
 * each name one file outright: a missing file means "absent", not "fall back to
 * the default and read a database the user did not name". That is also what
 * makes fixture tests isolate from the real store.
 */
async function dbFiles() {
  if (process.env.BOT_CROSSING_OPENCODE_DB) return [process.env.BOT_CROSSING_OPENCODE_DB]
  const override = process.env.OPENCODE_DB
  if (typeof override === 'string' && override) return (await exists(override)) ? [override] : []
  return defaultDbFiles()
}

/**
 * `node:sqlite` is imported lazily and its absence is survivable.
 *
 * It needs Node 22.13, which `package.json` asks for — but asking is not
 * enforcing, and a top level import would take the whole server down on an
 * older Node rather than costing one harness. This way every other harness
 * keeps working and `diagnostic()` explains the gap.
 */
let sqlitePromise
const sqliteApi = () => (sqlitePromise ??= import('node:sqlite').catch(() => null))

/** Prefixed, per the contract in `server/harnesses/README.md`. */
const ID = (raw) => `opencode:${raw}`

/** Session ids look like `ses_f53ca9820ffeU8ASs3LX19bw51`. */
const SESSION_ID = /^ses_[A-Za-z0-9]+$/
// The type check matters wherever an id came back from the page: `RegExp.test`
// stringifies, so a one-element array holding a valid id would pass the pattern
// and then travel on as an array.
const isSessionId = (v) => typeof v === 'string' && SESSION_ID.test(v)
const isAbsDir = (v) => typeof v === 'string' && path.isAbsolute(v)

/** OpenCode writes nothing when it is killed, so an open turn needs a time bound too. */
const ACTIVE_WINDOW_MS = 30 * 60 * 1000

const clean = (v) => String(v || '').replace(/\s+/g, ' ').trim()

function parseModel(raw) {
  if (!raw) return { model: '', effort: '' }
  try {
    const m = typeof raw === 'string' ? JSON.parse(raw) : raw
    return {
      model: typeof m?.id === 'string' ? m.id : '',
      effort: typeof m?.variant === 'string' ? m.variant : ''
    }
  } catch {
    return { model: '', effort: '' }
  }
}

function projectOf(directory) {
  const dir = typeof directory === 'string' ? directory : ''
  if (!dir) return { projectPath: '', project: 'unknown', cwd: '' }
  // Both separators: a Windows directory arrives with either, and `basename`
  // on one OS must still read a path written on another (tests use posix).
  const base = path.basename(dir.replace(/\\/g, '/'))
  return { projectPath: dir, project: base || 'unknown', cwd: dir }
}

/** First user text per session never changes, so it is kept forever. */
const previewCache = new Map()

/** Legacy rows: text arrives through the parts of a message. */
function firstUserTextLegacy(db, sessionId) {
  let out = ''
  try {
    const msgs = db
      .prepare(`SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created ASC LIMIT 8`)
      .all(sessionId)
    for (const m of msgs) {
      let role = ''
      try {
        role = JSON.parse(m.data)?.role || ''
      } catch {
        continue
      }
      if (role !== 'user') continue
      const parts = db
        .prepare(`SELECT data FROM part WHERE message_id = ? ORDER BY time_created ASC LIMIT 8`)
        .all(m.id)
      for (const p of parts) {
        try {
          const d = JSON.parse(p.data)
          if (d?.type === 'text' && typeof d.text === 'string' && clean(d.text)) {
            out = clean(d.text)
            break
          }
        } catch {
          /* a part mid-write — skip it */
        }
      }
      if (out) break
    }
  } catch {
    out = ''
  }
  return out
}

/** v2 rows: the user's text sits inline on the `session_message` row. */
function firstUserTextV2(db, sessionId) {
  let out = ''
  try {
    const msgs = db
      .prepare(`SELECT data FROM session_message WHERE session_id = ? AND type = 'user' ORDER BY seq ASC LIMIT 8`)
      .all(sessionId)
    for (const m of msgs) {
      try {
        const d = JSON.parse(m.data)
        if (typeof d?.text === 'string' && clean(d.text)) {
          out = clean(d.text)
          break
        }
      } catch {
        /* a row mid-write — skip it */
      }
    }
  } catch {
    out = ''
  }
  return out
}

async function firstUserText(db, sessionId, v2) {
  if (previewCache.has(sessionId)) return previewCache.get(sessionId)
  const out = (v2 ? firstUserTextV2 : firstUserTextLegacy)(db, sessionId)
  previewCache.set(sessionId, out)
  return out
}

/** Costly facts kept against `time_updated`, so an unchanged session is read once. */
const factsCache = new Map()

/**
 * Error text that means the user stopped the turn, not that it failed.
 *
 * Seen in the wild: `The user rejected permission to use this specific tool
 * call.` and `Tool execution aborted`. Only a genuine failure reddens an
 * astronaut.
 */
const USER_STOPPED = /user rejected permission|permission.{0,20}denied|denied.{0,20}permission|execution aborted|aborted|cancelled/i

/** Whether a legacy error-status tool part means the run failed. */
function isRealError(raw) {
  let text = ''
  try {
    const d = typeof raw === 'string' ? JSON.parse(raw) : raw
    const state = d?.state || {}
    text = `${state.error || ''}\n${state.output || ''}`
  } catch {
    return true
  }
  return !USER_STOPPED.test(text)
}

/**
 * The same verdict for a v2 tool part, embedded in its message's `content` —
 * its output may be a string or a list of content blocks.
 */
function isRealErrorV2(part) {
  const state = part?.state || {}
  const output = typeof state.output === 'string'
    ? state.output
    : Array.isArray(state.content)
      ? state.content.filter((c) => c?.type === 'text').map((c) => c.text).join('\n')
      : ''
  return !USER_STOPPED.test(`${state.error || ''}\n${output}`)
}

async function sessionFacts(db, sessionId, timeUpdated, v2) {
  const hit = factsCache.get(sessionId)
  if (hit && hit.timeUpdated === timeUpdated) return hit.facts
  const facts = { running: false, hasError: false, sizeBytes: 0 }
  if (v2) return await v2Facts(db, sessionId, timeUpdated, facts)
  return await legacyFacts(db, sessionId, timeUpdated, facts)
}

/** Legacy schema: one row per message in `message`, parts in `part`. */
async function legacyFacts(db, sessionId, timeUpdated, facts) {
  // Counted separately: a store with only one of the two tables still sizes
  // from the half it has, rather than zeroing both on one throw.
  try {
    const msgBytes = db.prepare(`SELECT COALESCE(SUM(LENGTH(data)), 0) AS n FROM message WHERE session_id = ?`).get(sessionId)
    facts.sizeBytes += num(msgBytes?.n)
  } catch {
    /* no message table — the parts still count */
  }
  try {
    const partBytes = db.prepare(`SELECT COALESCE(SUM(LENGTH(data)), 0) AS n FROM part WHERE session_id = ?`).get(sessionId)
    facts.sizeBytes += num(partBytes?.n)
  } catch {
    facts.sizeBytes += 0
  }
  try {
    const last = db
      .prepare(`SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created DESC, rowid DESC LIMIT 1`)
      .get(sessionId)
    if (last?.data) {
      const d = JSON.parse(last.data)
      const completed = d?.time?.completed
      const finished = typeof d?.finish === 'string' && d.finish
      const msgError = typeof d?.error?.name === 'string' ? d.error.name : ''
      const aborted = /abort/i.test(msgError)
      // A trailing user message means the model speaks next — whatever the
      // process is doing, it is not waiting on anyone. A turn that ended in
      // error or abort is over too, even when it carries no finish stamp.
      const open = d?.role === 'user' || (d?.role === 'assistant' && !completed && !finished && !msgError)
      facts.running = open && Date.now() - num(timeUpdated) < ACTIVE_WINDOW_MS
      if (d?.role === 'assistant' && (completed || finished || msgError)) {
        if (aborted) {
          // The user stopped the turn. Same as pressing escape elsewhere:
          // an abandoned turn is not a failed one.
          facts.hasError = false
        } else if (msgError) {
          // The turn itself failed (provider/auth error) — that is what the
          // red eyes are for, even when no single tool part takes the blame.
          facts.hasError = true
        } else {
          // Only the last turn counts: a historic tool error must not redden
          // an astronaut forever. And a turn the *user* stopped is not a
          // failure — a rejected permission or an aborted call is this
          // harness's version of pressing escape.
          const candidates = db
            .prepare(
              `SELECT data FROM part WHERE message_id IN (SELECT id FROM message WHERE session_id = ? ORDER BY time_created DESC LIMIT 3) AND data LIKE '%"status":"error"%' LIMIT 5`
            )
            .all(sessionId)
          facts.hasError = candidates.some((row) => isRealError(row?.data))
        }
      }
    }
  } catch {
    /* mid-write, or gone */
  }
  factsCache.set(sessionId, { timeUpdated, facts })
  return facts
}

/**
 * v2 schema: every message — its text and its tool calls together — is one
 * `session_message` row with the content embedded in `data`, and the trailing
 * `idle` handshake rows are not messages at all. Same verdicts as the legacy
 * path: failed means failed, stopped means stopped.
 */
async function v2Facts(db, sessionId, timeUpdated, facts) {
  try {
    const bytes = db
      .prepare(`SELECT COALESCE(SUM(LENGTH(data)), 0) AS n FROM session_message WHERE session_id = ?`)
      .get(sessionId)
    facts.sizeBytes = num(bytes?.n)
  } catch {
    /* no session_message yet — the thread still lists */
  }
  try {
    const rows = db
      .prepare(
        `SELECT type, data FROM session_message WHERE session_id = ? AND type IN ('user','assistant') ORDER BY seq DESC LIMIT 3`
      )
      .all(sessionId)
    if (rows.length) {
      const parse = (r) => {
        try {
          return JSON.parse(r.data) || {}
        } catch {
          return {}
        }
      }
      // The newest row outside the idle handshakes decides the shape of the
      // turn: a trailing user message means the model speaks next — whatever
      // the process is doing, it is not waiting on anyone. A turn that ended
      // in error or abort is over too, even when it carries no finish stamp.
      const lastAssistant = rows.find((r) => r.type === 'assistant')
      const a = lastAssistant ? parse(lastAssistant) : null
      const completed = typeof a?.time?.completed === 'number'
      const finished = typeof a?.finish === 'string' && a.finish
      const msgError = typeof a?.error?.name === 'string' ? a.error.name : ''
      const aborted = /abort/i.test(msgError)
      const open = rows[0].type === 'user' || (lastAssistant && rows[0].type === 'assistant' && !completed && !finished && !msgError)
      facts.running = open && Date.now() - num(timeUpdated) < ACTIVE_WINDOW_MS
      if (lastAssistant && (completed || finished || msgError)) {
        if (aborted) {
          // The user stopped the turn. Same as pressing escape elsewhere:
          // an abandoned turn is not a failed one.
          facts.hasError = false
        } else if (msgError) {
          // The turn itself failed (provider/auth error) — that is what the
          // red eyes are for, even when no single tool part takes the blame.
          facts.hasError = true
        } else {
          // Only the last turn counts: a historic tool error must not redden
          // an astronaut forever. The tool calls ride inside the assistant
          // row's own `content`, so the recent rows are searched here rather
          // than in a parts table. At most three rows, so each is parsed
          // outright rather than pre-filtered on its JSON spelling.
          facts.hasError = rows
            .map((r) => parse(r))
            .flatMap((d) => (Array.isArray(d.content) ? d.content : []))
            .some((part) => part?.type === 'tool' && part?.state?.status === 'error' && isRealErrorV2(part))
        }
      }
    }
  } catch {
    /* mid-write, or gone */
  }
  factsCache.set(sessionId, { timeUpdated, facts })
  return facts
}

async function readDbFile(dbFile) {
  const sqlite = await sqliteApi()
  if (!sqlite?.DatabaseSync) return []
  let db
  try {
    db = new sqlite.DatabaseSync(dbFile, { readOnly: true })
  } catch {
    // A WAL database whose shared-memory file cannot be used refuses a
    // read-only open. Losing one database beats losing the scan.
    return []
  }
  try {
    const tables = new Set(
      db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all().map((r) => r.name)
    )
    // When the v2 tables exist they are the live ones — the legacy `session`
    // table in a migrated database only holds whatever it held before the
    // upgrade. A build that never migrated takes the legacy path instead.
    const v2 = tables.has('session_v2')
    // Only the chosen thread table is load-bearing: the message reads below
    // degrade to empty facts when their table is absent, rather than costing
    // the pass.
    if (!v2 && !tables.has('session')) return []
    // Undocumented private state that drifts between versions — probe every
    // column before naming it, or one renamed column costs the whole harness.
    const threadTable = v2 ? 'session_v2' : 'session'
    const cols = new Set(db.prepare(`PRAGMA table_info(${threadTable})`).all().map((r) => r.name))
    for (const need of ['id', 'directory', 'title', 'time_created', 'time_updated']) {
      if (!cols.has(need)) return []
    }
    // v2 sleeves every session under a project row whose `worktree` is the
    // base checkout — an OpenCode-managed git worktree (which lives outside
    // the repo, in the data dir) is still that repo's thread, so the join is
    // what keeps such a worktree from reading like its own project. Probed
    // like every other undocumented shape: a `project` table without the
    // expected column, or a legacy database with none at all, simply loses
    // the join.
    let projectRoots = null
    if (v2 && tables.has('project')) {
      const pcols = new Set(db.prepare(`PRAGMA table_info(project)`).all().map((c) => c.name))
      if (pcols.has('id') && pcols.has('worktree')) {
        projectRoots = new Map(
          db.prepare(`SELECT id, worktree FROM project WHERE worktree IS NOT NULL`).all().map((p) => [p.id, p.worktree])
        )
      }
    }
    const rows = db
      .prepare(
        `SELECT id${
          v2 ? ', project_id' : ''
        }, directory, title, agent, model, time_created, time_updated, time_archived FROM ${threadTable} ${cols.has('parent_id') ? 'WHERE parent_id IS NULL' : ''} ORDER BY time_updated DESC`
      )
      .all()
    const out = []
    const joinName = (p) => {
      if (typeof p !== 'string' || !p || p === '/' || p === '\\') return null
      return path.basename(p.replace(/[\\/]+$/, '')) || null
    }
    for (const r of rows) {
      if (typeof r.id !== 'string' || !r.id) continue
      const dir = typeof r.directory === 'string' ? r.directory : ''
      // The project the thread belongs to: an explicit project row wins when
      // the session's directory is inside the base checkout — or when it is
      // one of OpenCode's own managed worktrees, which live in the data dir
      // (`worktree/<project-id-prefix>/<name>`) rather than under the repo, so
      // a path test would strand them. Anything else keeps the honest
      // directory basename it always had.
      const root = projectRoots?.get(r.project_id) || null
      // Trailing separators trimmed on both sides, so `/repo/` and `/repo`
      // are the same checkout whichever of them OpenCode stored.
      const base = typeof root === 'string' ? root.replace(/[\\/]+$/, '') : ''
      const trimmed = dir.replace(/[\\/]+$/, '')
      const under = (parent) => trimmed.startsWith(parent + '/') || trimmed.startsWith(parent + path.sep)
      const managed = Boolean(base) && under(path.join(dataDir(), 'worktree'))
      const inRoot = Boolean(base && trimmed && (trimmed === base || under(base))) || managed
      const name = inRoot ? joinName(root) : null
      const { projectPath, project, cwd } = name
        ? { projectPath: base, project: name, cwd: dir }
        : projectOf(dir)
      const worktree = name && trimmed !== base ? path.basename(trimmed.replace(/\\/g, '/')) : ''
      const { model, effort } = parseModel(r.model)
      const prompt = await firstUserText(db, r.id, v2)
      const title = clean(r.title) || prompt || 'Untitled thread'
      const facts = await sessionFacts(db, r.id, num(r.time_updated), v2)
      out.push({
        id: ID(r.id),
        title: title.slice(0, 120),
        preview: prompt.slice(0, 240),
        project,
        projectPath,
        worktree,
        cwd,
        gitBranch: '',
        model,
        effort,
        createdAt: num(r.time_created),
        lastActivityAt: num(r.time_updated),
        // No focus history, so "have you looked at this" is unknowable — not false.
        lastFocusedAt: 0,
        unread: false,
        running: facts.running,
        hasError: facts.hasError,
        starred: false,
        routine: '',
        prState: '',
        archived: r.time_archived !== null && r.time_archived !== undefined,
        // Bytes, like every other harness: the field is a shared log scale
        // across the whole map, and a token count would make OpenCode
        // buildings taller than Claude ones for the same work.
        sizeBytes: facts.sizeBytes,
        source: typeof r.agent === 'string' ? r.agent : '',
        canOpen: isSessionId(r.id) && isAbsDir(cwd),
        ref: { sessionId: r.id, cwd }
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
  const threads = await Promise.all((await dbFiles()).map((f) => readDbFile(f)))
  return threads.flat()
}

/**
 * Where the `opencode` CLI is. PATH first, then the places its installers put
 * it — never inside an application bundle.
 */
const CLI_DIRS = [
  path.join(HOME, '.opencode', 'bin'),
  path.join(HOME, '.local', 'bin'),
  '/usr/local/bin',
  '/usr/bin',
]
const cliBinary = () => findExecutable('opencode', CLI_DIRS)

/**
 * Opens the exact session in the desktop app. `server=sidecar` addresses the
 * desktop's own local server; the CLI resume rides along so the terminal
 * choice (`via=terminal`) and the Linux fallback land on the session too.
 *
 * Provisional: no per-session route is documented upstream — if the installed
 * build ignores the hostname the app fronts with nothing selected, and this
 * goes back to the honest refusal.
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

async function detect() {
  return (await Promise.all((await dbFiles()).map((f) => exists(f)))).some(Boolean)
}

/**
 * Why a present OpenCode might still look thin. Without this the old-Node case
 * is invisible: the databases are simply skipped, every thread is missing, and
 * nothing says why.
 */
async function diagnostic() {
  const found = (await Promise.all((await dbFiles()).map((f) => exists(f)))).some(Boolean)
  if (!found) return ''
  if (!(await sqliteApi())?.DatabaseSync) {
    return `OpenCode threads need Node 22.13 or newer for their sessions (running ${process.versions.node})`
  }
  return ''
}

export default {
  id: 'opencode',
  name: 'OpenCode',
  detect,
  diagnostic,
  scanThreads,
  openThread,
  newSession,
  paths: {},
}
