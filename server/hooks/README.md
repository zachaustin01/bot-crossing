# The "blocked" flag: seeing a permission prompt from outside the session

Nothing in a Claude Code transcript or in the desktop app's own session record says "this
session is sitting at a permission prompt right now" — the transcript looks identical whether a
tool is executing or stalled waiting for you to approve it. So this one signal, unlike everything
else the Claude Code adapter reads, is opt-in: it comes from a
[hook](https://code.claude.com/docs/en/hooks) you add to your own Claude Code settings, not from
anything Bot Crossing reads by default.

Add this to `~/.claude/settings.json` (global, so it covers every project) or a project's own
`.claude/settings.json`:

```json
{
  "hooks": {
    "Notification": [
      {
        "matcher": "permission_prompt",
        "hooks": [{ "type": "command", "command": "node /absolute/path/to/bot-crossing/server/hooks/mark-blocked.mjs set" }]
      }
    ],
    "PreToolUse": [
      {
        "hooks": [{ "type": "command", "command": "node /absolute/path/to/bot-crossing/server/hooks/mark-blocked.mjs clear" }]
      }
    ],
    "PermissionDenied": [
      {
        "hooks": [{ "type": "command", "command": "node /absolute/path/to/bot-crossing/server/hooks/mark-blocked.mjs clear" }]
      }
    ],
    "Stop": [
      {
        "hooks": [{ "type": "command", "command": "node /absolute/path/to/bot-crossing/server/hooks/mark-blocked.mjs clear" }]
      }
    ]
  }
}
```

Replace `/absolute/path/to/bot-crossing` with wherever you checked this repo out.

## How the four hooks fit together

- **`Notification` / `permission_prompt`** fires once the prompt is actually on screen — this is
  the only place the flag gets *set*. It writes `~/.bot-crossing/blocked/<sessionId>.json`.
- **`PreToolUse`** fires right before a tool call proceeds, whether that is because you just
  approved it or because it never needed asking — either way the prompt (if there was one) is
  gone, so this clears the marker.
- **`PermissionDenied`** fires when the call is turned down instead of approved. Also clears it.
- **`Stop`** is the safety net: if a session ends or you close the terminal with a marker still
  on disk, this cleans it up rather than leaving a phantom "blocked" astronaut behind.

The marker also expires on its own after an hour (`BLOCKED_MARKER_MAX_AGE_MS` in
`server/harnesses/claude-code.mjs`), in case a session is killed hard enough that none of its
hooks get to run.

## Why `~/.bot-crossing/`, not `~/.claude/`

Bot Crossing's harness adapters are read-only against every agent's own files — see "There is no
`setArchived`" in `server/harnesses/README.md`. The marker directory is Bot Crossing's own, kept
deliberately outside `~/.claude` so that promise stays true even though the *hook* that fills it
is configured inside Claude Code's own settings.
