/**
 * Apple Health permission hook — availability check + authorization request only.
 * No data is read or written. No server calls are made.
 *
 * Uses a static top-level import so the plugin module is bundled into the main
 * chunk and never loaded via a separate network request (avoids failures when
 * server.url is set to a remote host that doesn't serve the split chunk).
 */
import { Capacitor } from '@capacitor/core'
import { Health } from '@capgo/capacitor-health'

/**
 * Request Apple Health read permissions for steps and sleep.
 *
 * Safe to call on any platform — returns { available: false } immediately on
 * web and Android without touching the HealthKit API.
 *
 * @returns {{ available: boolean, authorized: boolean, error?: string }}
 */
export async function requestAppleHealthPermissions() {
  const platform = Capacitor.getPlatform()
  console.log('[AppleHealth] requestAppleHealthPermissions called — platform:', platform)

  if (platform !== 'ios') {
    console.log('[AppleHealth] Not iOS — skipping HealthKit (platform is', platform, ')')
    return { available: false, authorized: false }
  }

  // Verify the plugin object is present before calling it
  console.log('[AppleHealth] Health plugin object type:', typeof Health)
  console.log('[AppleHealth] Health.isAvailable type:', typeof Health?.isAvailable)

  try {
    // Step 1 — check hardware/OS support
    console.log('[AppleHealth] calling Health.isAvailable()…')
    const availResult = await Health.isAvailable()
    console.log('[AppleHealth] isAvailable result:', JSON.stringify(availResult))

    if (!availResult.available) {
      console.warn('[AppleHealth] HealthKit not available on this device:', availResult.reason ?? 'no reason given')
      return { available: false, authorized: false }
    }

    // Step 2 — request authorization
    const authPayload = { read: ['steps', 'sleep'], write: [] }
    console.log('[AppleHealth] calling Health.requestAuthorization with payload:', JSON.stringify(authPayload))

    const authResult = await Health.requestAuthorization(authPayload)
    console.log('[AppleHealth] requestAuthorization result:', JSON.stringify(authResult))

    return { available: true, authorized: true }
  } catch (err) {
    const message = err?.message ?? String(err)
    console.error('[AppleHealth] Error during permission request:', message)
    console.error('[AppleHealth] Full error object:', err)
    return { available: true, authorized: false, error: message }
  }
}
