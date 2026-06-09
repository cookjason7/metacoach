/**
 * Apple Health hook — permission, data read, and sync to the server.
 *
 * Static top-level import keeps the plugin in the main bundle so it never
 * needs a separate network request (avoids failures when server.url loads
 * a remote host that doesn't serve split chunks).
 */
import { Capacitor } from '@capacitor/core'
import { Health } from '@capgo/capacitor-health'
import { API_URL } from '../config.js'

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

// States that count as actual sleep (excludes inBed and awake)
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
 * Call only after permissions have been granted.
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

  // ── Sleep (yesterday midnight → tomorrow, raw samples) ────────────────────
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

    // 0 minutes with samples present means samples exist but are all inBed/awake
    // Treat that the same as no data for UI purposes
    if (results.sleepMinutes === 0) results.sleepMinutes = null

    console.log('[AppleHealth] sleep minutes (actual sleep states):', results.sleepMinutes)
    console.log('[AppleHealth] sleep sample states seen:',
      [...new Set(results.rawSleep.map(s => s.sleepState))])
  } catch (err) {
    console.error('[AppleHealth] sleep read error:', err?.message ?? err)
    results.error = (results.error ? results.error + ' | ' : '') + `Sleep: ${err?.message ?? err}`
  }

  return results
}

/**
 * Read today's Apple Health data and POST it to the server.
 * The server performs a source-protected UPSERT into daily_logs so manual
 * entries are never overwritten.
 *
 * Fires a 'daily-log-updated' window event so the Dashboard refreshes
 * without a page reload.
 *
 * @param {string} token  Clerk auth token from getToken()
 * @returns {{
 *   steps: number | null,
 *   sleepMinutes: number | null,
 *   savedSteps: number | null,
 *   savedSleep: number | null,
 *   stepsSource: string | null,
 *   sleepSource: string | null,
 *   syncedAt: string,
 *   error?: string
 * }}
 */
export async function syncAppleHealthToday(token) {
  console.log('[AppleHealth] syncToday — reading device data…')

  // 1. Read from device
  const healthData = await readAppleHealthToday()
  console.log('[AppleHealth] syncToday — device data:', JSON.stringify(healthData))

  if (Capacitor.getPlatform() !== 'ios') {
    return {
      steps: null, sleepMinutes: null,
      savedSteps: null, savedSleep: null,
      stepsSource: null, sleepSource: null,
      syncedAt: new Date().toISOString(),
    }
  }

  // 2. POST to server
  const payload = {
    steps:         healthData.steps         ?? null,
    sleep_minutes: healthData.sleepMinutes  ?? null,
  }
  console.log('[AppleHealth] syncToday — posting to server:', JSON.stringify(payload))

  try {
    const res = await fetch(`${API_URL}/api/apple-health/sync`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    })

    const serverData = await res.json()
    console.log('[AppleHealth] syncToday — server response:', JSON.stringify(serverData))

    if (!res.ok) {
      throw new Error(serverData?.error ?? `HTTP ${res.status}`)
    }

    // 3. Notify Dashboard to refresh its today log
    window.dispatchEvent(new CustomEvent('daily-log-updated', {
      detail: {
        steps:         serverData.steps,
        sleep_minutes: serverData.sleep_minutes,
      },
    }))

    return {
      steps:        healthData.steps,
      sleepMinutes: healthData.sleepMinutes,
      savedSteps:   serverData.steps,
      savedSleep:   serverData.sleep_minutes,
      stepsSource:  serverData.steps_source,
      sleepSource:  serverData.sleep_source,
      syncedAt:     serverData.synced_at,
    }
  } catch (err) {
    const message = err?.message ?? String(err)
    console.error('[AppleHealth] syncToday — server error:', message)
    return {
      steps:        healthData.steps,
      sleepMinutes: healthData.sleepMinutes,
      savedSteps:   null,
      savedSleep:   null,
      stepsSource:  null,
      sleepSource:  null,
      syncedAt:     new Date().toISOString(),
      error:        message,
    }
  }
}
