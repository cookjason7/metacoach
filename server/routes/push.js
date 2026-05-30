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

    await registerDevice(dbUserId, token.trim(), platform)
    res.json({ ok: true })
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
