/**
 * The harness seam: what an adapter is allowed to hand back, and the two things the colony has
 * historically got wrong about a thread — which repo it belongs to, and whether it is working.
 *
 * Fixture-driven. Nothing here reads a real harness, so it says the same thing on any machine.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { HARNESSES } from '../server/harnesses/index.mjs'
import codex from '../server/harnesses/codex.mjs'
import claudeCode from '../server/harnesses/claude-code.mjs'
import opencode, { defaultDbFiles, scanDbFile } from '../server/harnesses/opencode.mjs'
import { readTail, findExecutable } from '../server/lib/fsutil.mjs'
import { schemeOf, openInTerminal } from '../server/lib/xdg.mjs'

// ── the contract ──────────────────────────────────────────────────────────────

test('every registered harness implements the interface, and none of them can write', () => {
  for (const h of HARNESSES) {
    assert.match(h.id, /^[a-z0-9-]+$/, `${h.id} is not a kebab-case id`)
    assert.equal(typeof h.name, 'string')
    for (const fn of ['detect', 'scanThreads', 'openThread', 'newSession']) {
      assert.equal(typeof h[fn], 'function', `${h.id} is missing ${fn}()`)
    }
    // The one rule the project will not bend on. An adapter that grows a write is a bug.
    assert.equal(h.setArchived, undefined, `${h.id} must not write to its harness`)
  }
})

test('harness ids are unique, and so are the id prefixes they hand out', () => {
  const ids = HARNESSES.map((h) => h.id)
  assert.equal(new Set(ids).size, ids.length)
})

// ── ids are prefixed, and refs from the page are not trusted ──────────────────

test('a session id that merely stringifies to a UUID is refused', async () => {
  // `RegExp.test` coerces, so an array holding a valid id passes the pattern and then travels on
  // as an array. Both adapters check the type first.
  const uuid = '2df3987c-02d3-405e-b8f5-da30e3835213'
  assert.equal((await claudeCode.openThread({ cliSessionId: [uuid] })).ok, false)
  assert.equal((await claudeCode.openThread({ desktopSessionId: { toString: () => `local_${uuid}` } })).ok, false)
  assert.equal(codex.openThread({ sessionId: [uuid] }).ok, false)
  assert.equal(codex.openThread({}).ok, false)
  assert.equal(codex.openThread(null).ok, false)
})

test('codex opens through the registered scheme and prefixes its ids', () => {
  const id = '019cc762-45a2-7112-89cd-cd345c17e834'
  const opened = codex.openThread({ sessionId: id })
  assert.equal(opened.ok, true)
  assert.equal(schemeOf(opened.url), 'codex')
  assert.equal(opened.url, `codex://threads/${id}`)
})

// ── a Codex install, faked on disk ────────────────────────────────────────────

const line = (type, payload, timestamp = '2026-09-07T12:00:00.000Z') => JSON.stringify({ timestamp, type, payload })

/** One id for every fixture, so a test can name it before the transcript exists. */
const SESSION_ID = '019cc762-45a2-7112-89cd-cd345c17e834'

async function fakeCodex(records) {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'codex-fixture-'))
  const day = path.join(home, 'sessions', '2026', '09', '07')
  await fsp.mkdir(day, { recursive: true })
  await fsp.writeFile(path.join(day, `rollout-2026-09-07T12-00-00-${SESSION_ID}.jsonl`), records.join('\n') + '\n')
  return home
}

async function scanWith(home) {
  process.env.CODEX_HOME = home
  const mod = await import(`../server/harnesses/codex.mjs?${home}`)
  return mod.default
}

