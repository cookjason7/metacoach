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
  if (!messaging) {
    console.warn('[push] sendToUser skipped — Firebase not initialized (userId=%s)', userId)
    return false
  }

  const { rows } = await pool.query(
    `SELECT token, platform FROM push_devices WHERE user_id = $1`,
    [userId],
  )
  if (rows.length === 0) {
    console.warn('[push] sendToUser — no registered devices for userId=%s', userId)
    return false
  }

  const tokens = rows.map(r => r.token)
  const platforms = rows.map(r => r.platform)
  console.log('[push] sendToUser attempting — userId=%s deviceCount=%d platforms=%s title="%s"',
    userId, tokens.length, platforms.join(','), title)

  try {
    const result = await messaging.sendEachForMulticast({
      tokens,
      notification: { title, body },
      android: { priority: 'high' },
      apns: { payload: { aps: { sound: 'default' } } },
    })

    // Log per-device outcomes (no token values printed)
    result.responses.forEach((r, i) => {
      if (r.success) {
        console.log('[push] sendToUser device[%d] platform=%s SUCCESS messageId=%s', i, platforms[i], r.messageId)
      } else {
        console.warn('[push] sendToUser device[%d] platform=%s FAILED code=%s msg=%s',
          i, platforms[i], r.error?.code ?? 'unknown', r.error?.message?.slice(0, 120) ?? 'unknown')
      }
    })

    console.log('[push] sendToUser result — userId=%s success=%d failure=%d',
      userId, result.successCount, result.failureCount)

    // Clean up tokens that FCM says are invalid/unregistered
    const badTokens = result.responses
      .map((r, i) => (!r.success && isInvalidTokenError(r.error) ? tokens[i] : null))
      .filter(Boolean)

    if (badTokens.length > 0) {
      console.warn('[push] sendToUser pruning %d invalid token(s) for userId=%s', badTokens.length, userId)
      await pool.query(
        `DELETE FROM push_devices WHERE token = ANY($1::text[])`,
        [badTokens],
      )
    }
    return result.successCount > 0
  } catch (err) {
    console.warn('[push] sendToUser error userId=%s: %s', userId, err.message)
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
    if (!prefs) {
      console.warn('[push] notifyNewDirectMessage — user not found userId=%s', recipientUserId)
      return
    }
    if (!prefs.notif_master_enabled || !prefs.notif_dm_enabled) {
      console.log('[push] notifyNewDirectMessage — suppressed by prefs userId=%s master=%s dm=%s',
        recipientUserId, prefs.notif_master_enabled, prefs.notif_dm_enabled)
      return
    }
    console.log('[push] notifyNewDirectMessage — sending to userId=%s', recipientUserId)
    await sendToUser(recipientUserId, {
      title: 'New Message',
      body:  'You have a new message.',
    })
  } catch (err) {
    console.warn('[push] notifyNewDirectMessage error userId=%s: %s', recipientUserId, err.message)
  }
}

// Notify a client that a form or check-in has been sent to them.
// Generic copy only — no form title, no health data.
export async function notifyNewFormDelivery(clientUserId) {
  try {
    const { rows } = await pool.query(
      `SELECT notif_master_enabled, notif_dm_enabled FROM users WHERE id = $1`,
      [clientUserId],
    )
    const prefs = rows[0]
    if (!prefs || !prefs.notif_master_enabled || !prefs.notif_dm_enabled) return
    await sendToUser(clientUserId, {
      title: 'New Form',
      body:  'You have a new form to complete.',
    })
  } catch (err) {
    console.warn('[push] notifyNewFormDelivery error:', err.message)
  }
}

// Notify community members about a new post.
// Generic copy only — no post content, no health data.
// Staff/admin are always notified of any new post (staff or client authored).
// Clients are only notified when the post is staff-authored (authorIsStaff=true) —
// posts from other clients don't push to the whole client base, to limit spam.
export async function notifyNewCommunityPost(authorUserId, authorIsStaff = false) {
  try {
    const roleFilter = authorIsStaff
      ? `(role IN ('admin', 'coach') OR (role = 'client' AND COALESCE(coaching_type, '') != 'basic'))`
      : `role IN ('admin', 'coach')`
    const { rows } = await pool.query(
      `SELECT id, notif_master_enabled, notif_community_enabled
       FROM users
       WHERE id != $1
         AND ${roleFilter}
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
