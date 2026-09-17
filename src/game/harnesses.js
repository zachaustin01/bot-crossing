/**
 * Sort and labelling for the New-conversation harness picker.
 *
 * Pure and DOM-free on purpose, so `node --test` can pin the ordering: enabled
 * harnesses first, the rest after, each section alphabetical by display name.
 * What the picker shows for a row comes from `GET /api/harnesses` — `{ id,
 * name, detected, error }` — and this module only arranges it.
 */

const displayName = (h) => String(h?.name || h?.id || '').toLowerCase()

export function sortHarnessChoices(status) {
  if (!Array.isArray(status)) return []
  return [...status].sort((a, b) => {
    const enabled = (b?.detected ? 1 : 0) - (a?.detected ? 1 : 0)
    if (enabled !== 0) return enabled
    const an = displayName(a)
    const bn = displayName(b)
    return an < bn ? -1 : an > bn ? 1 : 0
  })
}

/** Why a picker row is disabled — the server's diagnostic, or the plain truth. */
export function harnessReason(h) {
  if (h?.detected) return ''
  return h?.error || 'Not installed on this machine'
}