test('a CLI-only Codex session is found with no database at all', async () => {
  const home = await fakeCodex([
    line('session_meta', { id: SESSION_ID, cwd: '/tmp/demo', git: { branch: 'main' } }),
    line('turn_context', { model: 'gpt-5.3-codex', effort: 'high' }),
    line('response_item', { type: 'message', role: 'user', content: [{ text: 'ship the thing' }] }),
    line('event_msg', { type: 'task_complete' }),
  ])
  const h = await scanWith(home)
  assert.equal(await h.detect(), true)
  const [t] = await h.scanThreads()
  assert.equal(t.id, `codex:${SESSION_ID}`, 'ids are prefixed')
  assert.equal(t.project, 'demo')
  assert.equal(t.model, 'gpt-5.3-codex')
  assert.equal(t.effort, 'high')
  assert.equal(t.gitBranch, 'main')
  assert.equal(t.preview, 'ship the thing')
  assert.ok(t.sizeBytes > 0, 'sizeBytes is transcript bytes, not a token count')
  assert.equal(t.running, false)
  await fsp.rm(home, { recursive: true, force: true })
})

test('an interrupted turn is not an error — escape must not redden an astronaut', async () => {
  const home = await fakeCodex([
    line('session_meta', { id: SESSION_ID, cwd: '/tmp/demo' }),
    line('event_msg', { type: 'task_started' }),
    line('event_msg', { type: 'turn_aborted' }),
  ])
  const h = await scanWith(home)
  const [t] = await h.scanThreads()
  assert.equal(t.hasError, false)
  assert.equal(t.running, false, 'an aborted turn is not still running')
  await fsp.rm(home, { recursive: true, force: true })
})

test('a task started long ago is not still running', async () => {
  const home = await fakeCodex([
    line('session_meta', { id: SESSION_ID, cwd: '/tmp/demo' }),
    line('event_msg', { type: 'task_started' }),
  ])
  const day = path.join(home, 'sessions', '2026', '09', '07')
  const [file] = await fsp.readdir(day)
  const old = new Date(Date.now() - 6 * 60 * 60 * 1000)
  await fsp.utimes(path.join(day, file), old, old)
  const h = await scanWith(home)
  const [t] = await h.scanThreads()
  assert.equal(t.running, false, 'Codex writes nothing when killed, so the window has to bound it')
  await fsp.rm(home, { recursive: true, force: true })
})

test('malformed records are skipped rather than throwing the scan away', async () => {
  const home = await fakeCodex([
    'not json at all',
    '{"half": ',
    line('session_meta', { id: SESSION_ID, cwd: '/tmp/demo' }),
    line('response_item', { type: 'message', role: 'user', content: 'hello' }),
  ])
  const h = await scanWith(home)
  const threads = await h.scanThreads()
  assert.equal(threads.length, 1)
  assert.equal(threads[0].preview, 'hello')
  await fsp.rm(home, { recursive: true, force: true })
})

test('an absent Codex is simply not detected', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'codex-empty-'))
  const h = await scanWith(home)
  assert.equal(await h.detect(), false)
  assert.deepEqual(await h.scanThreads(), [])
  await fsp.rm(home, { recursive: true, force: true })
})

// ── shared helpers ────────────────────────────────────────────────────────────

test('readTail drops the partial line it lands in the middle of', async () => {
  const f = path.join(await fsp.mkdtemp(path.join(os.tmpdir(), 'tail-')), 'x.jsonl')
  await fsp.writeFile(f, 'first line\nsecond line\nthird line\n')
  assert.equal(await readTail(f, 15), 'third line\n')
  assert.equal(await readTail(f, 1000), 'first line\nsecond line\nthird line\n')
})

test('findExecutable refuses junk, and refuses a directory that sits on PATH', async () => {
  assert.equal(await findExecutable(''), null)
  assert.equal(await findExecutable(null), null)
  assert.equal(await findExecutable('.'), null)
  assert.equal(await findExecutable('definitely-not-a-real-binary-xyz'), null)
})

test('openInTerminal refuses anything not already resolved to absolute paths', async () => {
  assert.equal((await openInTerminal(['ls'], '/tmp')).ok, false, 'relative argv[0]')
  assert.equal((await openInTerminal(['/bin/ls'], 'relative')).ok, false, 'relative cwd')
  assert.equal((await openInTerminal([], '/tmp')).ok, false, 'empty argv')
  assert.equal((await openInTerminal(['/bin/ls', 123], '/tmp')).ok, false, 'non-string argument')
})

