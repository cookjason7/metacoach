import { Router } from 'express'
import { requireAuth } from '@clerk/express'
import { pool, isAdminEmail } from '../db.js'
import { sendInviteEmail } from '../services/email.js'
import { getAppBaseUrl } from '../services/appUrl.js'

const router = Router()

// ─── Helpers ──────────────────────────────────────────────────────────────────

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/
// 'trial' is a subscription_status only — never a tier. See TIER_MAX_CLIENTS below.
const TIERS = ['starter', 'pro', 'enterprise']
const STATUSES = ['active', 'trialing', 'past_due', 'cancelled', 'paused']

// max_clients is always derived from tier, never freely set — keeps pricing
// tiers and seat limits from drifting apart.
const TIER_MAX_CLIENTS = { starter: 50, pro: 100, enterprise: 9999 }

// Every route in this file is Jason-only (super admin), not the generic 'admin'
// role — under multi-tenancy every org gets its own 'admin' user, so role alone
// would let an org admin manage other tenants. See isAdminEmail() in db.js.
function requireSuperAdmin(req, res) {
  const email = req.internalUser?.email ?? null
  if (!isAdminEmail(email)) {
    res.status(403).json({ error: 'Super admin only' })
    return false
  }
  return true
}

function slugify(input) {
  return String(input).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/
const FOCUS_AREAS = [
  'weight_loss', 'strength', 'nutrition', 'mindset', 'mobility',
  'performance', 'recovery', 'menopause', 'self_trust', 'consistency',
]

// True when the requesting user may manage their own org's settings: the
// org's 'admin'/'account_owner' role, or the org's owner_user_id even if
// their role is 'coach'. Unlike requireSuperAdmin above, this is scoped to
// req.orgId — it never grants access to a different org.
async function isOrgOwnerOrAdmin(req) {
  const u = req.internalUser
  if (!u) return false
  if (u.role === 'admin' || u.role === 'account_owner') return true
  const { rows } = await pool.query('SELECT owner_user_id FROM organizations WHERE id = $1', [req.orgId])
  return rows.length > 0 && rows[0].owner_user_id === u.id
}

// ─── List ─────────────────────────────────────────────────────────────────────

// GET /api/organizations
router.get('/', requireAuth(), async (req, res, next) => {
  try {
    if (!requireSuperAdmin(req, res)) return

    const { rows } = await pool.query(`
      SELECT
        o.id, o.name, o.slug, o.subscription_tier, o.subscription_status,
        o.is_active, o.trial_ends_at, o.created_at, o.max_clients,
        COUNT(u.id) FILTER (
          WHERE u.role = 'client' AND COALESCE(u.client_status, 'active') != 'deleted'
        )::int AS client_count,
        ow.first_name AS owner_first_name,
        ow.last_name  AS owner_last_name,
        ow.email      AS owner_email
      FROM organizations o
      LEFT JOIN users u  ON u.org_id = o.id
      LEFT JOIN users ow ON ow.id = o.owner_user_id
      GROUP BY o.id, ow.first_name, ow.last_name, ow.email
      ORDER BY o.created_at DESC
    `)
    res.json(rows)
  } catch (err) { next(err) }
})

// ─── Create ───────────────────────────────────────────────────────────────────

// POST /api/organizations
router.post('/', requireAuth(), async (req, res, next) => {
  try {
    if (!requireSuperAdmin(req, res)) return

    const { name, subscription_tier } = req.body
    let { slug } = req.body

    if (!name?.trim()) return res.status(400).json({ error: 'Organization name is required.' })

    slug = slug?.trim() ? slugify(slug) : slugify(name)
    if (!slug || !SLUG_RE.test(slug)) {
      return res.status(400).json({ error: 'Slug must be lowercase letters, numbers, and hyphens only.' })
    }

    const tier = TIERS.includes(subscription_tier) ? subscription_tier : 'starter'
    const maxClients = TIER_MAX_CLIENTS[tier]

    const { rows: existing } = await pool.query('SELECT id FROM organizations WHERE slug = $1', [slug])
    if (existing.length) return res.status(409).json({ error: 'This slug is already taken.' })

    const { rows } = await pool.query(
      `INSERT INTO organizations (name, slug, subscription_tier, subscription_status, max_clients, is_active)
       VALUES ($1, $2, $3, 'active', $4, TRUE)
       RETURNING *`,
      [name.trim(), slug, tier, maxClients],
    )
    res.status(201).json(rows[0])
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'This slug is already taken.' })
    next(err)
  }
})

