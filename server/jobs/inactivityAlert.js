import nodemailer from 'nodemailer'
import { pool } from '../db.js'

const ADMIN_EMAIL   = 'jason@lwcvip.com'
const INACTIVE_DAYS = 3

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
})

const CHECK_IN_MESSAGE = `Hey. I noticed you haven't logged in a few days.

Life gets full. That's real. And showing up here, even on a hard week, is what separates the woman you're becoming from the one who used to quit.

You don't have to have a perfect day to log. You just have to log.

What's been getting in the way?`

export async function runInactivityAlert() {
  try {
    const { rows: inactive } = await pool.query(`
      SELECT u.id, u.first_name, u.email, MAX(m.logged_at) AS last_meal_at
      FROM users u
      LEFT JOIN meals m ON m.user_id = u.id
      WHERE u.paid = TRUE AND u.onboarding_complete = TRUE
        AND u.created_at < NOW() - INTERVAL '${INACTIVE_DAYS} days'
      GROUP BY u.id, u.first_name, u.email
      HAVING MAX(m.logged_at) < NOW() - INTERVAL '${INACTIVE_DAYS} days'
          OR MAX(m.logged_at) IS NULL
    `)

    if (inactive.length === 0) {
      console.log('[inactivity] No inactive clients.')
      return
    }

    // Send summary email to admin
    const listHtml = inactive.map(u => {
      const lastStr = u.last_meal_at
        ? new Date(u.last_meal_at).toLocaleDateString()
        : 'never'
      return `<li><strong>${u.first_name ?? 'Unknown'}</strong> — last logged: ${lastStr}</li>`
    }).join('')

    if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
      await transporter.sendMail({
        from:    process.env.EMAIL_USER,
        to:      ADMIN_EMAIL,
        subject: `MetaCoach: ${inactive.length} inactive client${inactive.length !== 1 ? 's' : ''}`,
        html:    `<h2>Inactive Clients (no log in ${INACTIVE_DAYS}+ days)</h2><ul>${listHtml}</ul>`,
      })
      console.log(`[inactivity] Admin email sent — ${inactive.length} client(s)`)
    } else {
      console.warn('[inactivity] EMAIL_USER/EMAIL_PASS not set — skipping email')
    }

    // Insert Katie check-in for each user who hasn't received one recently
    for (const user of inactive) {
      const { rows: recent } = await pool.query(
        `SELECT 1 FROM coaching_conversations
         WHERE user_id = $1 AND role = 'assistant'
           AND created_at > NOW() - INTERVAL '${INACTIVE_DAYS} days'
         LIMIT 1`,
        [user.id],
      )
      if (recent.length === 0) {
        await pool.query(
          `INSERT INTO coaching_conversations (user_id, role, message) VALUES ($1, 'assistant', $2)`,
          [user.id, CHECK_IN_MESSAGE],
        )
      }
    }
    console.log(`[inactivity] Check-in messages processed for ${inactive.length} client(s)`)
  } catch (err) {
    console.error('[inactivity] Job failed:', err.message)
  }
}