// ── Cursor, faked on disk ─────────────────────────────────────────────────────

async function fakeCursor(dirName, records) {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'cursor-fixture-'))
  const dir = path.join(home, dirName, 'agent-transcripts', SESSION_ID)
  await fsp.mkdir(dir, { recursive: true })
  await fsp.writeFile(path.join(dir, `${SESSION_ID}.jsonl`), records.map((r) => JSON.stringify(r)).join('\n') + '\n')
  return home
}

async function cursorWith(home) {
  process.env.BOT_CROSSING_CURSOR_PROJECTS = home
  const mod = await import(`../server/harnesses/cursor.mjs?${home}`)
  return mod.default
}

const askedFor = (text) => ({ role: 'user', message: { content: [{ type: 'text', text }] } })

test('a Cursor transcript yields a thread with the typed query as its title', async () => {
  const home = await fakeCursor('tmp', [
    askedFor('<timestamp>Tuesday, Sep 8, 2026, 4:08 PM (UTC-7)</timestamp>\n<user_query>\nwhat project is this?\n</user_query>'),
    { role: 'assistant', message: { content: [{ type: 'text', text: 'It is…' }] } },
    { type: 'turn_ended', status: 'success' },
  ])
  const h = await cursorWith(home)
  assert.equal(await h.detect(), true)
  const [t] = await h.scanThreads()
  assert.equal(t.id, `cursor:${SESSION_ID}`)
  // Cursor's own wrapper tags are scaffolding, not something a person typed.
  assert.equal(t.title, 'what project is this?')
  assert.equal(t.running, false, 'a closed turn is not running')
  assert.equal(t.hasError, false)
  await fsp.rm(home, { recursive: true, force: true })
})

test('a transcript from before turn_ended existed is not reported as mid-turn', async () => {
  // The older corpus carries no markers at all. Reading "no marker" as "still working" would
  // light up every historical thread on the map.
  const home = await fakeCursor('tmp', [
    askedFor('<user_query>old thread</user_query>'),
    { role: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } },
  ])
  const h = await cursorWith(home)
  const [t] = await h.scanThreads()
  assert.equal(t.running, false)
  await fsp.rm(home, { recursive: true, force: true })
})

test('a failed turn is an error, and an open turn is running', async () => {
  const home = await fakeCursor('tmp', [
    askedFor('<user_query>do it</user_query>'),
    { type: 'turn_ended', status: 'error' },
  ])
  const h = await cursorWith(home)
  const [t] = await h.scanThreads()
  assert.equal(t.hasError, true)
  await fsp.rm(home, { recursive: true, force: true })
})

test('opencode opens the exact session through the open-session link', async () => {
  const opened = await opencode.openThread({ sessionId: 'ses_abc123XYZ', cwd: '/tmp/demo' })
  assert.equal(opened.ok, true)
  assert.equal(schemeOf(opened.url), 'opencode')
  const url = new URL(opened.url)
  assert.equal(url.hostname, 'open-session')
  assert.equal(url.searchParams.get('server'), 'sidecar')
  assert.equal(url.searchParams.get('session'), 'ses_abc123XYZ')
  // The CLI resume rides along for machines where the link only fronts the app.
  // Absent on machines without the binary, so only the shape is pinned here.
  if (opened.command) {
    assert.ok(path.isAbsolute(opened.command.argv[0]), 'argv[0] is resolved')
    assert.ok(opened.command.argv.includes('--session'), 'resumes via --session')
    assert.ok(opened.command.argv.includes('ses_abc123XYZ'), 'resumes this session')
    assert.equal(opened.command.cwd, '/tmp/demo')
  }
})

