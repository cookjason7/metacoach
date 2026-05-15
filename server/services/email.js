import nodemailer from 'nodemailer'

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
})

/**
 * Send an email. Returns { sent: true } or { sent: false, reason: string }.
 * Never throws — caller decides how to handle failure.
 */
export async function sendEmail({ to, subject, html, text }) {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    console.warn('[email] EMAIL_USER/EMAIL_PASS not configured — email not sent')
    return { sent: false, reason: 'Email credentials not configured on server.' }
  }
  try {
    await transporter.sendMail({
      from:    `"Life Warrior Coaching" <${process.env.EMAIL_USER}>`,
      to,
      subject,
      html,
      text,
    })
    console.log(`[email] Sent to ${to}: ${subject}`)
    return { sent: true }
  } catch (err) {
    console.error('[email] Send failed:', err.message)
    return { sent: false, reason: err.message }
  }
}
