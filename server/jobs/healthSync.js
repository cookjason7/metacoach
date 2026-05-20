import { pool } from '../db.js'
import { acquireJobLock, releaseJobLock } from './jobLock.js'
import { syncUser } from '../services/googleHealthSync.js'

/**
 * Hourly job: sync today's steps and sleep for every connected user.
 *
 * Uses job_locks to ensure only one instance runs at a time across Railway
 * replicas. Users are synced sequentially (not in parallel) to be gentle on
 * the Google Health API and avoid flooding a single rate-limit bucket.
 *
 * Per-user errors are caught individually and recorded in fitbit_tokens
 * (last_sync_error / last_sync_error_at) so one bad token cannot stop other
 * users from syncing.
 */
export async function runHealthSync() {
  const acquired = await acquireJobLock('google_health_sync', 58 * 60 * 1000)
  if (!acquired) {
    console.log('[healthSync] skipped — another instance holds the lock')
    return
  }

  try {
    const { rows } = await pool.query('SELECT user_id FROM fitbit_tokens ORDER BY user_id')
    if (!rows.length) {
      console.log('[healthSync] no connected users — nothing to sync')
      return
    }

    console.log(`[healthSync] syncing ${rows.length} connected user(s)`)

    for (const { user_id } of rows) {
      try {
        const result = await syncUser(user_id)
        console.log(
          `[healthSync] user ${user_id} OK — steps=${result.steps ?? 'n/a'} sleep=${result.sleep_minutes ?? 'n/a'}min`,
        )
      } catch (err) {
        // Error already persisted to fitbit_tokens by syncUser
        console.error(`[healthSync] user ${user_id} failed: ${err.message}`)
      }
    }

    console.log('[healthSync] done')
  } finally {
    await releaseJobLock('google_health_sync')
  }
}