test('opencode refuses refs from the page that are not usable', async () => {
  assert.equal((await opencode.openThread({ sessionId: ['ses_abc123XYZ'], cwd: '/tmp/demo' })).ok, false)
  assert.equal((await opencode.openThread({})).ok, false)
  assert.equal((await opencode.openThread(null)).ok, false)
  assert.equal((await opencode.openThread({ sessionId: 'ses_abc123XYZ' })).ok, false, 'no cwd, no project link')
  assert.equal((await opencode.openThread({ sessionId: 'ses_abc123XYZ', cwd: 'relative/path' })).ok, false)
  assert.equal((await opencode.openThread({ sessionId: 'not a session id', cwd: '/tmp/demo' })).ok, false)
})

test('opencode starts a new session through the new-session link', async () => {
  const opened = await opencode.newSession('/tmp/demo')
  assert.equal(opened.ok, true)
  assert.equal(schemeOf(opened.url), 'opencode')
  const url = new URL(opened.url)
  assert.equal(url.hostname, 'new-session')
  assert.equal(url.searchParams.get('directory'), '/tmp/demo')
  assert.equal((await opencode.newSession('relative/path')).ok, false)
})

// ── OpenCode, faked on disk ───────────────────────────────────────────────────

async function fakeOpencode(sessions, withParts = true) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'opencode-fixture-'))
  const file = path.join(dir, 'opencode.db')
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(file)
  db.exec(
    `CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT,
      directory TEXT NOT NULL, title TEXT NOT NULL, time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL, time_archived INTEGER, model TEXT)`
  )
  const ins = db.prepare(
    `INSERT INTO session (id, project_id, parent_id, directory, title,
      time_created, time_updated, time_archived, model) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  for (const s of sessions) ins.run(...s)
  if (withParts) {
    db.exec(
      `CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL,
        session_id TEXT NOT NULL, time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL, data TEXT NOT NULL)`
    )
    const pins = db.prepare(
      `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    pins.run('p1', 'm1', 'ses_main000000000000000001', 1, 1, '{"type":"text","text":"hello there"}')
  }
  db.close()
  return file
}

async function opencodeWith(dbFile) {
  process.env.BOT_CROSSING_OPENCODE_DB = dbFile
  const mod = await import(`../server/harnesses/opencode.mjs?${dbFile}`)
  return mod.default
}

test('opencode parses model JSON, reports archived, and hides subagent children', async () => {
  const now = Date.now()
  const dbFile = await fakeOpencode([
    ['ses_main000000000000000001', 'proj1', null, '/tmp/demo', 'Do the thing', now - 9000, now - 1000, null,
      '{"id":"anthropic/claude-opus-4-6","providerID":"opencode","variant":"default"}'],
    ['ses_kid00000000000000000002', 'proj1', 'ses_main000000000000000001', '/tmp/demo', 'Task child', now - 8000, now - 500, null, ''],
    ['ses_old00000000000000000003', 'proj1', null, '/tmp/demo', 'Old thread', now - 90000, now - 80000, now - 70000,
      '{malformed json'],
  ])
  try {
    const h = await opencodeWith(dbFile)
    assert.equal(await h.detect(), true)
    const threads = await h.scanThreads()
    const ids = threads.map((t) => t.id)
    assert.ok(ids.includes('opencode:ses_main000000000000000001'), 'ids are prefixed')
    assert.ok(!ids.some((id) => id.includes('kid')), 'a task child is not its own astronaut')
    const main = threads.find((t) => t.id === 'opencode:ses_main000000000000000001')
    assert.equal(main.model, 'anthropic/claude-opus-4-6', 'model JSON is parsed to its id')
    assert.equal(main.title, 'Do the thing')
    assert.equal(main.project, 'demo')
    assert.equal(main.projectPath, '/tmp/demo')
    assert.equal(main.cwd, '/tmp/demo')
    assert.deepEqual(main.ref, { sessionId: 'ses_main000000000000000001', cwd: '/tmp/demo' })
    assert.equal(main.canOpen, true)
    assert.ok(typeof main.sizeBytes === 'number' && main.sizeBytes > 0, 'part bytes size the building')
    const old = threads.find((t) => t.id === 'opencode:ses_old00000000000000000003')
    assert.equal(old.archived, true, 'archived in the harness reads as archived here')
    assert.equal(old.model, '', 'malformed model JSON degrades to empty, not a throw')
  } finally {
    delete process.env.BOT_CROSSING_OPENCODE_DB
    await fsp.rm(path.dirname(dbFile), { recursive: true, force: true })
  }
})

