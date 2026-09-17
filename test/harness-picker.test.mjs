/**
 * The New-conversation harness picker: enabled harnesses first, the rest after,
 * each section alphabetical — so the menu reads the same on every machine.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { sortHarnessChoices, harnessReason } from '../src/game/harnesses.js'
import { fetchHarnesses } from '../src/game/api.js'

test('enabled harnesses come first, each section alphabetical', () => {
  const out = sortHarnessChoices([
    { id: 'opencode', name: 'OpenCode', detected: false },
    { id: 'cursor', name: 'Cursor', detected: false },
    { id: 'codex', name: 'Codex', detected: true },
    { id: 'claude-code', name: 'Claude Code', detected: true },
  ])
  assert.deepEqual(
    out.map((h) => h.id),
    ['claude-code', 'codex', 'cursor', 'opencode']
  )
})

test('a disabled harness without a diagnostic still gets a reason', () => {
  assert.equal(harnessReason({ id: 'x', name: 'X', detected: true }), '')
  assert.match(harnessReason({ id: 'x', name: 'X', detected: false, error: 'needs Node 22' }), /Node 22/)
  assert.equal(harnessReason({ id: 'x', name: 'X', detected: false }), 'Not installed on this machine')
})

test('garbage into the sorter comes back as an empty menu, not a throw', () => {
  assert.deepEqual(sortHarnessChoices(null), [])
  assert.deepEqual(sortHarnessChoices({ harnesses: [] }), [])
})

test('fetchHarnesses unwraps the { harnesses } envelope to the array', async () => {
  const realFetch = globalThis.fetch
  const rows = [{ id: 'opencode', name: 'OpenCode', detected: true }]
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ harnesses: rows }) })
  try {
    assert.deepEqual(await fetchHarnesses(), rows)
  } finally {
    globalThis.fetch = realFetch
  }
})
