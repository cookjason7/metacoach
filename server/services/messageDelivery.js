import { pool } from '../db.js'
import { notifyNewDirectMessage } from './pushService.js'

// Single source of truth for writing a staff-authored message into
// client_messages. Shared by the live send route (POST /clients/:id/messages in
// routes/coachAdmin.js) and the scheduled-message job (jobs/messageScheduler.js)
// so a message that was scheduled lands byte-identical to one sent immediately —
// same column set, same push notification, same returned row shape.
//
// thread_type/visibility arrive already resolved. Canonicalization
// (isAdminAssignedCoach) and the ai_admin eligibility gate stay at the call site
// because they need the requesting staff member's ctx, which the job doesn't
// have — for scheduled sends both are resolved once, at schedule time, and
// stored on the scheduled_messages row.
export async function insertStaffMessage({
  clientId,
  senderId,
  senderRole,
  messageBody,
  threadType,
  visibility,
  imageUrl = null,
  audioUrl = null,
  orgId,
}) {
  const { rows } = await pool.query(`
    INSERT INTO client_messages
      (client_id, sender_id, sender_role, message_body, thread_type, visibility, image_url, audio_url, org_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *
  `, [clientId, senderId, senderRole, messageBody, threadType, visibility, imageUrl, audioUrl, orgId])

  // Push: notify the client — fire-and-forget, never blocks or fails the send.
  notifyNewDirectMessage(clientId).catch(() => {})

  return rows[0]
}