test('opencode scans without a part table rather than losing every thread', async () => {
  const now = Date.now()
  const dbFile = await fakeOpencode([
    ['ses_main000000000000000001', 'proj1', null, '/tmp/demo', 'Do the thing', now - 9000, now - 1000, null, 'gpt-5'],
  ], false)
  try {
    const h = await opencodeWith(dbFile)
    const [t] = await h.scanThreads()
    assert.equal(t.title, 'Do the thing')
    assert.equal(t.model, 'gpt-5', 'a plain model string passes through')
    assert.equal(t.sizeBytes, 0)
  } finally {
    delete process.env.BOT_CROSSING_OPENCODE_DB
    await fsp.rm(path.dirname(dbFile), { recursive: true, force: true })
  }
})

test('opencode reads the stable and dev databases, tagged per build', () => {
  const files = defaultDbFiles()
  assert.deepEqual(files.map((f) => path.basename(f)), ['opencode.db', 'opencode-dev.db'])
})

// ── OpenCode turn state, faked on disk ──────────────────────────────────────

const toolPart = (tool, status) => JSON.stringify({ type: 'tool', tool, state: { status, input: {} } })
const textPart = (text) => JSON.stringify({ type: 'text', text })
const userMsg = () => JSON.stringify({ role: 'user' })
const assistantMsg = () => JSON.stringify({ role: 'assistant', finish: 'stop' })

async function fakeOpencodeFull(sessions, { parts = [], messages = [] } = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'opencode-turn-'))
  const file = path.join(dir, 'opencode.db')
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(file)
  db.exec(
    `CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT,
      directory TEXT NOT NULL, title TEXT NOT NULL, time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL, time_archived INTEGER, model TEXT)`
  )
  const sins = db.prepare(
    `INSERT INTO session (id, project_id, parent_id, directory, title,
      time_created, time_updated, time_archived, model) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  for (const s of sessions) sins.run(...s)
  db.exec(
    `CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL,
      session_id TEXT NOT NULL, time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL, data TEXT NOT NULL)`
  )
  const pins = db.prepare(
    `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
  for (const p of parts) pins.run(...p)
  if (messages.length > 0) {
    db.exec(
      `CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
        time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)`
    )
    const mins = db.prepare(
      `INSERT INTO message (id, session_id, time_created, time_updated, data)
       VALUES (?, ?, ?, ?, ?)`
    )
    for (const m of messages) mins.run(...m)
  }
  db.close()
  return file
}

const sesRow = (id, tu, ta = null) => [id, 'proj1', null, '/tmp/demo', 'T', tu - 60000, tu, ta, '']

test('opencode reads a fresh pending tool call as thinking, and a frozen one as parked', async () => {
  const now = Date.now()
  const streaming = await fakeOpencodeFull([sesRow('ses_mid00000000000000000001', now - 10000)], {
    // Arguments still streaming in: created seconds ago, empty input.
    parts: [['p1', 'm1', 'ses_mid00000000000000000001', now - 10000, now - 5000, toolPart('bash', 'pending')]],
  })
  const parked = await fakeOpencodeFull([sesRow('ses_park0000000000000000001', now - 10000)], {
    // Same shape, but frozen for minutes with a fresh session: approval wait.
    parts: [['p1', 'm1', 'ses_park0000000000000000001', now - 300000, now - 240000, toolPart('edit', 'pending')]],
  })
  try {
    const [thinking] = await (await opencodeWith(streaming)).scanThreads()
    assert.equal(thinking.running, true, 'a part mid-stream is the model thinking')
    assert.equal(thinking.unread, false)
    delete process.env.BOT_CROSSING_OPENCODE_DB
    const [stuck] = await (await opencodeWith(parked)).scanThreads()
    assert.equal(stuck.unread, true, 'a call frozen past its grace wants you')
    assert.equal(stuck.running, false)
  } finally {
    delete process.env.BOT_CROSSING_OPENCODE_DB
    await fsp.rm(path.dirname(streaming), { recursive: true, force: true })
    await fsp.rm(path.dirname(parked), { recursive: true, force: true })
  }
})

