/**
 * Dollar-cost estimation from a transcript's own token counts.
 *
 * There is no billing API here — this multiplies published list pricing by the token counts
 * each assistant turn already carries in its `usage` block, the same way a tool like `ccusage`
 * does. It is an **estimate**: it will not reflect batch pricing, promotional discounts, price
 * changes since this table was last updated, or anything billed outside per-token usage. Good
 * enough to drive a budget gauge; do not point it at anything that has to reconcile to a bill.
 */

/**
 * $ per million tokens, current as of September 2026. Cache write splits by TTL because the
 * two cost differently to write; both tiers and the cache-read discount follow Anthropic's
 * usual multipliers on the model's own base input rate — 1.25x for a 5-minute write, 2x for
 * an hour-long one, 0.1x to read a hit — which is what the per-model figures below apply.
 */
const PRICING = {
  opus: { input: 5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5 },
  sonnet: { input: 2, output: 10, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.2 },
  haiku: { input: 1, output: 5, cacheWrite5m: 1.25, cacheWrite1h: 2, cacheRead: 0.1 },
}

/** Substring match on the model id, e.g. `claude-sonnet-5`, `claude-3-5-haiku-20241022`. An
 *  unrecognized model — a future release this table has not been updated for — is priced as
 *  Sonnet: the middle tier, so a new Opus is undercounted and a new Haiku overcounted rather
 *  than either one being wrong by the full spread. */
function pricingFor(model) {
  const m = (model || '').toLowerCase()
  if (m.includes('opus')) return PRICING.opus
  if (m.includes('haiku')) return PRICING.haiku
  return PRICING.sonnet
}

/**
 * Dollar estimate for one assistant turn's `usage` block.
 *
 * Cache writes come as a breakdown (`cache_creation.ephemeral_5m_input_tokens` /
 * `..._1h_input_tokens`) on current transcripts. An older record that only has the flat
 * `cache_creation_input_tokens` total is priced as if it were all 5-minute-TTL — the cheaper
 * of the two tiers, and the one the API defaults to when a call does not ask for the hour-long
 * one — rather than guessing a split that cannot be recovered from the number alone.
 */
export function estimateCost(usage, model) {
  if (!usage) return 0
  const p = pricingFor(model)
  const cache = usage.cache_creation || {}
  const hasBreakdown = 'ephemeral_5m_input_tokens' in cache || 'ephemeral_1h_input_tokens' in cache
  const write5m = hasBreakdown ? cache.ephemeral_5m_input_tokens || 0 : usage.cache_creation_input_tokens || 0
  const write1h = hasBreakdown ? cache.ephemeral_1h_input_tokens || 0 : 0
  const input = usage.input_tokens || 0
  const output = usage.output_tokens || 0
  const cacheRead = usage.cache_read_input_tokens || 0

  return (
    (input * p.input +
      output * p.output +
      write5m * p.cacheWrite5m +
      write1h * p.cacheWrite1h +
      cacheRead * p.cacheRead) /
    1e6
  )
}
