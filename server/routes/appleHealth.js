import { Router } from 'express'
import { requireAuth } from '@clerk/express'
import { pool, getOrCreateUser } from '../db.js'

const router = Router()

/**
 * POST /api/apple-health/sync
 *
 * Body: { steps?: number, sleep_minutes?: number }
 *
 * Auth: requireAuth() validates the Clerk JWT on every request. The DB user
 * ID is derived exclusively from the verified JWT's userId via getOrCreateUser(),
 * so it is impossible for a caller to write to another user's daily_log row.
 *
 * Source-protection rules (mirror googleHealthSync.js):
 *   - 'manual' entries are NEVER overwritten by this endpoint.
 *   - Among automated sources ('fitbit', 'google_health', 'synced',
 *     'apple_health'), precedence is most-recent-write-wins: apple_health may
 *     overwrite any of them as long as this write isn't older than the last
 *     recorded write (steps_source_updated_at/sleep_source_updated_at) — same
 *     rule as googleHealthSync.js, so neither source can permanently lock the
 *     other out.
 *   - Sending null for a field is a no-op — it never clears an existing value.
 */
router.post('/sync', requireAuth(), async (req, res, next) => {
  try {
    const userId = req.effectiveClerkUserId
    const dbUserId    = await getOrCreateUser(userId)
    const steps         = req.body.steps         != null ? Math.round(Number(req.body.steps))         : null
    const sleep_minutes = req.body.sleep_minutes != null ? Math.round(Number(req.body.sleep_minutes)) : null

    const SYNC_SOURCES = "('fitbit','google_health','synced','apple_health')"

    const { rows } = await pool.query(
      `INSERT INTO daily_logs (user_id, logged_date, steps, sleep_minutes, steps_source, sleep_source, steps_source_updated_at, sleep_source_updated_at, org_id)
       VALUES ($1, CURRENT_DATE, $2, $3,
               CASE WHEN $2::integer IS NOT NULL THEN 'apple_health' ELSE NULL END,
               CASE WHEN $3::integer IS NOT NULL THEN 'apple_health' ELSE NULL END,
               CASE WHEN $2::integer IS NOT NULL THEN NOW() ELSE NULL END,
               CASE WHEN $3::integer IS NOT NULL THEN NOW() ELSE NULL END,
               $4)
       ON CONFLICT (user_id, logged_date) DO UPDATE SET
         steps = CASE
           WHEN daily_logs.steps IS NULL
                OR (COALESCE(daily_logs.steps_source,'manual') IN ${SYNC_SOURCES}
                    AND (daily_logs.steps_source_updated_at IS NULL OR daily_logs.steps_source_updated_at <= NOW()))
             THEN COALESCE(EXCLUDED.steps, daily_logs.steps)
           ELSE daily_logs.steps
         END,
         steps_source = CASE
           WHEN EXCLUDED.steps IS NOT NULL
                AND (daily_logs.steps IS NULL
                     OR (COALESCE(daily_logs.steps_source,'manual') IN ${SYNC_SOURCES}
                         AND (daily_logs.steps_source_updated_at IS NULL OR daily_logs.steps_source_updated_at <= NOW())))
             THEN 'apple_health'
           ELSE COALESCE(daily_logs.steps_source,'manual')
         END,
         steps_source_updated_at = CASE
           WHEN EXCLUDED.steps IS NOT NULL
                AND (daily_logs.steps IS NULL
                     OR (COALESCE(daily_logs.steps_source,'manual') IN ${SYNC_SOURCES}
                         AND (daily_logs.steps_source_updated_at IS NULL OR daily_logs.steps_source_updated_at <= NOW())))
             THEN NOW()
           ELSE daily_logs.steps_source_updated_at
         END,
         sleep_minutes = CASE
           WHEN daily_logs.sleep_minutes IS NULL
                OR (COALESCE(daily_logs.sleep_source,'manual') IN ${SYNC_SOURCES}
                    AND (daily_logs.sleep_source_updated_at IS NULL OR daily_logs.sleep_source_updated_at <= NOW()))
             THEN COALESCE(EXCLUDED.sleep_minutes, daily_logs.sleep_minutes)
           ELSE daily_logs.sleep_minutes
         END,
         sleep_source = CASE
           WHEN EXCLUDED.sleep_minutes IS NOT NULL
                AND (daily_logs.sleep_minutes IS NULL
                     OR (COALESCE(daily_logs.sleep_source,'manual') IN ${SYNC_SOURCES}
                         AND (daily_logs.sleep_source_updated_at IS NULL OR daily_logs.sleep_source_updated_at <= NOW())))
             THEN 'apple_health'
           ELSE COALESCE(daily_logs.sleep_source,'manual')
         END,
         sleep_source_updated_at = CASE
           WHEN EXCLUDED.sleep_minutes IS NOT NULL
                AND (daily_logs.sleep_minutes IS NULL
                     OR (COALESCE(daily_logs.sleep_source,'manual') IN ${SYNC_SOURCES}
                         AND (daily_logs.sleep_source_updated_at IS NULL OR daily_logs.sleep_source_updated_at <= NOW())))
             THEN NOW()
           ELSE daily_logs.sleep_source_updated_at
         END
       RETURNING steps, sleep_minutes, steps_source, sleep_source`,
      [dbUserId, steps, sleep_minutes, req.orgId],
    )

    res.json({
      steps:         rows[0]?.steps         ?? null,
      sleep_minutes: rows[0]?.sleep_minutes ?? null,
      steps_source:  rows[0]?.steps_source  ?? null,
      sleep_source:  rows[0]?.sleep_source  ?? null,
      synced_at:     new Date().toISOString(),
    })
  } catch (err) {
    next(err)
  }
})

export default router
