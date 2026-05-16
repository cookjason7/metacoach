import { pool } from '../db.js'

// Returns the next Date when dayOfWeek/hour/minute fires, starting after `after`.
export function computeNextSendAt(dayOfWeek, hour, minute = 0, after = new Date()) {
  const dt = new Date(after)
  dt.setHours(hour, minute, 0, 0)
  const currentDay = dt.getDay()
  let daysUntil = (dayOfWeek - currentDay + 7) % 7
  if (daysUntil === 0 && dt <= after) daysUntil = 7
  dt.setDate(dt.getDate() + daysUntil)
  return dt
}

export async function processFormSchedules() {
  try {
    const { rows: due } = await pool.query(`
      SELECT fa.*,
             ft.title AS form_title,
             ft.status AS form_status,
             ft.current_version_id
      FROM form_assignments fa
      JOIN form_templates ft ON ft.id = fa.template_id
      WHERE fa.is_active = TRUE
        AND fa.next_send_at <= NOW()
        AND fa.status IN ('pending', 'active')
    `)

    if (due.length === 0) {
      console.log('[formScheduler] No due assignments.')
      return 0
    }

    let sent = 0

    for (const fa of due) {
      // Recurring dedup: if last_sent_at within 6 days, just advance next_send_at and skip
      if (fa.assignment_type === 'recurring' && fa.last_sent_at) {
        const msSinceLast = Date.now() - new Date(fa.last_sent_at).getTime()
        if (msSinceLast < 6 * 24 * 60 * 60 * 1000) {
          const rule = fa.recurring_rule
          const nextSend = computeNextSendAt(rule.day_of_week, rule.hour, rule.minute ?? 0, new Date(fa.last_sent_at))
          await pool.query('UPDATE form_assignments SET next_send_at = $1 WHERE id = $2', [nextSend, fa.id])
          console.log(`[formScheduler] Assignment ${fa.id} sent recently — advancing next_send_at`)
          continue
        }
      }

      if (fa.form_status !== 'published' || !fa.current_version_id) {
        console.log(`[formScheduler] Skipping assignment ${fa.id} — form not published`)
        continue
      }

      const { rows: [client] } = await pool.query(
        'SELECT id, first_name, coaching_type FROM users WHERE id = $1',
        [fa.client_id],
      )
      if (!client) continue

      const thread_type = client.coaching_type === 'ai' ? 'ai_admin' : 'coach_thread'
      const visibility  = thread_type === 'ai_admin' ? 'client_and_admin_only' : 'client_and_staff'

      const firstName   = client.first_name ?? 'there'
      const messageBody = `Hey ${firstName}, please complete your ${fa.form_title} when you have a chance.`
      let submissionAssignmentId = fa.id

      if (fa.assignment_type === 'recurring') {
        const { rows: [occurrence] } = await pool.query(`
          INSERT INTO form_assignments
            (template_id, client_id, assigned_by, send_at, is_active,
             assignment_type, status, sent_at, parent_assignment_id)
          VALUES ($1, $2, $3, NOW(), FALSE, 'recurring_occurrence', 'sent', NOW(), $4)
          RETURNING id
        `, [fa.template_id, fa.client_id, fa.assigned_by, fa.id])
        submissionAssignmentId = occurrence.id
      }

      const metadata = {
        form_id:       fa.template_id,
        assignment_id: submissionAssignmentId,
        form_title:    fa.form_title,
      }

      await pool.query(`
        INSERT INTO client_messages
          (client_id, sender_id, sender_role, message_body, thread_type, visibility, metadata)
        VALUES ($1, $2, 'admin', $3, $4, $5, $6::jsonb)
      `, [fa.client_id, fa.assigned_by, messageBody, thread_type, visibility, JSON.stringify(metadata)])

      if (fa.assignment_type === 'scheduled') {
        await pool.query(
          `UPDATE form_assignments SET status = 'sent', sent_at = NOW(), is_active = FALSE WHERE id = $1`,
          [fa.id],
        )
      } else {
        const rule     = fa.recurring_rule
        const nextSend = computeNextSendAt(rule.day_of_week, rule.hour, rule.minute ?? 0)
        await pool.query(
          `UPDATE form_assignments SET last_sent_at = NOW(), next_send_at = $1 WHERE id = $2`,
          [nextSend, fa.id],
        )
      }

      sent++
      console.log(`[formScheduler] Sent form assignment ${fa.id} to client ${fa.client_id}`)
    }

    console.log(`[formScheduler] Processed ${sent} assignment(s)`)
    return sent
  } catch (err) {
    console.error('[formScheduler] Job failed:', err.message)
    return 0
  }
}
