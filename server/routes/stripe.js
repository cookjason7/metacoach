import express from 'express'
import { Router } from 'express'
import Stripe from 'stripe'
import { pool } from '../db.js'
import { sendAiSetupEmail } from '../services/email.js'
import { getAppBaseUrl } from '../services/appUrl.js'

const router = Router()

function idFromStripeValue(value) {
  if (!value) return null
  if (typeof value === 'string') return value
  return value.id ?? null
}

function logSkippedAiSession(session, reason) {
  console.log('[stripe] skipped non-AI checkout session', {
    reason,
    session_id: session?.id ?? null,
    payment_link: idFromStripeValue(session?.payment_link),
    mode: session?.mode ?? null,
    metadata_keys: Object.keys(session?.metadata ?? {}),
  })
}

async function sessionHasAllowedLineItem(stripe, session) {
  const allowedPriceId = process.env.STRIPE_AI_PRICE_ID
  const allowedProductId = process.env.STRIPE_AI_PRODUCT_ID
  if (!allowedPriceId && !allowedProductId) return false

  const lineItems = await stripe.checkout.sessions.listLineItems(session.id, {
    limit: 100,
    expand: ['data.price.product'],
  })

  return lineItems.data.some(item => {
    const price = item.price
    const productId = idFromStripeValue(price?.product)
    return (allowedPriceId && price?.id === allowedPriceId) ||
      (allowedProductId && productId === allowedProductId)
  })
}

// AI coaching sessions must match one of these app-specific identifiers:
//   STRIPE_AI_PAYMENT_LINK_ID - expected Checkout Payment Link id (plink_...)
//   STRIPE_AI_PRICE_ID        - optional expected Stripe Price id (price_...)
//   STRIPE_AI_PRODUCT_ID      - optional expected Stripe Product id (prod_...)
//   STRIPE_AI_CHECKOUT_MODE   - optional expected Checkout mode, such as payment or subscription
// Dashboard metadata app=metacoach and product=ai_coaching is also accepted.
async function isAiCoachingSession(stripe, session) {
  if (session.payment_status !== 'paid') {
    return { ok: false, reason: 'not_paid' }
  }

  const expectedMode = process.env.STRIPE_AI_CHECKOUT_MODE
  if (expectedMode && session.mode !== expectedMode) {
    return { ok: false, reason: 'mode_mismatch' }
  }

  const paymentLinkId = idFromStripeValue(session.payment_link)
  if (process.env.STRIPE_AI_PAYMENT_LINK_ID && paymentLinkId === process.env.STRIPE_AI_PAYMENT_LINK_ID) {
    return { ok: true, reason: 'payment_link' }
  }

  if (session.metadata?.app === 'metacoach' && session.metadata?.product === 'ai_coaching') {
    return { ok: true, reason: 'metadata' }
  }

  if (await sessionHasAllowedLineItem(stripe, session)) {
    return { ok: true, reason: 'line_item' }
  }

  return { ok: false, reason: 'no_matching_ai_identifier' }
}

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
  const stripe = new Stripe(secretKey)
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret)
  } catch (err) {
    console.error('[stripe] Webhook signature verification failed:', err.message)
    return res.status(400).send(`Webhook Error: ${err.message}`)
  }

  if (event.type !== 'checkout.session.completed') {
    return res.sendStatus(200)
  }

  const session = event.data.object

  const eligibility = await isAiCoachingSession(stripe, session)
  if (!eligibility.ok) {
    logSkippedAiSession(session, eligibility.reason)
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

    // org_id 1: this webhook is backed by a single STRIPE_SECRET_KEY — Life
    // Warrior Coaching's own account selling its own AI coaching — so every
    // buyer arriving here is an org 1 client. Set explicitly rather than left
    // NULL so the invite carries a real org into claimInvite; revisit when
    // per-org billing (org-specific Stripe accounts) exists.
    const { rows: [invite] } = await pool.query(
      `INSERT INTO client_invites
         (email, first_name, last_name, coaching_type, notes, org_id)
       VALUES ($1, $2, $3, 'hybrid', 'AI coaching — Stripe purchase', 1)
       RETURNING token, email, first_name`,
      [email, firstName, lastName],
    )

    await pool.query(
      `UPDATE users
       SET coaching_type = 'hybrid',
           coaching_type_source = 'stripe_ai',
           paid = TRUE,
           paid_at = COALESCE(paid_at, NOW()),
           -- A purchase lifts the no-invite signup gate (see getOrCreateUser)
           client_status = CASE WHEN client_status = 'pending_access' THEN 'active' ELSE client_status END
       WHERE LOWER(email) = $1
         AND COALESCE(role, 'client') = 'client'
         AND COALESCE(coaching_type_source, '') != 'manual'`,
      [email],
    )

    const appUrl  = getAppBaseUrl()
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

    const eligibility = await isAiCoachingSession(stripe, session)
    if (!eligibility.ok) {
      logSkippedAiSession(session, eligibility.reason)
      return res.status(403).json({ error: 'This payment is not eligible for AI coaching setup.' })
    }

    const email = (session.customer_details?.email ?? session.customer_email ?? '').trim().toLowerCase()
    if (!email) return res.status(400).json({ error: 'No email found for this session.' })

    // Find existing unaccepted AI-coaching invite (webhook may have already
    // created it). Matches 'hybrid' (what we write now) and 'ai' (the legacy
    // value) so an invite minted before the consolidation still resolves here
    // instead of silently provisioning a duplicate.
    const { rows } = await pool.query(
      `SELECT token FROM client_invites
       WHERE LOWER(email) = $1 AND coaching_type IN ('hybrid', 'ai') AND accepted_at IS NULL
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
      // org_id 1 for the same reason as the webhook path above.
      const { rows: [invite] } = await pool.query(
        `INSERT INTO client_invites (email, first_name, last_name, coaching_type, notes, org_id)
         VALUES ($1, $2, $3, 'hybrid', 'AI coaching — Stripe purchase (session lookup)', 1)
         RETURNING token`,
        [email, firstName, lastName],
      )
      token = invite.token
    }

    await pool.query(
      `UPDATE users
       SET coaching_type = 'hybrid',
           coaching_type_source = 'stripe_ai',
           paid = TRUE,
           paid_at = COALESCE(paid_at, NOW()),
           -- A purchase lifts the no-invite signup gate (see getOrCreateUser)
           client_status = CASE WHEN client_status = 'pending_access' THEN 'active' ELSE client_status END
       WHERE LOWER(email) = $1
         AND COALESCE(role, 'client') = 'client'
         AND COALESCE(coaching_type_source, '') != 'manual'`,
      [email],
    )

    const appUrl = getAppBaseUrl()
    res.json({ setupUrl: `${appUrl}/invite/${token}` })
  } catch (err) { next(err) }
})

export default router