// ─── Update ───────────────────────────────────────────────────────────────────

// PATCH /api/organizations/:id
router.patch('/:id', requireAuth(), async (req, res, next) => {
  try {
    if (!requireSuperAdmin(req, res)) return
    const id = parseInt(req.params.id, 10)

    const { rows: target } = await pool.query('SELECT id FROM organizations WHERE id = $1', [id])
    if (!target.length) return res.status(404).json({ error: 'Organization not found' })

    const setClauses = []
    const params = []
    const body = req.body

    if ('name' in body) {
      if (!body.name?.trim()) return res.status(400).json({ error: 'Organization name cannot be empty.' })
      params.push(body.name.trim())
      setClauses.push(`name = $${params.length}`)
    }
    if ('slug' in body) {
      const slug = slugify(body.slug)
      if (!slug || !SLUG_RE.test(slug)) {
        return res.status(400).json({ error: 'Slug must be lowercase letters, numbers, and hyphens only.' })
      }
      const { rows: slugRows } = await pool.query('SELECT id FROM organizations WHERE slug = $1 AND id != $2', [slug, id])
      if (slugRows.length) return res.status(409).json({ error: 'This slug is already taken.' })
      params.push(slug)
      setClauses.push(`slug = $${params.length}`)
    }
    // max_clients is derived from tier whenever tier changes — track it here so
    // the standalone max_clients branch below doesn't fight it with a stale value.
    let tierMaxClients = null
    if ('subscription_tier' in body) {
      if (!TIERS.includes(body.subscription_tier)) {
        return res.status(400).json({ error: `subscription_tier must be one of: ${TIERS.join(', ')}` })
      }
      params.push(body.subscription_tier)
      setClauses.push(`subscription_tier = $${params.length}`)
      tierMaxClients = TIER_MAX_CLIENTS[body.subscription_tier]
    }
    if ('subscription_status' in body) {
      if (!STATUSES.includes(body.subscription_status)) {
        return res.status(400).json({ error: `subscription_status must be one of: ${STATUSES.join(', ')}` })
      }
      params.push(body.subscription_status)
      setClauses.push(`subscription_status = $${params.length}`)
    }
    if (tierMaxClients != null) {
      params.push(tierMaxClients)
      setClauses.push(`max_clients = $${params.length}`)
    } else if ('max_clients' in body) {
      const n = Number(body.max_clients)
      if (!Number.isFinite(n) || n <= 0) return res.status(400).json({ error: 'max_clients must be a positive number.' })
      params.push(Math.trunc(n))
      setClauses.push(`max_clients = $${params.length}`)
    }
    if ('is_active' in body) {
      if (id === 1 && body.is_active === false) {
        return res.status(400).json({ error: 'Life Warrior Coaching (org 1) cannot be deactivated.' })
      }
      params.push(Boolean(body.is_active))
      setClauses.push(`is_active = $${params.length}`)
    }
    if ('trial_ends_at' in body) {
      params.push(body.trial_ends_at || null)
      setClauses.push(`trial_ends_at = $${params.length}`)
    }

    if (!setClauses.length) {
      const { rows } = await pool.query('SELECT * FROM organizations WHERE id = $1', [id])
      return res.json(rows[0])
    }

    params.push(id)
    const { rows } = await pool.query(
      `UPDATE organizations SET ${setClauses.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params,
    )
    res.json(rows[0])
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'This slug is already taken.' })
    next(err)
  }
})

// ─── Activate / deactivate ──────────────────────────────────────────────────

// PATCH /api/organizations/:id/activate
router.patch('/:id/activate', requireAuth(), async (req, res, next) => {
  try {
    if (!requireSuperAdmin(req, res)) return
    const id = parseInt(req.params.id, 10)

    const { rows } = await pool.query(
      `UPDATE organizations SET is_active = TRUE, subscription_status = 'active'
       WHERE id = $1 RETURNING *`,
      [id],
    )
    if (!rows.length) return res.status(404).json({ error: 'Organization not found' })
    res.json(rows[0])
  } catch (err) { next(err) }
})

// PATCH /api/organizations/:id/deactivate
router.patch('/:id/deactivate', requireAuth(), async (req, res, next) => {
  try {
    if (!requireSuperAdmin(req, res)) return
    const id = parseInt(req.params.id, 10)

    if (id === 1) {
      return res.status(400).json({ error: 'Life Warrior Coaching (org 1) cannot be deactivated.' })
    }

    const { rows } = await pool.query(
      `UPDATE organizations SET is_active = FALSE, subscription_status = 'paused'
       WHERE id = $1 RETURNING *`,
      [id],
    )
    if (!rows.length) return res.status(404).json({ error: 'Organization not found' })
    res.json(rows[0])
  } catch (err) { next(err) }
})

// ─── Stats ────────────────────────────────────────────────────────────────────

// GET /api/organizations/:id/stats
router.get('/:id/stats', requireAuth(), async (req, res, next) => {
  try {
    if (!requireSuperAdmin(req, res)) return
    const id = parseInt(req.params.id, 10)

    const { rows: orgRows } = await pool.query('SELECT id FROM organizations WHERE id = $1', [id])
    if (!orgRows.length) return res.status(404).json({ error: 'Organization not found' })

    const { rows } = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM users
          WHERE org_id = $1 AND role = 'client' AND COALESCE(client_status, 'active') != 'deleted')::int AS client_count,
        (SELECT COUNT(*) FROM users
          WHERE org_id = $1 AND role IN ('coach', 'admin'))::int AS coach_count,
        (SELECT COUNT(*) FROM coach_assigned_habits
          WHERE org_id = $1 AND active = TRUE)::int AS active_habits_count,
        (SELECT COUNT(*) FROM client_messages
          WHERE org_id = $1 AND created_at >= NOW() - INTERVAL '30 days')::int AS messages_last_30_days
    `, [id])
    res.json(rows[0])
  } catch (err) { next(err) }
})