test('opencode marks an unanswered question as waiting, and an answered one as settled', async () => {
  const now = Date.now()
  // A question never legitimately executes, so one frozen past its short
  // grace is awaiting an answer even though a younger one is still thinking.
  const open = await fakeOpencodeFull([sesRow('ses_ask00000000000000000001', now - 10000)], {
    parts: [['p1', 'm1', 'ses_ask00000000000000000001', now - 200000, now - 120000, toolPart('question', 'pending')]],
  })
  const shut = await fakeOpencodeFull([sesRow('ses_ask00000000000000000001', now - 10000)], {
    parts: [['p1', 'm1', 'ses_ask00000000000000000001', now - 20000, now - 10000, toolPart('question', 'completed')]],
  })
  try {
    const [waiting] = await (await opencodeWith(open)).scanThreads()
    assert.equal(waiting.unread, true)
    assert.equal(waiting.running, false)
    delete process.env.BOT_CROSSING_OPENCODE_DB
    const [settled] = await (await opencodeWith(shut)).scanThreads()
    assert.equal(settled.unread, false)
    assert.equal(settled.running, false)
  } finally {
    delete process.env.BOT_CROSSING_OPENCODE_DB
    await fsp.rm(path.dirname(open), { recursive: true, force: true })
    await fsp.rm(path.dirname(shut), { recursive: true, force: true })
  }
})

test('opencode gives long-running tools a longer grace before calling them parked', async () => {
  const now = Date.now()
  const slow = await fakeOpencodeFull([sesRow('ses_slow0000000000000000001', now - 10000)], {
    parts: [['p1', 'm1', 'ses_slow0000000000000000001', now - 700000, now - 600000, toolPart('bash', 'running')]],
  })
  const stuck = await fakeOpencodeFull([sesRow('ses_stuck000000000000000001', now - 10000)], {
    parts: [['p1', 'm1', 'ses_stuck000000000000000001', now - 1300000, now - 1200000, toolPart('bash', 'running')]],
  })
  try {
    const [working] = await (await opencodeWith(slow)).scanThreads()
    assert.equal(working.running, true, 'a 10-minute bash may still be executing')
    assert.equal(working.unread, false)
    delete process.env.BOT_CROSSING_OPENCODE_DB
    const [parked] = await (await opencodeWith(stuck)).scanThreads()
    assert.equal(parked.unread, true, 'a 20-minute-frozen bash is stuck or parked')
    assert.equal(parked.running, false)
  } finally {
    delete process.env.BOT_CROSSING_OPENCODE_DB
    await fsp.rm(path.dirname(slow), { recursive: true, force: true })
    await fsp.rm(path.dirname(stuck), { recursive: true, force: true })
  }
})

test('opencode marks a fresh running tool call as working', async () => {
  const now = Date.now()
  const dbFile = await fakeOpencodeFull([sesRow('ses_run00000000000000000001', now - 10000)], {
    parts: [['p1', 'm1', 'ses_run00000000000000000001', now - 20000, now - 10000, toolPart('bash', 'running')]],
  })
  try {
    const [t] = await (await opencodeWith(dbFile)).scanThreads()
    assert.equal(t.running, true)
    assert.equal(t.unread, false)
  } finally {
    delete process.env.BOT_CROSSING_OPENCODE_DB
    await fsp.rm(path.dirname(dbFile), { recursive: true, force: true })
  }
})

