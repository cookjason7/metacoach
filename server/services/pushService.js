import { pool } from '../db.js'

// Firebase Admin is optional — the entire push system no-ops if credentials
// are missing so the app runs cleanly in dev and on staging without FCM setup.
let messaging = null

export function initPush() {
  const credJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
  if (!credJson) {
    console.log('[push] FIREBASE_SERVICE_ACCOUNT_JSON not set — push notifications disabled (no-op mode)')
    return
  }
  try {
    // Dynamic import so firebase-admin not required at module load time
    import('firebase-admin').then(({ default: admin }) => {
      if (admin.apps.length === 0) {
        admin.initializeApp({
          credential: admin.credential.cert(JSON.parse(credJson)),
        })
      }
      messaging = admin.messaging()
      console.log('[push] Firebase Admin initialized')
    }).catch(err => {
      console.warn('[push] firebase-admin import failed:', err.message, '— push disabled')
    })
  } catch (err) {
    console.warn('[push] initPush failed:', err.message, '— push disabled')
  }
}

// Register a device token for a user. Upserts on token to update last_used_at.
export async function registerDevice(userId, token, platform = 'android') {
  const { rows, rowCount } = await pool.query(`
    INSERT INTO push_devices (user_id, token, platform, last_used_at)
    VALUES ($1, $2, $3, NOW())
    ON CONFLICT (token) DO UPDATE
      SET user_id      = EXCLUDED.user_id,
          platform     = EXCLUDED.platform,
          last_used_at = NOW()
    RETURNING id, user_id, platform
  `, [userId, token, platform])
  const device = rows[0] ?? null
  console.log('[push] device upserted', {
    userId,
    platform,
    tokenStart: token.slice(0, 12),
    rowCount,
    deviceId: device?.id,
  })
  return device
}

// Remove a specific device token (on logout / permission revoked).
export async function revokeDevice(userId, token) {
  await pool.query(
    `DELETE FROM push_devices WHERE user_id = $1 AND token = $2`,
    [userId, token],
  )
}

// Send a push notification to all registered devices for a user.
// Returns true if at least one message was sent; false if no-op.
export async function sendToUser(userId, { title, body }) {
  if (!messaging) return false

  const { rows } = await pool.query(
    `SELECT token FROM push_devices WHERE user_id = $1`,
    [userId],
  )
  if (rows.length === 0) return false

  const tokens = rows.map(r => r.token)
  try {
    const result = await messaging.sendEachForMulticast({
      tokens,
      notification: { title, body },
      android: { priority: 'high' },
      apns: { payload: { aps: { sound: 'default' } } },
    })

    // Clean up tokens that FCM says are invalid/unregistered
    const badTokens = result.responses
      .map((r, i) => (!r.success && isInvalidTokenError(r.error) ? tokens[i] : null))
      .filter(Boolean)

    if (badTokens.length > 0) {
      await pool.query(
        `DELETE FROM push_devices WHERE token = ANY($1::text[])`,
        [badTokens],
      )
    }
    return result.successCount > 0
  } catch (err) {
    console.warn('[push] sendToUser error:', err.message)
    return false
  }
}

function isInvalidTokenError(err) {
  if (!err) return false
  const code = err.code ?? ''
  return code === 'messaging/invalid-registration-token' ||
    code === 'messaging/registration-token-not-registered'
}

// Notify a user about a new direct message they received.
// Generic copy only — no message content, no health data.
export async function notifyNewDirectMessage(recipientUserId) {
  try {
    const { rows } = await pool.query(
      `SELECT notif_master_enabled, notif_dm_enabled FROM users WHERE id = $1`,
      [recipientUserId],
    )
    const prefs = rows[0]
    if (!prefs || prefs.notif_master_enabled === false || prefs.notif_dm_enabled === false) return
    await sendToUser(recipientUserId, {
      title: 'New Message',
      body:  'You have a new message.',
    })
  } catch (err) {
    console.warn('[push] notifyNewDirectMessage error:', err.message)
  }
}

// Notify a client that a form or check-in has been sent to them.
// Generic copy only — no form title, no health data.
export async function notifyNewFormDelivery(clientUserId) {
  try {
    const { rows } = await pool.query(
      `SELECT notif_master_enabled, notif_form_enabled FROM users WHERE id = $1`,
      [clientUserId],
    )
    const prefs = rows[0]
    if (!prefs || prefs.notif_master_enabled === false || prefs.notif_form_enabled === false) return
    await sendToUser(clientUserId, {
      title: 'New Form',
      body:  'You have a new form to complete.',
    })
  } catch (err) {
    console.warn('[push] notifyNewFormDelivery error:', err.message)
  }
}

// Notify a client when their check-in was submitted late.
// Generic copy only — no answers, no health data.
export async function notifyLateCheckInSubmitted(clientUserId) {
  try {
    const { rows } = await pool.query(
      `SELECT notif_master_enabled, notif_form_enabled FROM users WHERE id = $1`,
      [clientUserId],
    )
    const prefs = rows[0]
    if (!prefs || prefs.notif_master_enabled === false || prefs.notif_form_enabled === false) return
    await sendToUser(clientUserId, {
      title: 'Check-In Submitted',
      body:  'Your late check-in was received.',
    })
  } catch (err) {
    console.warn('[push] notifyLateCheckInSubmitted error:', err.message)
  }
}
// Notify community members about a new post.
// Generic copy only — no post content, no health data.
// v1: notifies staff/admin only to limit spam. Leave a clear note for product.
//
// PRODUCT NOTE: For v1, community push is sent only to staff/admin users
// to avoid flooding all clients. Expand to clients in a future iteration
// after notification opt-out UX is validated with real usage.
export async function notifyNewCommunityPost(authorUserId) {
  try {
    const { rows } = await pool.query(
      `SELECT id, notif_master_enabled, notif_community_enabled
       FROM users
       WHERE id != $1
         AND role IN ('admin', 'coach')
         AND notif_master_enabled = TRUE
         AND notif_community_enabled = TRUE`,
      [authorUserId],
    )
    for (const user of rows) {
      await sendToUser(user.id, {
        title: 'New Post',
        body:  "There's a new group post.",
      }).catch(() => {})
    }
  } catch (err) {
    console.warn('[push] notifyNewCommunityPost error:', err.message)
  }
}
