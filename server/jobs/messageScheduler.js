import { pool } from '../db.js'
import { acquireJobLock, releaseJobLock } from './jobLock.js'
import { insertStaffMessage } from '../services/messageDelivery.js'

// Delivers staff-scheduled client messages whose send_at has passed.
// Mirrors processFormSchedules (jobs/formScheduler.js): same job_locks
// acquire/release, same "claim the row atomically before doing the work"
// shape, and registered alongside it in index.js so it sits behind the same
// DISABLE_BACKGROUND_JOBS switch used on staging.
//
// One-time sends only — there is no next_send_at to advance, so a claimed row
// is terminal.
export async function processScheduledMessages() {
  const locked = await acquireJobLock('message_scheduler', 240000)
  if (!locked) {
    console.log('[messageScheduler] Lock held by another instance — skipping')
    return 0
  }
  try {
    const { rows: due } = await pool.query(`
      SELECT *
      FROM scheduled_messages
      WHERE status = 'pending'
        AND send_at <= NOW()
      ORDER BY send_at
    `)

    if (due.length === 0) {
      const { rows: [summary] } = await pool.query(`
        SELECT COUNT(*)::int AS pending, MIN(send_at) AS next_due_at
        FROM scheduled_messages
        WHERE status = 'pending'
      `)
      console.log('[messageScheduler] No due messages.', {
        pending: summary?.pending ?? 0,
        next_due_at: summary?.next_due_at ?? null,
      })
      return 0
    }

    console.log(`[messageScheduler] Found ${due.length} due message(s).`)

    let sent = 0

    for (const sm of due) {
      // ── Atomic row-level claim (defense in depth against concurrent runs) ────
      // The job lock above already serializes instances; this makes a duplicate
      // send impossible even if the lock is lost or expires mid-run.
      const { rows: claimed } = await pool.query(
        `UPDATE scheduled_messages
         SET status = 'sent', sent_at = NOW()
         WHERE id = $1 AND status = 'pending'
         RETURNING id`,
        [sm.id],
      )
      if (claimed.length === 0) {
        console.log(`[messageScheduler] Message ${sm.id} already claimed or cancelled — skipping`)
        continue
      }

      try {
        const message = await insertStaffMessage({
          clientId:    sm.client_id,
          senderId:    sm.sender_id,
          senderRole:  sm.sender_role,
          messageBody: sm.message_body,
          threadType:  sm.thread_type,
          visibility:  sm.visibility,
          imageUrl:    sm.image_url,
          audioUrl:    sm.audio_url,
          orgId:       sm.org_id,
        })

        await pool.query(
          `UPDATE scheduled_messages SET sent_message_id = $1 WHERE id = $2`,
          [message.id, sm.id],
        )

        sent++
        console.log('[messageScheduler] message delivered', {
          scheduled_message_id: sm.id,
          message_id: message.id,
          client_id: sm.client_id,
          thread_type: sm.thread_type,
          send_at: sm.send_at,
        })
      } catch (err) {
        // The claim already flipped this row to 'sent', but the delivery failed —
        // release it back to pending so the next tick retries instead of silently
        // swallowing the message. Guarded on sent_message_id IS NULL so a row
        // that did land a message is never re-queued and double-sent.
        await pool.query(
          `UPDATE scheduled_messages
           SET status = 'pending', sent_at = NULL
           WHERE id = $1 AND sent_message_id IS NULL`,
          [sm.id],
        )
        console.error(`[messageScheduler] Delivery failed for scheduled message ${sm.id} — requeued:`, err.message)
      }
    }

    console.log(`[messageScheduler] Processed ${sent} message(s)`)
    return sent
  } catch (err) {
    console.error('[messageScheduler] Job failed:', err.message)
    return 0
  } finally {
    await releaseJobLock('message_scheduler')
  }
}
