import express from 'express'
import { Router } from 'express'
import Stripe from 'stripe'
import { pool } from '../db.js'
import { sendAiSetupEmail } from '../services/email.js'

const router = Router()

// POST /api/stripe/webhook
// IMPORTANT: must be mounted BEFORE app.use(express.json()) in index.js
// Stripe requires the raw request body to verify the webhook signature.
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig           = req.headers['stripe-signature']
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET
  const secretKey     = process.env.STRIPE_SECRET_KEY

  if (!webhookSecret || !secretKey) {
    console.warn('[stripe] STRIPE_SECRET_KEY or STRIPE_WEBHOOK_SECRET not set — webhook skipped')
    return res.sendStatus(200)
  }

  let event
  try {
    const stripe = new Stripe(secretKey)
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret)
  } catch (err) {
    console.error('[stripe] Webhook signature verification failed:', err.message)
    return res.status(400).send(`Webhook Error: ${err.message}`)
  }

  if (event.type !== 'checkout.session.completed') {
    return res.sendStatus(200)
  }

  const session = event.data.object

  // Only handle paid sessions
  if (session.payment_status !== 'paid') {
    return res.sendStatus(200)
  }

  const email = (session.customer_details?.email ?? session.customer_email ?? '').trim().toLowerCase()
  if (!email) {
    console.warn('[stripe] checkout.session.completed missing email, session:', session.id)
    return res.sendStatus(200)
  }

  const fullName  = session.customer_details?.name ?? ''
  const nameParts = fullName.trim().split(/\s+/)
  const firstName = nameParts[0] || 'there'
  const lastName  = nameParts.slice(1).join(' ') || null

  try {
    // Replace any stale unaccepted invite for this email so they always get a fresh link
    await pool.query(
      `DELETE FROM client_invites WHERE LOWER(email) = $1 AND accepted_at IS NULL`,
      [email],
    )

    const { rows: [invite] } = await pool.query(
      `INSERT INTO client_invites
         (email, first_name, last_name, coaching_type, notes)
       VALUES ($1, $2, $3, 'ai', 'AI coaching — Stripe purchase')
       RETURNING token, email, first_name`,
      [email, firstName, lastName],
    )

    await pool.query(
      `UPDATE users
       SET coaching_type = 'ai',
           coaching_type_source = 'stripe_ai',
           paid = TRUE,
           paid_at = COALESCE(paid_at, NOW())
       WHERE LOWER(email) = $1
         AND COALESCE(role, 'client') = 'client'
         AND COALESCE(coaching_type_source, '') != 'manual'`,
      [email],
    )

    const appUrl  = process.env.APP_BASE_URL ?? 'https://app.lwcvip.com'
    const setupUrl = `${appUrl}/invite/${invite.token}`

    const emailResult = await sendAiSetupEmail({
      to:        invite.email,
      firstName: invite.first_name,
      setupUrl,
    })

    console.log(
      `[stripe] AI invite created for ${email} — email sent: ${emailResult.sent}` +
      (emailResult.reason ? ` (${emailResult.reason})` : ''),
    )
  } catch (err) {
    console.error('[stripe] Failed to process AI purchase for', email, ':', err.message)
    // Return 200 anyway — retrying won't fix a DB/email error, and Stripe will
    // stop retrying after N failures if we keep returning 5xx.
  }

  res.sendStatus(200)
})

// GET /api/stripe/session-setup-link?session_id=cs_xxx
// Verifies the Stripe session is paid, then finds or creates the AI invite
// so the buyer can set up their account immediately on the /ai-welcome page.
router.get('/session-setup-link', async (req, res, next) => {
  try {
    const { session_id } = req.query
    if (!session_id) return res.status(400).json({ error: 'session_id is required' })

    const secretKey = process.env.STRIPE_SECRET_KEY
    if (!secretKey) return res.status(503).json({ error: 'Payment service not configured.' })

    const stripe = new Stripe(secretKey)
    let session
    try {
      session = await stripe.checkout.sessions.retrieve(session_id)
    } catch {
      return res.status(400).json({ error: 'Invalid session ID.' })
    }

    if (session.payment_status !== 'paid') {
      return res.status(402).json({ error: 'Payment not completed.' })
    }

    const email = (session.customer_details?.email ?? session.customer_email ?? '').trim().toLowerCase()
    if (!email) return res.status(400).json({ error: 'No email found for this session.' })

    // Find existing unaccepted AI invite (webhook may have already created it)
    const { rows } = await pool.query(
      `SELECT token FROM client_invites
       WHERE LOWER(email) = $1 AND coaching_type = 'ai' AND accepted_at IS NULL
       ORDER BY created_at DESC LIMIT 1`,
      [email],
    )

    let token
    if (rows.length) {
      token = rows[0].token
    } else {
      // Webhook hasn't fired yet — provision invite now so buyer isn't blocked
      const fullName  = session.customer_details?.name ?? ''
      const parts     = fullName.trim().split(/\s+/)
      const firstName = parts[0] || 'there'
      const lastName  = parts.slice(1).join(' ') || null
      const { rows: [invite] } = await pool.query(
        `INSERT INTO client_invites (email, first_name, last_name, coaching_type, notes)
         VALUES ($1, $2, $3, 'ai', 'AI coaching — Stripe purchase (session lookup)')
         RETURNING token`,
        [email, firstName, lastName],
      )
      token = invite.token
    }

    await pool.query(
      `UPDATE users
       SET coaching_type = 'ai',
           coaching_type_source = 'stripe_ai',
           paid = TRUE,
           paid_at = COALESCE(paid_at, NOW())
       WHERE LOWER(email) = $1
         AND COALESCE(role, 'client') = 'client'
         AND COALESCE(coaching_type_source, '') != 'manual'`,
      [email],
    )

    const appUrl = process.env.APP_BASE_URL ?? 'https://app.lwcvip.com'
    res.json({ setupUrl: `${appUrl}/invite/${token}` })
  } catch (err) { next(err) }
})

export default router
