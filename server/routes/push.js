import { Router } from 'express'
import { requireAuth, getAuth } from '@clerk/express'
import { getOrCreateUser } from '../db.js'
import { registerDevice, revokeDevice } from '../services/pushService.js'

const router = Router()

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
