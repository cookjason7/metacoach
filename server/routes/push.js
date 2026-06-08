import { Router } from 'express'
import { requireAuth, getAuth } from '@clerk/express'
import { getOrCreateUser } from '../db.js'
import { registerDevice, revokeDevice } from '../services/pushService.js'

const router = Router()

// TEMPORARY push-debug diagnostics — remove after Android push registration is confirmed working.
// In-memory ring buffer of the last 25 app-load-debug events. No tokens, emails, or names stored.
const appLoadEvents = []
const APP_LOAD_MAX = 25

// POST /api/push/app-load-debug — unauthenticated ping fired on every app mount.
// Proves whether the Android WebView is running the current production bundle at all.
router.post('/app-load-debug', (req, res) => {
  const { build, platform, isNative, href, userAgent } = req.body ?? {}
  const ua = userAgent ?? req.headers['user-agent'] ?? 'unknown'
  const event = {
    receivedAt: new Date().toISOString(),
    source:     'app-load-debug',
    build:      String(build    ?? 'unknown').slice(0, 32),
    platform:   String(platform ?? 'unknown').slice(0, 16),
    isNative:   String(isNative ?? 'unknown').slice(0, 8),
    href:       String(href     ?? 'unknown').slice(0, 128),
    userAgent:  ua.slice(0, 160),
    ip:         req.ip ?? 'unknown',
  }
  appLoadEvents.push(event)
  if (appLoadEvents.length > APP_LOAD_MAX) appLoadEvents.shift()
  console.error('[app-load-debug]', event)
  res.json({ ok: true, stored: true })
})

// GET /api/push/app-load-debug/recent — returns last 25 stored events.
// TEMPORARY: unauthenticated because it contains no tokens, emails, or names.
// Remove this route after Android push debugging is complete.
router.get('/app-load-debug/recent', (req, res) => {
  res.json({ ok: true, count: appLoadEvents.length, events: [...appLoadEvents].reverse() })
})

// POST /api/push/register — store a device token for the authenticated user
// Body: { token: string, platform?: 'android' | 'ios' | 'web' }
router.post('/register', requireAuth(), async (req, res, next) => {
  try {
    const { userId } = getAuth(req)
    const dbUserId = await getOrCreateUser(userId)
    const { token, platform = 'android' } = req.body

    if (!token || typeof token !== 'string' || token.trim().length === 0) {
      return res.status(400).json({ error: 'token is required' })
    }
    const validPlatforms = ['android', 'ios', 'web']
    if (!validPlatforms.includes(platform)) {
      return res.status(400).json({ error: `platform must be one of: ${validPlatforms.join(', ')}` })
    }

    const trimmedToken = token.trim()
    console.log('[push] register request', {
      userId: dbUserId,
      platform,
      tokenStart: trimmedToken.slice(0, 12),
      tokenLength: trimmedToken.length,
    })

    const device = await registerDevice(dbUserId, trimmedToken, platform)
    res.json({ ok: true, deviceId: device?.id, platform: device?.platform })
  } catch (err) { next(err) }
})

// POST /api/push/debug — client-side push diagnostic trace (no token logged)
// Body: { step: string, value?: string }
router.post('/debug', requireAuth(), async (req, res, next) => {
  try {
    const { userId } = getAuth(req)
    const dbUserId = await getOrCreateUser(userId)
    const { step, value } = req.body
    const safeStep  = String(step  ?? 'unknown').slice(0, 64)
    const safeValue = value !== undefined ? String(value).slice(0, 128) : undefined
    if (safeValue !== undefined) {
      console.log(`[push-debug] user=${dbUserId} step=${safeStep} value=${safeValue}`)
    } else {
      console.log(`[push-debug] user=${dbUserId} step=${safeStep}`)
    }
    res.status(204).end()
  } catch (err) { next(err) }
})

// POST /api/push/unregister — remove a device token for the authenticated user
// Body: { token: string }
router.post('/unregister', requireAuth(), async (req, res, next) => {
  try {
    const { userId } = getAuth(req)
    const dbUserId = await getOrCreateUser(userId)
    const { token } = req.body

    if (!token || typeof token !== 'string' || token.trim().length === 0) {
      return res.status(400).json({ error: 'token is required' })
    }

    await revokeDevice(dbUserId, token.trim())
    res.json({ ok: true })
  } catch (err) { next(err) }
})

export default router
