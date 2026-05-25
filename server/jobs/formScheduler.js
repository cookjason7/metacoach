import { pool } from '../db.js'
import { acquireJobLock, releaseJobLock } from './jobLock.js'

// Returns the next Date when dayOfWeek/hour/minute fires, starting after `after`.
export function computeNextSendAt(dayOfWeek, hour, minute = 0, after = new Date(), timezoneOffsetMinutes = null) {
  if (Number.isFinite(Number(timezoneOffsetMinutes))) {
    const offsetMs = Number(timezoneOffsetMinutes) * 60 * 1000
    const localNow = new Date(after.getTime() - offsetMs)
    const localTarget = new Date(localNow)
    localTarget.setUTCHours(hour, minute, 0, 0)
    const currentDay = localTarget.getUTCDay()
    let daysUntil = (dayOfWeek - currentDay + 7) % 7
    if (daysUntil === 0 && localTarget <= localNow) daysUntil = 7
    localTarget.setUTCDate(localTarget.getUTCDate() + daysUntil)
    return new Date(localTarget.getTime() + offsetMs)
  }

  const dt = new Date(after)
  dt.setHours(hour, minute, 0, 0)
  const currentDay = dt.getDay()
  let daysUntil = (dayOfWeek - currentDay + 7) % 7
  if (daysUntil === 0 && dt <= after) daysUntil = 7
  dt.setDate(dt.getDate() + daysUntil)
  return dt
}

