import { Capacitor } from '@capacitor/core'

// Lazily imported so the module never loads on web or Android
let Health = null

async function getHealth() {
  if (!Health) {
    const mod = await import('@capgo/capacitor-health')
    Health = mod.Health
  }
  return Health
}

/**
 * Request Apple Health read permissions for steps and sleep.
 *
 * Safe to call on any platform — returns { available: false } immediately
 * on web/Android. No data is read or synced; this is a permissions gate only.
 *
 * @returns {{ available: boolean, authorized: boolean, error?: string }}
 */
export async function requestAppleHealthPermissions() {
  if (Capacitor.getPlatform() !== 'ios') {
    return { available: false, authorized: false }
  }

  try {
    const health = await getHealth()
    const { available } = await health.isAvailable()
    if (!available) {
      console.log('[AppleHealth] HealthKit not available on this device')
      return { available: false, authorized: false }
    }

    await health.requestAuthorization({
      read: ['steps', 'sleep'],
      write: [],
    })
    console.log('[AppleHealth] Authorization request completed')
    return { available: true, authorized: true }
  } catch (err) {
    console.error('[AppleHealth] Permission request failed:', err?.message ?? err)
    return { available: true, authorized: false, error: err?.message }
  }
}