test('opencode does not resurrect fossil parts from dead servers', async () => {
  const now = Date.now()
  const old = now - 6 * 60 * 60 * 1000
  const dbFile = await fakeOpencodeFull([sesRow('ses_old00000000000000000001', old)], {
    parts: [
      ['p1', 'm1', 'ses_old00000000000000000001', old, old, toolPart('edit', 'running')],
      ['p2', 'm1', 'ses_old00000000000000000001', old, old, toolPart('bash', 'error')],
    ],
  })
  try {
    const [t] = await (await opencodeWith(dbFile)).scanThreads()
    assert.equal(t.running, false, 'a running part from hours ago is a crash fossil')
    assert.equal(t.unread, false)
    assert.equal(t.hasError, false, 'an old failure is history, not a slump')
  } finally {
    delete process.env.BOT_CROSSING_OPENCODE_DB
    await fsp.rm(path.dirname(dbFile), { recursive: true, force: true })
  }
})

test('opencode clears the error once newer work supersedes it', async () => {
  const now = Date.now()
  const dbFile = await fakeOpencodeFull([sesRow('ses_rec00000000000000000001', now - 10000)], {
    parts: [
      ['p1', 'm1', 'ses_rec00000000000000000001', now - 50000, now - 40000, toolPart('bash', 'error')],
      ['p2', 'm1', 'ses_rec00000000000000000001', now - 30000, now - 10000, toolPart('bash', 'running')],
    ],
  })
  try {
    const [t] = await (await opencodeWith(dbFile)).scanThreads()
    assert.equal(t.hasError, false, 'a turn that errored and kept working is thinking, not blocked')
    assert.equal(t.running, true)
  } finally {
    delete process.env.BOT_CROSSING_OPENCODE_DB
    await fsp.rm(path.dirname(dbFile), { recursive: true, force: true })
  }
})

test('opencode reads a settled turn ending in a question as waiting', async () => {
  const now = Date.now()
  const textRow = (id, ses, tu, text) => [id, 'm1', ses, tu - 1000, tu, JSON.stringify({ type: 'text', text })]
  const msgRow = (id, ses, tu, role) => [id, ses, tu - 1000, tu, JSON.stringify({ role })]
  const asked = await fakeOpencodeFull([sesRow('ses_q000000000000000000001', now - 10000)], {
    parts: [textRow('p1', 'ses_q000000000000000000001', now - 90000, 'Done. Would you like me to commit?')],
    messages: [msgRow('m1', 'ses_q000000000000000000001', now - 90000, 'assistant')],
  })
  const typing = await fakeOpencodeFull([sesRow('ses_q000000000000000000002', now - 10000)], {
    parts: [textRow('p1', 'ses_q000000000000000000002', now - 10000, 'Done. Would you like me to commi?')],
    messages: [msgRow('m1', 'ses_q000000000000000000002', now - 10000, 'assistant')],
  })
  const report = await fakeOpencodeFull([sesRow('ses_q000000000000000000003', now - 10000)], {
    parts: [textRow('p1', 'ses_q000000000000000000003', now - 90000, 'Done. Everything is committed.')],
    messages: [msgRow('m1', 'ses_q000000000000000000003', now - 90000, 'assistant')],
  })
  try {
    const [waiting] = await (await opencodeWith(asked)).scanThreads()
    assert.equal(waiting.unread, true, 'a settled turn ending in a question wants a decision')
    assert.equal(waiting.running, false)
    delete process.env.BOT_CROSSING_OPENCODE_DB
    const [mid] = await (await opencodeWith(typing)).scanThreads()
    assert.equal(mid.unread, false, 'text still being written is thinking, not asking')
    delete process.env.BOT_CROSSING_OPENCODE_DB
    const [idle] = await (await opencodeWith(report)).scanThreads()
    assert.equal(idle.unread, false, 'a report ending in a period is done')
    assert.equal(idle.running, false)
  } finally {
    delete process.env.BOT_CROSSING_OPENCODE_DB
    await fsp.rm(path.dirname(asked), { recursive: true, force: true })
    await fsp.rm(path.dirname(typing), { recursive: true, force: true })
    await fsp.rm(path.dirname(report), { recursive: true, force: true })
  }
})

