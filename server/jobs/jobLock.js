import { pool } from '../db.js'

export async function acquireJobLock(name, ttlMs) {
  try {
    const { rows } = await pool.query(
      `INSERT INTO job_locks (job_name, locked_until)
       VALUES ($1, NOW() + ($2 || ' milliseconds')::interval)
       ON CONFLICT (job_name) DO UPDATE
         SET locked_at = NOW(),
             locked_until = NOW() + ($2 || ' milliseconds')::interval
         WHERE job_locks.locked_until < NOW()
       RETURNING job_name`,
      [name, String(ttlMs)],
    )
    return rows.length > 0
  } catch (err) {
    console.error(`[jobLock] acquireJobLock(${name}) failed:`, err.message)
    return false
  }
}

export async function releaseJobLock(name) {
  try {
    await pool.query('DELETE FROM job_locks WHERE job_name = $1', [name])
  } catch (err) {
    console.error(`[jobLock] releaseJobLock(${name}) failed:`, err.message)
  }
}
