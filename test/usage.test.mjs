/**
 * Usage estimation: the token-to-dollar math and the burn-rate ratio. Both are pure, and both
 * are exactly the kind of thing worth pinning down with a test rather than eyeballing colors
 * and numbers in the browser.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { estimateCost } from '../server/usage.mjs'
import { burnRatio, paceColor } from '../src/world/usageCanister.js'

// ── estimateCost ──────────────────────────────────────────────────────────────

test('a turn with no usage costs nothing', () => {
  assert.equal(estimateCost(null, 'claude-sonnet-5'), 0)
  assert.equal(estimateCost(undefined, 'claude-sonnet-5'), 0)
})

test('input and output tokens price at the model’s own list rate', () => {
  const usd = estimateCost({ input_tokens: 1_000_000, output_tokens: 1_000_000 }, 'claude-sonnet-5')
  assert.equal(usd, 2 + 10) // sonnet: $2/MTok in, $10/MTok out
})

test('an unrecognized model prices as sonnet, the middle tier', () => {
  const known = estimateCost({ input_tokens: 1_000_000 }, 'claude-sonnet-5')
  const unknown = estimateCost({ input_tokens: 1_000_000 }, 'claude-something-future')
  assert.equal(unknown, known)
})

test('opus and haiku price differently from sonnet and from each other', () => {
  const usage = { input_tokens: 1_000_000 }
  const opus = estimateCost(usage, 'claude-opus-5')
  const sonnet = estimateCost(usage, 'claude-sonnet-5')
  const haiku = estimateCost(usage, 'claude-haiku-4-5')
  assert.ok(opus > sonnet && sonnet > haiku)
})

test('cache reads are cheaper than a fresh input token', () => {
  const fresh = estimateCost({ input_tokens: 1_000_000 }, 'claude-sonnet-5')
  const cached = estimateCost({ cache_read_input_tokens: 1_000_000 }, 'claude-sonnet-5')
  assert.ok(cached < fresh)
})

test('a cache-write breakdown splits by TTL; a flat total without one is priced as the cheaper 5-minute tier', () => {
  const withBreakdown = estimateCost(
    { cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1_000_000 } },
    'claude-sonnet-5'
  )
  const flatTotal = estimateCost({ cache_creation_input_tokens: 1_000_000 }, 'claude-sonnet-5')
  assert.ok(flatTotal < withBreakdown)
})

// ── burnRatio ─────────────────────────────────────────────────────────────────

test('spending exactly in step with the calendar is a ratio of 1', () => {
  // Day 10 of a 30-day month, budget $300 → $10/day pace, $100 spent by day 10 is on the nose.
  const now = new Date(2026, 3, 10) // April 2026 has 30 days
  assert.equal(burnRatio(100, 300, now), 1)
})

test('spending twice the calendar pace is a ratio of 2', () => {
  const now = new Date(2026, 3, 10)
  assert.equal(burnRatio(200, 300, now), 2)
})

test('a zero or missing budget never divides by zero', () => {
  assert.equal(burnRatio(50, 0), 1)
  assert.equal(burnRatio(50, undefined), 1)
})

// ── paceColor (shared traffic light for the goo and the flag) ──────────────────

test('comfortably under pace is green, near pace is amber, over pace is red', () => {
  assert.equal(paceColor(0.5), 0x4caf6a)
  assert.equal(paceColor(1), 0xd9b23c)
  assert.equal(paceColor(1.5), 0xd6543f)
})

test('the green/amber and amber/red boundaries land where documented', () => {
  assert.equal(paceColor(0.84), 0x4caf6a)
  assert.equal(paceColor(0.85), 0xd9b23c)
  assert.equal(paceColor(1.15), 0xd9b23c)
  assert.equal(paceColor(1.16), 0xd6543f)
})