// ─── Invite org owner ───────────────────────────────────────────────────────

// POST /api/organizations/:id/invite-owner
// Creates a staff_invites row (role='admin') scoped to this org via org_id, so
// getOrCreateUser() places the accepting user in the right org instead of the
// LWC default. Reuses the existing /staff-invite/:token accept flow unchanged.
router.post('/:id/invite-owner', requireAuth(), async (req, res, next) => {
  try {
    if (!requireSuperAdmin(req, res)) return
    const id = parseInt(req.params.id, 10)
    const inviterId = req.internalUser.id

    const { rows: orgRows } = await pool.query('SELECT id, name FROM organizations WHERE id = $1', [id])
    if (!orgRows.length) return res.status(404).json({ error: 'Organization not found' })

    const { first_name, last_name, email } = req.body
    if (!first_name?.trim()) return res.status(400).json({ error: 'First name is required.' })
    if (!email?.trim())      return res.status(400).json({ error: 'Email is required.' })

    const normalizedEmail = email.trim().toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' })
    }

    const { rows: existingUser } = await pool.query(
      `SELECT id FROM users WHERE LOWER(email) = $1`,
      [normalizedEmail],
    )
    if (existingUser.length > 0) {
      return res.status(409).json({ error: 'A user with this email already exists in the system.' })
    }

    await pool.query(
      `DELETE FROM staff_invites WHERE LOWER(email) = $1 AND accepted_at IS NULL`,
      [normalizedEmail],
    )

    const { rows: [invite] } = await pool.query(
      `INSERT INTO staff_invites (email, first_name, last_name, role, invited_by, org_id)
       VALUES ($1, $2, $3, 'admin', $4, $5)
       RETURNING token, email, first_name, last_name, created_at, expires_at`,
      [normalizedEmail, first_name.trim(), last_name?.trim() || null, inviterId, id],
    )

    const appUrl = getAppBaseUrl()
    const inviteUrl = `${appUrl}/staff-invite/${invite.token}`

    let emailResult = { sent: false, reason: 'Email send skipped' }
    try {
      emailResult = await Promise.race([
        sendInviteEmail({ to: invite.email, firstName: invite.first_name, inviteUrl }),
        new Promise(resolve => setTimeout(() => resolve({ sent: false, reason: 'Email send timed out' }), 12_000)),
      ])
    } catch (emailErr) {
      emailResult = { sent: false, reason: emailErr.message ?? 'Email send failed' }
    }

    res.status(201).json({
      ok:         true,
      invite_url: inviteUrl,
      email_sent: emailResult.sent,
      email_note: emailResult.sent ? null : emailResult.reason,
      first_name: invite.first_name,
      last_name:  invite.last_name,
      email:      invite.email,
    })
  } catch (err) { next(err) }
})