test('opencode marks a fresh failure, and a fresh user message with no parts as working', async () => {
  const now = Date.now()
  const failed = await fakeOpencodeFull([sesRow('ses_err00000000000000000001', now - 10000)], {
    parts: [['p1', 'm1', 'ses_err00000000000000000001', now - 20000, now - 10000, toolPart('bash', 'error')]],
  })
  const prompted = await fakeOpencodeFull([sesRow('ses_new00000000000000000001', now - 10000)], {
    messages: [['m1', 'ses_new00000000000000000001', now - 20000, now - 10000, userMsg()]],
  })
  const done = await fakeOpencodeFull([sesRow('ses_done0000000000000000001', now - 10000)], {
    parts: [['p1', 'm1', 'ses_done0000000000000000001', now - 20000, now - 10000, textPart('all done')]],
    messages: [['m1', 'ses_done0000000000000000001', now - 20000, now - 10000, assistantMsg()]],
  })
  try {
    const [err] = await (await opencodeWith(failed)).scanThreads()
    assert.equal(err.hasError, true)
    delete process.env.BOT_CROSSING_OPENCODE_DB
    const [fresh] = await (await opencodeWith(prompted)).scanThreads()
    assert.equal(fresh.running, true, 'a fresh prompt with no parts yet is the agent’s turn')
    delete process.env.BOT_CROSSING_OPENCODE_DB
    const [idle] = await (await opencodeWith(done)).scanThreads()
    assert.equal(idle.running, false, 'a closed assistant turn with no open tools is idle')
    assert.equal(idle.unread, false)
  } finally {
    delete process.env.BOT_CROSSING_OPENCODE_DB
    await fsp.rm(path.dirname(failed), { recursive: true, force: true })
    await fsp.rm(path.dirname(prompted), { recursive: true, force: true })
    await fsp.rm(path.dirname(done), { recursive: true, force: true })
  }
})

test('threads from a dev database carry the dev source tag', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'opencode-dev-'))
  const { DatabaseSync } = await import('node:sqlite')
  for (const name of ['opencode.db', 'opencode-dev.db']) {
    const db = new DatabaseSync(path.join(dir, name))
    db.exec(
      `CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT,
        directory TEXT NOT NULL, title TEXT NOT NULL, time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL, time_archived INTEGER, model TEXT)`
    )
    db.prepare(
      `INSERT INTO session (id, project_id, parent_id, directory, title,
        time_created, time_updated, time_archived, model)
       VALUES ('ses_x', 'p', NULL, '/tmp/demo', 'T', 1, 2, NULL, '')`
    ).run()
    db.close()
  }
  try {
    const [prod] = await scanDbFile(path.join(dir, 'opencode.db'))
    const [dev] = await scanDbFile(path.join(dir, 'opencode-dev.db'))
    assert.equal(prod.source, 'db')
    assert.equal(dev.source, 'dev-db')
    assert.equal(prod.id, 'opencode:ses_x')
    assert.equal(dev.id, 'opencode:ses_x')
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('Cursor offers a folder link but never a per-thread one it cannot honour', async () => {
  const home = await fakeCursor('tmp', [askedFor('<user_query>hi</user_query>')])
  const h = await cursorWith(home)
  assert.equal(h.openThread({ sessionId: SESSION_ID }).ok, false)
  const opened = h.newSession('/tmp/some repo')
  assert.equal(opened.ok, true)
  assert.equal(schemeOf(opened.url), 'cursor')
  assert.ok(opened.url.includes('%20'), 'a space in the path is escaped, not left raw')
  assert.equal(h.newSession('relative/path').ok, false)
  await fsp.rm(home, { recursive: true, force: true })
})
