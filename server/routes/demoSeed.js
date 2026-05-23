/**
 * demoSeed.js — HTTP endpoint for the staging-only demo data seeder
 *
 * Mounted at /api/demo when NODE_ENV !== 'production' OR ALLOW_DEMO_SEED=true.
 *
 * POST /api/demo/seed
 *   Headers: X-Seed-Secret: <SEED_SECRET env var>
 *   Query:   ?wipe=true   (optional — wipes and re-seeds)
 *
 * Returns:
 *   200 { ok: true, summary }
 *   200 { skipped: true, reason }
 *   403 Forbidden (wrong secret or seed not allowed)
 *   500 { error: message }
 */

import express from 'express'
import { isSeedAllowed, runSeed } from '../scripts/seed-demo.js'

const router = express.Router()

router.post('/seed', async (req, res) => {
  // Safety gate — belt-and-suspenders even though mount is conditional
  if (!isSeedAllowed()) {
    return res.status(403).json({ error: 'Demo seed not allowed in this environment.' })
  }

  // Secret check — require matching X-Seed-Secret header
  const secret = process.env.SEED_SECRET
  if (secret) {
    const provided = req.headers['x-seed-secret']
    if (!provided || provided !== secret) {
      return res.status(403).json({ error: 'Invalid or missing X-Seed-Secret header.' })
    }
  }

  const wipe = req.query.wipe === 'true'
  const logs = []
  const log = (msg) => logs.push(msg)

  try {
    const result = await runSeed({ wipe, log })
    return res.json({ ...result, logs })
  } catch (err) {
    console.error('[demo-seed]', err.message)
    return res.status(500).json({ error: err.message, logs })
  }
})

export default router