// ─── Org owner / org admin self-service ("mine") ──────────────────────────────
// These routes are scoped to req.orgId (set by orgContext middleware) rather
// than gated by isAdminEmail — under multi-tenancy every org's own owner/admin
// needs to manage their own org, just never anyone else's.

// GET /api/organizations/mine — any authenticated user, returns their own org
router.get('/mine', requireAuth(), async (req, res, next) => {
  try {
    const orgId = req.orgId
    const { rows } = await pool.query(`
      SELECT
        o.*,
        ow.first_name AS owner_first_name,
        ow.last_name  AS owner_last_name,
        ow.email      AS owner_email,
        (SELECT COUNT(*) FROM users
          WHERE org_id = o.id AND role = 'client' AND COALESCE(client_status, 'active') != 'deleted')::int AS client_count,
        (SELECT COUNT(*) FROM users
          WHERE org_id = o.id AND role IN ('coach', 'admin'))::int AS coach_count
      FROM organizations o
      LEFT JOIN users ow ON ow.id = o.owner_user_id
      WHERE o.id = $1
    `, [orgId])
    if (!rows.length) return res.status(404).json({ error: 'Organization not found' })
    res.json(rows[0])
  } catch (err) { next(err) }
})

// PATCH /api/organizations/mine — org owner/admin only. slug, tier, max_clients,
// and subscription_status are deliberately not in `allowed` — those stay Jason-only
// via the /:id route above.
router.patch('/mine', requireAuth(), async (req, res, next) => {
  try {
    if (!await isOrgOwnerOrAdmin(req)) return res.status(403).json({ error: 'Admin only' })
    const orgId = req.orgId

    const allowed = ['name', 'logo_url', 'primary_color', 'brand_name', 'ai_coach_name']
    const setClauses = []
    const params = []
    for (const key of allowed) {
      if (!(key in req.body)) continue
      let value = req.body[key]
      if (key === 'name' && !String(value ?? '').trim()) {
        return res.status(400).json({ error: 'Organization name cannot be empty.' })
      }
      if (key === 'primary_color' && value && !HEX_COLOR_RE.test(value)) {
        return res.status(400).json({ error: 'Primary color must be a hex value like #f97316.' })
      }
      value = typeof value === 'string' ? (value.trim() || null) : value
      params.push(value)
      setClauses.push(`${key} = $${params.length}`)
    }

    if (!setClauses.length) {
      const { rows } = await pool.query('SELECT * FROM organizations WHERE id = $1', [orgId])
      return res.json(rows[0])
    }

    params.push(orgId)
    const { rows } = await pool.query(
      `UPDATE organizations SET ${setClauses.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params,
    )
    res.json(rows[0])
  } catch (err) { next(err) }
})

// GET /api/organizations/mine/ai-config — any authenticated user; creates a
// default row on first access so the org always has one to read/edit.
router.get('/mine/ai-config', requireAuth(), async (req, res, next) => {
  try {
    const orgId = req.orgId
    let { rows } = await pool.query('SELECT * FROM org_ai_config WHERE org_id = $1', [orgId])
    if (!rows.length) {
      const inserted = await pool.query(
        `INSERT INTO org_ai_config (org_id) VALUES ($1)
         ON CONFLICT (org_id) DO UPDATE SET org_id = EXCLUDED.org_id
         RETURNING *`,
        [orgId],
      )
      rows = inserted.rows
    }
    res.json(rows[0])
  } catch (err) { next(err) }
})

// PATCH /api/organizations/mine/ai-config — org owner/admin only
router.patch('/mine/ai-config', requireAuth(), async (req, res, next) => {
  try {
    if (!await isOrgOwnerOrAdmin(req)) return res.status(403).json({ error: 'Admin only' })
    const orgId = req.orgId

    // Guarantee a row exists before the UPDATE below (mirrors the GET route).
    await pool.query(
      `INSERT INTO org_ai_config (org_id) VALUES ($1) ON CONFLICT (org_id) DO NOTHING`,
      [orgId],
    )

    const allowed = ['coach_name', 'coaching_philosophy', 'tone_instructions', 'focus_areas', 'restricted_topics', 'custom_greeting']
    const setClauses = []
    const params = []
    for (const key of allowed) {
      if (!(key in req.body)) continue
      let value = req.body[key]
      if (key === 'focus_areas') {
        if (!Array.isArray(value)) return res.status(400).json({ error: 'focus_areas must be an array.' })
        value = value.filter(v => FOCUS_AREAS.includes(v))
      }
      if (typeof value === 'string') value = value.trim() || null
      params.push(value)
      setClauses.push(`${key} = $${params.length}`)
    }

    if (!setClauses.length) {
      const { rows } = await pool.query('SELECT * FROM org_ai_config WHERE org_id = $1', [orgId])
      return res.json(rows[0])
    }

    params.push(orgId)
    const { rows } = await pool.query(
      `UPDATE org_ai_config SET ${setClauses.join(', ')} WHERE org_id = $${params.length} RETURNING *`,
      params,
    )
    res.json(rows[0])
  } catch (err) { next(err) }
})

// GET /api/organizations/mine/dashboard — summary stats for the org owner dashboard
router.get('/mine/dashboard', requireAuth(), async (req, res, next) => {
  try {
    const orgId = req.orgId
    const { rows } = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM users
          WHERE org_id = $1 AND role = 'client' AND COALESCE(client_status, 'active') != 'deleted')::int AS total_clients,
        (SELECT COUNT(*) FROM users
          WHERE org_id = $1 AND role = 'client' AND COALESCE(client_status, 'active') != 'deleted'
            AND last_login_at >= NOW() - INTERVAL '7 days')::int AS active_clients,
        (SELECT COUNT(*) FROM users
          WHERE org_id = $1 AND role IN ('coach', 'admin'))::int AS total_coaches,
        (SELECT COUNT(*) FROM client_messages
          WHERE org_id = $1 AND created_at >= NOW() - INTERVAL '7 days')::int AS messages_this_week,
        (SELECT COUNT(*) FROM habit_completions
          WHERE org_id = $1 AND completion_percentage >= 100
            AND completion_date >= CURRENT_DATE - INTERVAL '7 days')::int AS habits_completed_this_week,
        (SELECT COUNT(*) FROM users
          WHERE org_id = $1 AND role = 'client' AND COALESCE(client_status, 'active') != 'deleted'
            AND created_at >= DATE_TRUNC('month', NOW()))::int AS new_clients_this_month
    `, [orgId])
    res.json(rows[0])
  } catch (err) { next(err) }
})

// GET /api/organizations/mine/recent-clients — last 5 clients who logged in, for
// the org dashboard's Recent Activity section.
router.get('/mine/recent-clients', requireAuth(), async (req, res, next) => {
  try {
    const orgId = req.orgId
    const { rows } = await pool.query(`
      SELECT
        id,
        COALESCE(NULLIF(TRIM(CONCAT_WS(' ', first_name, last_name)), ''), NULLIF(name, ''), email, 'Client') AS name,
        last_login_at
      FROM users
      WHERE org_id = $1 AND role = 'client' AND COALESCE(client_status, 'active') != 'deleted'
        AND last_login_at IS NOT NULL
      ORDER BY last_login_at DESC
      LIMIT 5
    `, [orgId])
    res.json(rows)
  } catch (err) { next(err) }
})

export default router
