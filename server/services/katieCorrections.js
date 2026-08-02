// Admin-entered corrections pulled into Katie's context at answer-time, without
// a code deploy. Same shape/purpose as getAppHelpContext in appHelpKnowledge.js
// (match an incoming client message, return only the matched content for this
// turn) — the difference is corrections live in katie_corrections (server/db.js)
// instead of a static file, so an admin can fix a wrong answer immediately by
// inserting a row instead of waiting on a code change.
//
// No admin UI yet — inserting rows directly into katie_corrections is the
// intended way to add one for now (see server/db.js for the schema).

import { pool } from '../db.js'

// Returns an ADMIN CORRECTIONS context block to append to Katie's system prompt
// for this turn only, or '' if no active correction matches. Matching is a
// case-insensitive substring check of each correction's trigger_keywords
// against the current message (and the prior client message, so a short
// follow-up reply still resolves to the right correction — same reasoning as
// getAppHelpContext's priorUserMessage param).
export async function getKatieCorrections(message, priorUserMessage = '', orgId = null) {
  if (!message || typeof message !== 'string') return ''

  const classifierText = [priorUserMessage, message].filter(Boolean).join(' ').toLowerCase()
  if (!classifierText.trim()) return ''

  let rows
  try {
    ;({ rows } = await pool.query(
      `SELECT id, trigger_keywords, correct_answer
       FROM katie_corrections
       WHERE active = TRUE AND org_id = $1`,
      [orgId],
    ))
  } catch (err) {
    // Never let a corrections-lookup failure break the chat response.
    console.error('[katieCorrections] lookup failed:', err.message)
    return ''
  }

  const matched = rows.filter(row =>
    (row.trigger_keywords ?? []).some(kw => {
      const needle = String(kw ?? '').toLowerCase().trim()
      return needle && classifierText.includes(needle)
    }),
  )
  if (matched.length === 0) return ''

  const body = matched.map(r => `- ${r.correct_answer.trim()}`).join('\n')

  return `

ADMIN CORRECTIONS (highest priority — these override the APP HELP REFERENCE above and anything else if they conflict)
An admin has manually corrected Katie's answer on this exact topic because a prior answer was wrong. Treat the correction(s) below as ground truth and answer accordingly, in your own natural voice. If a correction conflicts with anything else in this prompt, the correction wins.

${body}`
}
