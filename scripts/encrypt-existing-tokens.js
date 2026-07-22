// Run once after deploying this change:
// GOOGLE_HEALTH_TOKEN_SECRET=<your-secret> node scripts/encrypt-existing-tokens.js
// Then add GOOGLE_HEALTH_TOKEN_SECRET to Railway environment variables
//
// One-time migration: encrypt any plaintext Google Health OAuth tokens already
// stored in fitbit_tokens.access_token / refresh_token. Idempotent — rows whose
// tokens are already in the encrypted envelope form are skipped, so it is safe
// to run multiple times. This script is standalone and is NOT invoked on server
// start. It requires DATABASE_URL and GOOGLE_HEALTH_TOKEN_SECRET in the env.

import { pool } from '../server/db.js'
import { encryptToken, isEncryptedToken } from '../server/utils/tokenEncryption.js'

async function run() {
  // Fail fast with a clear message if the secret is missing (encryptToken would
  // throw the same error, but checking up front avoids a partial run).
  if (!process.env.GOOGLE_HEALTH_TOKEN_SECRET) {
    throw new Error('GOOGLE_HEALTH_TOKEN_SECRET environment variable is required')
  }

  const { rows } = await pool.query(
    'SELECT user_id, access_token, refresh_token FROM fitbit_tokens ORDER BY user_id',
  )

  let encryptedCount = 0

  for (const row of rows) {
    const accessEncrypted = isEncryptedToken(row.access_token)
    const refreshEncrypted = isEncryptedToken(row.refresh_token)

    // Already fully encrypted — nothing to do (keeps the run idempotent).
    if (accessEncrypted && refreshEncrypted) continue

    const newAccess = accessEncrypted ? row.access_token : encryptToken(row.access_token)
    const newRefresh = refreshEncrypted ? row.refresh_token : encryptToken(row.refresh_token)

    await pool.query(
      `UPDATE fitbit_tokens
       SET access_token=$1, refresh_token=$2, updated_at=NOW()
       WHERE user_id=$3`,
      [newAccess, newRefresh, row.user_id],
    )

    encryptedCount += 1
    console.log(`Encrypted token for user_id ${row.user_id}`)
  }

  console.log(`Migration complete — ${encryptedCount} rows encrypted`)
}

run()
  .then(async () => {
    await pool.end()
    process.exit(0)
  })
  .catch(async (err) => {
    console.error('Migration failed:', err.message)
    await pool.end().catch(() => {})
    process.exit(1)
  })
