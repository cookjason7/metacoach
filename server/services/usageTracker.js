/**
 * usageTracker.js — append-only usage/cost event recorder.
 *
 * SAFETY RULES:
 *  - Never throws. All errors are logged internally and swallowed.
 *  - Never stores raw prompts, lab text, message bodies, or sensitive health data.
 *  - Fire-and-forget: callers do NOT await unless they want the event ID back.
 */

import { pool } from '../db.js'

// ── Default rate table ────────────────────────────────────────────────────────
// USD costs per 1M tokens (Anthropic) or per MB (Cloudinary).
// Overridden by usage_cost_rates rows fetched from DB every 5 minutes.
const FALLBACK_RATES = {
  // Claude models — input / output per 1M tokens
  'claude-sonnet-4-6:input_per_1m':           3.00,
  'claude-sonnet-4-6:output_per_1m':         15.00,
  'claude-3-5-sonnet-20241022:input_per_1m':  3.00,
  'claude-3-5-sonnet-20241022:output_per_1m':15.00,
  'claude-haiku-4-5-20251001:input_per_1m':   0.80,
  'claude-haiku-4-5-20251001:output_per_1m':  4.00,
  'claude-3-haiku-20240307:input_per_1m':     0.25,
  'claude-3-haiku-20240307:output_per_1m':    1.25,
  'claude-3-5-haiku-20241022:input_per_1m':   0.80,
  'claude-3-5-haiku-20241022:output_per_1m':  4.00,
  // Cloudinary — per MB of data uploaded
  'cloudinary:image_upload_per_mb':          0.00025,
}

let _cachedRates = null
let _cacheExpiry = 0

async function loadRates() {
  if (_cachedRates && Date.now() < _cacheExpiry) return _cachedRates
  try {
    const { rows } = await pool.query(
      'SELECT rate_key, rate_usd FROM usage_cost_rates WHERE active = TRUE',
    )
    const map = { ...FALLBACK_RATES }
    for (const r of rows) map[r.rate_key] = Number(r.rate_usd)
    _cachedRates = map
    _cacheExpiry = Date.now() + 5 * 60_000
  } catch {
    // DB not ready yet (e.g. local dev without DB) — use hardcoded fallback
    _cachedRates = { ...FALLBACK_RATES }
    _cacheExpiry = Date.now() + 60_000
  }
  return _cachedRates
}

function estimateAiCost(model, inputTokens, outputTokens, rates) {
  if (!model || inputTokens == null) return null
  const inRate  = rates[`${model}:input_per_1m`]
  const outRate = rates[`${model}:output_per_1m`]
  if (!inRate) return null
  const cost = (inputTokens  / 1_000_000) * inRate
             + (outputTokens / 1_000_000) * (outRate ?? inRate * 4)
  return round8(cost)
}

function estimateUploadCost(bytes, rates) {
  if (!bytes) return null
  const mb   = bytes / (1024 * 1024)
  const rate = rates['cloudinary:image_upload_per_mb'] ?? 0.00025
  return round8(mb * rate)
}

function round8(n) {
  return Math.round(n * 100_000_000) / 100_000_000
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Track a usage event.  Never throws.
 *
 * @param {object} event
 * @param {number}   event.actorUserId      DB user id of who triggered the action
 * @param {number}  [event.targetUserId]    DB user id of affected client (may differ from actor for staff actions)
 * @param {string}   event.feature          e.g. 'katie_chat' | 'meal_photo' | 'bloodwork_summary' | ...
 * @param {string}   event.action           'ai_call' | 'upload' | 'email' | 'backup' | 'sync'
 * @param {string}  [event.provider]        'anthropic' | 'cloudinary' | 'sendgrid' | ...
 * @param {string}  [event.providerOp]      e.g. 'messages.create' | 'messages.stream'
 * @param {string}  [event.model]           Anthropic model string
 * @param {number}  [event.inputTokens]
 * @param {number}  [event.outputTokens]
 * @param {number}  [event.fileCount]
 * @param {number}  [event.bytesIn]         Raw byte count for upload events
 * @param {string}  [event.status]          'success' | 'error' | 'timeout'
 * @param {number}  [event.durationMs]
 * @param {object}  [event.metadata]        Safe non-PII extra data (model version, file type, etc.)
 */
export async function trackEvent(event) {
  try {
    const rates = await loadRates()

    let estimatedCost    = null
    let unitCostSnapshot = null

    if (event.action === 'ai_call' && event.model) {
      estimatedCost    = estimateAiCost(event.model, event.inputTokens ?? 0, event.outputTokens ?? 0, rates)
      unitCostSnapshot = {
        input_per_1m:  rates[`${event.model}:input_per_1m`]  ?? null,
        output_per_1m: rates[`${event.model}:output_per_1m`] ?? null,
      }
    } else if (event.action === 'upload' && event.bytesIn) {
      estimatedCost    = estimateUploadCost(event.bytesIn, rates)
      unitCostSnapshot = { per_mb: rates['cloudinary:image_upload_per_mb'] ?? null }
    }

    await pool.query(
      `INSERT INTO usage_events (
         actor_user_id, target_user_id, feature, action, provider, provider_operation,
         model, input_tokens, output_tokens, file_count, bytes_in,
         estimated_cost_usd, unit_cost_snapshot, status, duration_ms, metadata
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [
        event.actorUserId   ?? null,
        event.targetUserId  ?? null,
        event.feature,
        event.action,
        event.provider      ?? null,
        event.providerOp    ?? null,
        event.model         ?? null,
        event.inputTokens   ?? null,
        event.outputTokens  ?? null,
        event.fileCount     ?? null,
        event.bytesIn       ?? null,
        estimatedCost,
        unitCostSnapshot ? JSON.stringify(unitCostSnapshot) : null,
        event.status        ?? 'success',
        event.durationMs    ?? null,
        event.metadata      ? JSON.stringify(event.metadata) : null,
      ],
    )
  } catch (err) {
    console.error('[usage-tracker] failed to record event:', err.message)
  }
}

/**
 * Convenience wrapper: times an async fn, tracks success/error.
 * Rethrows so the caller still gets the original error.
 */
export async function trackTimed(eventBase, fn) {
  const start = Date.now()
  try {
    const result = await fn()
    // Track non-blocking after fn resolves
    trackEvent({ ...eventBase, status: 'success', durationMs: Date.now() - start })
    return result
  } catch (err) {
    trackEvent({
      ...eventBase,
      status:     'error',
      durationMs: Date.now() - start,
      metadata:   { ...(eventBase.metadata ?? {}), error: err.message },
    })
    throw err
  }
}
