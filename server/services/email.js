import nodemailer from 'nodemailer'

// Email send timeout — prevents SMTP hangs from blocking API responses
const EMAIL_TIMEOUT_MS = 8_000

function createTransporter() {
  return nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
    connectionTimeout: EMAIL_TIMEOUT_MS,
    greetingTimeout:   EMAIL_TIMEOUT_MS,
    socketTimeout:     EMAIL_TIMEOUT_MS,
  })
}

/**
 * Send an email. Returns { sent: true } or { sent: false, reason: string }.
 * Never throws — caller decides how to handle failure.
 * Hard-capped at EMAIL_TIMEOUT_MS so a slow/hanging SMTP server never
 * blocks the HTTP response.
 */
export async function sendEmail({ to, subject, html, text }) {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    console.warn('[email] EMAIL_USER/EMAIL_PASS not configured — email not sent')
    return { sent: false, reason: 'Email credentials not configured on server.' }
  }
  try {
    const transporter = createTransporter()

    const sendPromise = transporter.sendMail({
      from:    `"Life Warrior Coaching" <${process.env.EMAIL_USER}>`,
      to,
      subject,
      html,
      text,
    })

    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Email timed out after ${EMAIL_TIMEOUT_MS / 1000}s`)), EMAIL_TIMEOUT_MS),
    )

    await Promise.race([sendPromise, timeoutPromise])
    console.log(`[email] Sent to ${to}: ${subject}`)
    return { sent: true }
  } catch (err) {
    console.error('[email] Send failed:', err.message)
    return { sent: false, reason: err.message }
  }
}