export async function processFormSchedules() {
  const locked = await acquireJobLock('form_scheduler', 3000000)
  if (!locked) {
    console.log('[formScheduler] Lock held by another instance — skipping')
    return 0
  }
  try {
    const { rows: due } = await pool.query(`
      SELECT fa.*,
             ft.title AS form_title,
             ft.status AS form_status,
             ft.current_version_id
      FROM form_assignments fa
      JOIN form_templates ft ON ft.id = fa.template_id
      WHERE fa.is_active = TRUE
        AND fa.assignment_type IN ('scheduled', 'recurring')
        AND fa.next_send_at <= NOW()
        AND fa.status IN ('pending', 'active')
    `)

    console.log(`[formScheduler] Found ${due.length} due assignment(s).`)

    if (due.length === 0) {
      const { rows: [summary] } = await pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE is_active = TRUE AND status IN ('pending', 'active'))::int AS active_pending,
          MIN(next_send_at) FILTER (WHERE is_active = TRUE AND status IN ('pending', 'active')) AS next_due_at
        FROM form_assignments
        WHERE assignment_type IN ('scheduled', 'recurring')
      `)
      console.log('[formScheduler] No due assignments.', {
        active_pending: summary?.active_pending ?? 0,
        next_due_at: summary?.next_due_at ?? null,
      })
      return 0
    }

    let sent = 0

    for (const fa of due) {
      const ruleForEndDate = fa.recurring_rule ?? {}
      if (fa.assignment_type === 'recurring' && ruleForEndDate.end_date) {
        const offsetMs = Number(ruleForEndDate.timezone_offset_minutes ?? 0) * 60 * 1000
        const localNow = new Date(Date.now() - offsetMs)
        const todayLocal = localNow.toISOString().slice(0, 10)
        if (todayLocal > ruleForEndDate.end_date) {
          await pool.query(
            `UPDATE form_assignments SET status = 'completed', is_active = FALSE WHERE id = $1`,
            [fa.id],
          )
          console.log(`[formScheduler] Assignment ${fa.id} completed — recurring end date reached`, {
            end_date: ruleForEndDate.end_date,
            today_local: todayLocal,
          })
          continue
        }
      }

      // Recurring dedup: if last_sent_at within 6 days, just advance next_send_at and skip
      if (fa.assignment_type === 'recurring' && fa.last_sent_at) {
        const msSinceLast = Date.now() - new Date(fa.last_sent_at).getTime()
        if (msSinceLast < 6 * 24 * 60 * 60 * 1000) {
          const rule = fa.recurring_rule
          const nextSend = computeNextSendAt(rule.day_of_week, rule.hour, rule.minute ?? 0, new Date(fa.last_sent_at), rule.timezone_offset_minutes)
          await pool.query('UPDATE form_assignments SET next_send_at = $1 WHERE id = $2', [nextSend, fa.id])
          console.log(`[formScheduler] Assignment ${fa.id} sent recently — advancing next_send_at`)
          continue
        }
      }

      if (fa.form_status !== 'published' || !fa.current_version_id) {
        console.log(`[formScheduler] Skipping assignment ${fa.id} — form not published`, {
          template_id: fa.template_id,
          form_status: fa.form_status,
          current_version_id: fa.current_version_id,
        })
        continue
      }

      // ── Atomic row-level claim (defense in depth against concurrent runs) ────
      if (fa.assignment_type === 'scheduled') {
        const { rows: claimed } = await pool.query(
          `UPDATE form_assignments
           SET status = 'sent', sent_at = NOW(), is_active = FALSE
           WHERE id = $1 AND status = 'pending' AND is_active = TRUE
           RETURNING id`,
          [fa.id],
        )
        if (claimed.length === 0) {
          console.log(`[formScheduler] Assignment ${fa.id} already claimed — skipping`)
          continue
        }
      } else {
        // recurring
        const { rows: claimed } = await pool.query(
          `UPDATE form_assignments SET last_sent_at = NOW()
           WHERE id = $1 AND (last_sent_at IS NULL OR last_sent_at < NOW() - INTERVAL '6 days')
           RETURNING id`,
          [fa.id],
        )
        if (claimed.length === 0) {
          console.log(`[formScheduler] Assignment ${fa.id} already claimed — skipping`)
          continue
        }
      }

      const { rows: [client] } = await pool.query(
        'SELECT id, first_name, coaching_type FROM users WHERE id = $1',
        [fa.client_id],
      )
      if (!client) {
        console.log(`[formScheduler] Skipping assignment ${fa.id} — client not found`, {
          client_id: fa.client_id,
        })
        continue
      }

      const thread_type = client.coaching_type === 'ai' ? 'ai_admin' : 'coach_thread'
      const visibility  = thread_type === 'ai_admin' ? 'client_and_admin_only' : 'client_and_staff'

      const firstName   = client.first_name ?? 'there'
      const messageBody = /weekly\s+check[-\s]?in/i.test(fa.form_title ?? '')
        ? 'Please complete your weekly check-in.'
        : `Hey ${firstName}, please complete your ${fa.form_title}.`
      let submissionAssignmentId = fa.id
      const ruleForWindow = fa.recurring_rule ?? {}
      const offsetMs = Number(ruleForWindow.timezone_offset_minutes ?? 0) * 60 * 1000
      const dueLocal = new Date(new Date(fa.next_send_at ?? Date.now()).getTime() - offsetMs)
      const windowStartLocal = new Date(dueLocal)
      windowStartLocal.setUTCHours(0, 0, 0, 0)
      const windowEndLocal = new Date(windowStartLocal)
      windowEndLocal.setUTCDate(windowEndLocal.getUTCDate() + 1)
      const windowStartUtc = new Date(windowStartLocal.getTime() + offsetMs)
      const windowEndUtc = new Date(windowEndLocal.getTime() + offsetMs)

      const { rows: duplicateWindowMessages } = await pool.query(
        `SELECT id FROM client_messages
         WHERE client_id = $1
           AND metadata->>'form_id' = $2
           AND created_at >= $3
           AND created_at < $4
         LIMIT 1`,
        [fa.client_id, String(fa.template_id), windowStartUtc, windowEndUtc],
      )
      if (duplicateWindowMessages.length > 0) {
        console.log('[formScheduler] Skipping duplicate form delivery in date window', {
          existing_message_id: duplicateWindowMessages[0].id,
          schedule_assignment_id: fa.id,
          client_id: fa.client_id,
          template_id: fa.template_id,
          window_start_utc: windowStartUtc.toISOString(),
          window_end_utc: windowEndUtc.toISOString(),
        })
        if (fa.assignment_type === 'recurring') {
          const rule = fa.recurring_rule
          const nextSend = computeNextSendAt(rule.day_of_week, rule.hour, rule.minute ?? 0, new Date(), rule.timezone_offset_minutes)
          await pool.query(`UPDATE form_assignments SET next_send_at = $1 WHERE id = $2`, [nextSend, fa.id])
        }
        continue
      }

      if (fa.assignment_type === 'recurring') {
        const { rows: [occurrence] } = await pool.query(`
          INSERT INTO form_assignments
            (template_id, client_id, assigned_by, send_at, is_active,
             assignment_type, status, sent_at, parent_assignment_id)
          VALUES ($1, $2, $3, NOW(), FALSE, 'recurring_occurrence', 'sent', NOW(), $4)
          RETURNING id
        `, [fa.template_id, fa.client_id, fa.assigned_by, fa.id])
        submissionAssignmentId = occurrence.id
        console.log('[formScheduler] recurring occurrence assignment created', {
          parent_assignment_id: fa.id,
          assignment_id: submissionAssignmentId,
          client_id: fa.client_id,
          template_id: fa.template_id,
        })
      }

      const metadata = {
        form_id:       fa.template_id,
        assignment_id: submissionAssignmentId,
        form_title:    fa.form_title,
      }

      const { rows: existingMessages } = await pool.query(
        `SELECT id FROM client_messages
         WHERE client_id = $1
           AND metadata->>'assignment_id' = $2
         LIMIT 1`,
        [fa.client_id, String(submissionAssignmentId)],
      )
      if (existingMessages.length > 0) {
        console.log('[formScheduler] Skipping duplicate message insert', {
          existing_message_id: existingMessages[0].id,
          assignment_id: submissionAssignmentId,
          schedule_assignment_id: fa.id,
        })
      } else {
      const { rows: [message] } = await pool.query(`
        INSERT INTO client_messages
          (client_id, sender_id, sender_role, message_body, thread_type, visibility, metadata)
        VALUES ($1, $2, 'admin', $3, $4, $5, $6::jsonb)
        RETURNING id, metadata
      `, [fa.client_id, fa.assigned_by, messageBody, thread_type, visibility, JSON.stringify(metadata)])
      console.log('[formScheduler] message inserted', {
        message_id: message.id,
        schedule_assignment_id: fa.id,
        assignment_id: submissionAssignmentId,
        client_id: fa.client_id,
        template_id: fa.template_id,
        thread_type,
        has_form_metadata: Boolean(message.metadata?.form_id && message.metadata?.assignment_id),
      })
      }

      if (fa.assignment_type === 'recurring') {
        const rule     = fa.recurring_rule
        const nextSend = computeNextSendAt(rule.day_of_week, rule.hour, rule.minute ?? 0, new Date(), rule.timezone_offset_minutes)
        await pool.query(
          `UPDATE form_assignments SET next_send_at = $1 WHERE id = $2`,
          [nextSend, fa.id],
        )
      }
      // scheduled: status/sent_at/is_active already set in the atomic claim above

      sent++
      console.log(`[formScheduler] Sent form assignment ${fa.id} to client ${fa.client_id}`)
    }

    console.log(`[formScheduler] Processed ${sent} assignment(s)`)
    return sent
  } catch (err) {
    console.error('[formScheduler] Job failed:', err.message)
    return 0
  } finally {
    await releaseJobLock('form_scheduler')
  }
}
