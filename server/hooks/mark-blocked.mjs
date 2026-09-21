#!/usr/bin/env node
/**
 * A Claude Code hook, installed by the user in their own `~/.claude/settings.json` — see
 * `server/hooks/README.md`. Not run by Bot Crossing itself, and not wired into anything under
 * `server/` automatically: this file only exists to be pointed at from hook config.
 *
 * Drops or removes a marker file under `~/.bot-crossing/blocked/<sessionId>.json` so the Claude
 * Code adapter (`server/harnesses/claude-code.mjs`) can tell, from outside the running CLI
 * process, that a session is sitting at a permission prompt right now. Reads the hook's JSON
 * payload from stdin; which it does is picked by the `mode` argument, so one file covers both
 * the `Notification` hook that raises the flag and the hooks that lower it again.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

const BLOCKED_DIR = path.join(os.homedir(), '.bot-crossing', 'blocked')
const mode = process.argv[2]

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

async function main() {
  let payload
  try {
    payload = JSON.parse(await readStdin())
  } catch {
    return // Nothing parseable — nothing to mark or clear.
  }
  const sessionId = payload.session_id
  if (!sessionId) return
  const file = path.join(BLOCKED_DIR, `${sessionId}.json`)

  if (mode === 'set') {
    await fsp.mkdir(BLOCKED_DIR, { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    await fsp.writeFile(tmp, JSON.stringify({ sessionId, at: Date.now() }))
    await fsp.rename(tmp, file)
  } else {
    await fsp.rm(file, { force: true })
  }
}

main().catch(() => {}) // A hook that throws must not be what breaks your session's turn.
