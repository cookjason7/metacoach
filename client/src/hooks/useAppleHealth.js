/**
 * Apple Health hook — permission request + data read (steps & sleep).
 * No server calls here. Raw data is returned to the caller.
 *
 * Static import so the plugin is always bundled into the main chunk and never
 * split into a separate file that would fail to load via a remote server.url.
 */
import { Capacitor } from '@capacitor/core'
import { Health } from '@capgo/capacitor-health'

// ─── date helpers ────────────────────────────────────────────────────────────

function todayStart() {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.toISOString()
}

function tomorrowStart() {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() + 1)
  return d.toISOString()
}

function yesterdayStart() {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - 1)
  return d.toISOString()
}

// ─── sleep helpers ────────────────────────────────────────────────────────────

// States that count as actual sleep (not just time in bed or awake)
const ASLEEP_STATES = new Set(['asleep', 'rem', 'deep', 'light'])

function sleepMinutesFromSamples(samples) {
  return Math.round(
    samples
      .filter(s => ASLEEP_STATES.has(s.sleepState))
      .reduce((total, s) => {
        const mins = (new Date(s.endDate) - new Date(s.startDate)) / 60_000
        return total + (mins > 0 ? mins : 0)
      }, 0)
  )
}

// ─── exports ─────────────────────────────────────────────────────────────────

/**
 * Request Apple Health read permissions for steps and sleep.
 * Safe on any platform — returns { available: false } on web/Android.
 *
 * @returns {{ available: boolean, authorized: boolean, error?: string }}
 */
export async function requestAppleHealthPermissions() {
  const platform = Capacitor.getPlatform()
  console.log('[AppleHealth] requestPermissions — platform:', platform)

  if (platform !== 'ios') {
    console.log('[AppleHealth] Not iOS — skipping (platform is', platform, ')')
    return { available: false, authorized: false }
  }

  console.log('[AppleHealth] Health plugin type:', typeof Health)
  console.log('[AppleHealth] isAvailable type:', typeof Health?.isAvailable)

  try {
    console.log('[AppleHealth] calling isAvailable()…')
    const availResult = await Health.isAvailable()
    console.log('[AppleHealth] isAvailable result:', JSON.stringify(availResult))

    if (!availResult.available) {
      console.warn('[AppleHealth] HealthKit unavailable:', availResult.reason)
      return { available: false, authorized: false }
    }

    const authPayload = { read: ['steps', 'sleep'], write: [] }
    console.log('[AppleHealth] calling requestAuthorization:', JSON.stringify(authPayload))
    const authResult = await Health.requestAuthorization(authPayload)
    console.log('[AppleHealth] requestAuthorization result:', JSON.stringify(authResult))

    return { available: true, authorized: true }
  } catch (err) {
    const message = err?.message ?? String(err)
    console.error('[AppleHealth] Permission error:', message, err)
    return { available: true, authorized: false, error: message }
  }
}

/**
 * Read today's steps and last night's sleep from Apple Health.
 * Call only after requestAppleHealthPermissions() has returned authorized: true.
 *
 * @returns {{
 *   steps: number | null,
 *   sleepMinutes: number | null,
 *   rawSteps: object | null,
 *   rawSleep: object[] | null,
 *   error?: string
 * }}
 */
export async function readAppleHealthToday() {
  const platform = Capacitor.getPlatform()
  console.log('[AppleHealth] readToday — platform:', platform)

  if (platform !== 'ios') {
    return { steps: null, sleepMinutes: null, rawSteps: null, rawSleep: null }
  }

  const results = { steps: null, sleepMinutes: null, rawSteps: null, rawSleep: null }

  // ── Steps (today, aggregated sum) ──────────────────────────────────────────
  try {
    const stepsQuery = {
      dataType:    'steps',
      startDate:   todayStart(),
      endDate:     tomorrowStart(),
      bucket:      'day',
      aggregation: 'sum',
    }
    console.log('[AppleHealth] queryAggregated steps:', JSON.stringify(stepsQuery))
    const stepsResult = await Health.queryAggregated(stepsQuery)
    console.log('[AppleHealth] steps raw result:', JSON.stringify(stepsResult))

    results.rawSteps = stepsResult
    const sample = stepsResult?.samples?.[0]
    results.steps = sample?.value != null ? Math.round(sample.value) : null
    console.log('[AppleHealth] steps today:', results.steps)
  } catch (err) {
    console.error('[AppleHealth] steps read error:', err?.message ?? err)
    results.error = `Steps: ${err?.message ?? err}`
  }

  // ── Sleep (yesterday midnight → now, raw samples) ──────────────────────────
  try {
    const sleepQuery = {
      dataType:  'sleep',
      startDate: yesterdayStart(),
      endDate:   tomorrowStart(),
      limit:     100,
      ascending: false,
    }
    console.log('[AppleHealth] readSamples sleep:', JSON.stringify(sleepQuery))
    const sleepResult = await Health.readSamples(sleepQuery)
    console.log('[AppleHealth] sleep raw result:', JSON.stringify(sleepResult))

    results.rawSleep = sleepResult?.samples ?? []
    results.sleepMinutes = sleepMinutesFromSamples(results.rawSleep)
    console.log('[AppleHealth] sleep minutes (actual sleep states):', results.sleepMinutes)
    console.log('[AppleHealth] sleep sample states seen:', [...new Set(results.rawSleep.map(s => s.sleepState))])
  } catch (err) {
    console.error('[AppleHealth] sleep read error:', err?.message ?? err)
    results.error = (results.error ? results.error + ' | ' : '') + `Sleep: ${err?.message ?? err}`
  }

  return results
}
