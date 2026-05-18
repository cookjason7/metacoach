import { Router } from 'express'
import { requireAuth, getAuth } from '@clerk/express'
import { pool, getOrCreateUser } from '../db.js'
import { sendInviteEmail } from '../services/email.js'

const router = Router()

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function getCurrentStaff(req) {
  const { userId } = getAuth(req)
  const dbUserId = await getOrCreateUser(userId)
  const { rows } = await pool.query('SELECT id, role FROM users WHERE id = $1', [dbUserId])
  return { dbUserId, role: rows[0]?.role ?? 'client' }
}

async function requireStaff(req, res) {
  const ctx = await getCurrentStaff(req)
  if (ctx.role !== 'admin' && ctx.role !== 'coach') {
    res.status(403).json({ error: 'Staff only' })
    return null
  }
  return ctx
}

async function requireAdmin(req, res) {
  const ctx = await getCurrentStaff(req)
  if (ctx.role !== 'admin') {
    res.status(403).json({ error: 'Admin only' })
    return null
  }
  return ctx
}

// Returns true if staff member (admin or coach) can access this client
async function canAccessClient(ctx, clientId) {
  if (ctx.role === 'admin') return true
  const { rows } = await pool.query(
    'SELECT id FROM users WHERE id = $1 AND assigned_coach_id = $2',
    [clientId, ctx.dbUserId],
  )
  return rows.length > 0
}

// Internal supportive status tag — never use shame words
function computeStatusTag(client) {
  // Invited = accepted invite, assessment not yet complete
  if (client.client_status === 'invited') return 'Invited'
  if (!client.onboarding_complete || !client.assessment_complete) return 'New Client'
  const adh7  = Number(client.adherence_7d  || 0)
  const adh30 = Number(client.adherence_30d || 0)
  if (adh7 >= 80) return 'Consistent'
  if (adh7 >= 50) return 'Building Momentum'
  if (adh30 >= 50 && adh7 < 30) return 'Needs Attention'
  if (adh7 > adh30) return 'Rebuilding Momentum'
  return 'Building Momentum'
}

// Same supportive language for momentum
function computeMomentum(adh7, adh30) {
  if (adh7 >= 90) return 'Locked In'
  if (adh7 >= 75) return 'Strong'
  if (adh7 >= 50) return 'Stable'
  if (adh7 < 30 && adh30 > adh7) return 'Rebuilding Momentum'
  return 'Building'
}

// ─── Clients list ─────────────────────────────────────────────────────────────

// GET /api/coach-admin/clients?status=active|archived|all (default active)
router.get('/clients', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const params = []
    let where = `WHERE u.role IN ('client', 'admin') AND COALESCE(u.client_status, 'active') != 'deleted'`

    const statusFilter = req.query.status ?? 'active'
    if (statusFilter === 'active') {
      where += ` AND COALESCE(u.client_status, 'active') = 'active'`
    } else if (statusFilter === 'archived') {
      where += ` AND u.client_status = 'archived'`
    } else if (statusFilter === 'invited') {
      where += ` AND u.client_status = 'invited'`
    }
    // 'all' → no extra filter (still excludes deleted)

    if (ctx.role === 'coach') {
      params.push(ctx.dbUserId)
      where += ` AND u.assigned_coach_id = $${params.length}`
    }

    const { rows } = await pool.query(`
      SELECT
        u.id,
        COALESCE(u.first_name, ha.first_name,
          CASE WHEN u.name IS NOT NULL THEN SPLIT_PART(u.name, ' ', 1) END
        ) AS first_name,
        COALESCE(ha.last_name,
          CASE WHEN u.name LIKE '% %'
            THEN LTRIM(SUBSTRING(u.name FROM POSITION(' ' IN u.name)))
          END
        ) AS display_last_name,
        COALESCE(u.phone_number, ha.phone)            AS phone_number,
        u.email,
        u.coaching_type, u.assigned_coach_id, u.role,
        u.onboarding_complete, u.assessment_complete,
        u.last_login_at, u.start_date, u.paid, u.paid_at, u.created_at,
        u.client_status, u.archived_at,
        -- Effective start date: explicit start_date → paid_at → created_at
        COALESCE(u.start_date, u.paid_at::date, u.created_at::date) AS effective_start_date,
        (SELECT first_name FROM users WHERE id = u.assigned_coach_id) AS assigned_coach_name,
        (SELECT email      FROM users WHERE id = u.assigned_coach_id) AS assigned_coach_email,
        (SELECT MAX(logged_at) FROM meals WHERE user_id = u.id) AS last_meal_at,
        COALESCE((
          SELECT AVG(completion_percentage)::numeric(5,1)
          FROM habit_completions hc
          WHERE hc.user_id = u.id AND hc.completion_date >= CURRENT_DATE - INTERVAL '7 days'
        ), 0) AS adherence_7d,
        COALESCE((
          SELECT AVG(completion_percentage)::numeric(5,1)
          FROM habit_completions hc
          WHERE hc.user_id = u.id AND hc.completion_date >= CURRENT_DATE - INTERVAL '30 days'
        ), 0) AS adherence_30d
      FROM users u
      LEFT JOIN health_assessments ha ON ha.user_id = u.id
      ${where}
      ORDER BY COALESCE(u.first_name, ha.first_name,
        CASE WHEN u.name IS NOT NULL THEN SPLIT_PART(u.name, ' ', 1) END
      ) ASC NULLS LAST
    `, params)

    res.json(rows.map(r => ({ ...r, status_tag: computeStatusTag(r) })))
  } catch (err) { next(err) }
})

// GET /api/coach-admin/coaches — list available coaches for assignment dropdown
router.get('/coaches', requireAuth(), async (req, res, next) => {
  try {
    if (await requireAdmin(req, res) === null) return
    const { rows } = await pool.query(`
      SELECT id, first_name, email FROM users
      WHERE role IN ('coach', 'admin')
      ORDER BY first_name ASC NULLS LAST
    `)
    res.json(rows)
  } catch (err) { next(err) }
})

// GET /api/coach-admin/dashboard-summary — staff dashboard review queues
router.get('/dashboard-summary', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const params = []
    let clientScope = `u.role = 'client' AND COALESCE(u.client_status, 'active') != 'deleted'`
    if (ctx.role === 'coach') {
      params.push(ctx.dbUserId)
      clientScope += ` AND u.assigned_coach_id = $${params.length}`
    }

    const accessibleClients = `
      SELECT
        u.id,
        COALESCE(
          NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), ''),
          NULLIF(u.name, ''),
          u.email,
          'Client'
        ) AS client_name
      FROM users u
      WHERE ${clientScope}
    `

    const [checkins, activity] = await Promise.all([
      pool.query(`
        WITH accessible_clients AS (${accessibleClients})
        SELECT
          fs.id AS submission_id,
          fs.user_id AS client_id,
          ac.client_name,
          ft.title AS form_title,
          fs.submitted_at,
          COALESCE(fa.send_at, fa.sent_at, fa.next_send_at) AS due_at,
          CASE WHEN fs.reviewed_at IS NULL THEN 'Needs review' ELSE 'Reviewed' END AS status
        FROM form_submissions fs
        JOIN accessible_clients ac ON ac.id = fs.user_id
        JOIN form_templates ft ON ft.id = fs.template_id
        LEFT JOIN form_assignments fa ON fa.id = fs.assignment_id
        WHERE fs.reviewed_at IS NULL
          AND (LOWER(ft.title) LIKE '%check-in%' OR LOWER(ft.title) LIKE '%check in%')
        ORDER BY fs.submitted_at DESC
        LIMIT 8
      `, params),
      pool.query(`
        WITH accessible_clients AS (${accessibleClients}),
        events AS (
          SELECT m.user_id AS client_id, ac.client_name, m.logged_at AS occurred_at,
                 'meal' AS type, 'Logged meal: ' || m.meal_name AS label
          FROM meals m
          JOIN accessible_clients ac ON ac.id = m.user_id
          WHERE m.logged_at >= NOW() - INTERVAL '14 days'

          UNION ALL

          SELECT dl.user_id AS client_id, ac.client_name, dl.logged_date::timestamptz AS occurred_at,
                 'daily_log' AS type,
                 'Updated ' || CONCAT_WS(', ',
                   CASE WHEN dl.water_oz IS NOT NULL THEN 'water' END,
                   CASE WHEN dl.steps IS NOT NULL THEN 'steps' END,
                   CASE WHEN dl.weight_lbs IS NOT NULL THEN 'weight' END
                 ) AS label
          FROM daily_logs dl
          JOIN accessible_clients ac ON ac.id = dl.user_id
          WHERE dl.logged_date >= CURRENT_DATE - INTERVAL '14 days'
            AND (dl.water_oz IS NOT NULL OR dl.steps IS NOT NULL OR dl.weight_lbs IS NOT NULL)

          UNION ALL

          SELECT fs.user_id AS client_id, ac.client_name, fs.submitted_at AS occurred_at,
                 'form' AS type, 'Submitted form: ' || ft.title AS label
          FROM form_submissions fs
          JOIN accessible_clients ac ON ac.id = fs.user_id
          JOIN form_templates ft ON ft.id = fs.template_id
          WHERE fs.submitted_at >= NOW() - INTERVAL '30 days'

          UNION ALL

          SELECT m.client_id, ac.client_name, m.created_at AS occurred_at,
                 'message' AS type,
                 CASE WHEN m.image_url IS NOT NULL AND COALESCE(m.message_body, '') = '' THEN 'Sent photo message'
                      ELSE 'Sent message'
                 END AS label
          FROM client_messages m
          JOIN accessible_clients ac ON ac.id = m.client_id
          WHERE m.sender_role = 'client'
            AND m.created_at >= NOW() - INTERVAL '14 days'

          UNION ALL

          SELECT pp.user_id AS client_id, ac.client_name, pp.taken_at AS occurred_at,
                 'photo' AS type, 'Uploaded progress photo' AS label
          FROM progress_photos pp
          JOIN accessible_clients ac ON ac.id = pp.user_id
          WHERE pp.taken_at >= NOW() - INTERVAL '30 days'

          UNION ALL

          SELECT al.user_id AS client_id, ac.client_name, al.logged_at AS occurred_at,
                 'activity' AS type, 'Logged activity: ' || al.activity_type AS label
          FROM activity_logs al
          JOIN accessible_clients ac ON ac.id = al.user_id
          WHERE al.logged_at >= NOW() - INTERVAL '30 days'
        )
        SELECT client_id, client_name, occurred_at, type, label
        FROM events
        WHERE occurred_at IS NOT NULL
        ORDER BY occurred_at DESC
        LIMIT 12
      `, params),
    ])

    res.json({ checkins: checkins.rows, activity: activity.rows })
  } catch (err) { next(err) }
})

// ─── VIP Client Invite ────────────────────────────────────────────────────────

// POST /api/coach-admin/clients/invite — admin only, creates invite record + sends email
// GET /api/coach-admin/team?status=active|archived — staff-visible coach/admin summary
router.get('/team', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const statusFilter = req.query.status === 'archived' ? 'archived' : 'active'
    const { rows } = await pool.query(`
      SELECT
        u.id,
        COALESCE(
          NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), ''),
          NULLIF(u.name, ''),
          u.email,
          'Staff'
        ) AS name,
        u.email,
        u.role,
        u.last_login_at,
        COALESCE(u.staff_status, 'active') AS staff_status,
        COUNT(c.id)::int AS assigned_client_count
      FROM users u
      LEFT JOIN users c
        ON c.assigned_coach_id = u.id
       AND c.role = 'client'
       AND COALESCE(c.client_status, 'active') != 'deleted'
      WHERE u.role IN ('coach', 'admin')
        AND COALESCE(u.staff_status, 'active') = $1
      GROUP BY u.id
      ORDER BY
        CASE WHEN u.role = 'admin' THEN 0 ELSE 1 END,
        name ASC
    `, [statusFilter])
    res.json(rows)
  } catch (err) { next(err) }
})

// GET /api/coach-admin/staff/:id — fetch one staff member's profile
router.get('/staff/:id', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const staffId = parseInt(req.params.id, 10)

    const { rows } = await pool.query(`
      SELECT
        u.id,
        u.first_name,
        u.last_name,
        u.email,
        u.role,
        u.phone_number,
        u.last_login_at,
        COALESCE(u.staff_status, 'active') AS staff_status,
        ha.street_address,
        ha.city,
        ha.state,
        ha.zip_code,
        ha.country,
        COUNT(c.id)::int AS assigned_client_count
      FROM users u
      LEFT JOIN health_assessments ha ON ha.user_id = u.id
      LEFT JOIN users c
        ON c.assigned_coach_id = u.id
       AND c.role = 'client'
       AND COALESCE(c.client_status, 'active') != 'deleted'
      WHERE u.id = $1
        AND u.role IN ('coach', 'admin')
      GROUP BY u.id, ha.street_address, ha.city, ha.state, ha.zip_code, ha.country
    `, [staffId])

    if (!rows.length) return res.status(404).json({ error: 'Staff member not found' })
    res.json(rows[0])
  } catch (err) { next(err) }
})

// PATCH /api/coach-admin/staff/:id — update a staff member's profile
router.patch('/staff/:id', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const staffId = parseInt(req.params.id, 10)

    // Verify target is staff
    const { rows: target } = await pool.query(
      'SELECT id, role FROM users WHERE id = $1 AND role IN (\'coach\', \'admin\')',
      [staffId],
    )
    if (!target.length) return res.status(404).json({ error: 'Staff member not found' })

    const { first_name, last_name, phone_number, role } = req.body

    // Only admin may change role
    if (role !== undefined && ctx.role !== 'admin') {
      return res.status(403).json({ error: 'Only admins can change roles' })
    }
    // Only allow valid staff roles
    if (role !== undefined && !['coach', 'admin'].includes(role)) {
      return res.status(400).json({ error: 'Role must be coach or admin' })
    }

    const { rows } = await pool.query(`
      UPDATE users SET
        first_name   = COALESCE($1, first_name),
        last_name    = COALESCE($2, last_name),
        phone_number = COALESCE($3, phone_number),
        role         = COALESCE($4, role)
      WHERE id = $5
      RETURNING id, first_name, last_name, email, role, phone_number, last_login_at,
                COALESCE(staff_status, 'active') AS staff_status
    `, [
      first_name   ?? null,
      last_name    ?? null,
      phone_number ?? null,
      role         ?? null,
      staffId,
    ])
    res.json(rows[0])
  } catch (err) { next(err) }
})

// PATCH /api/coach-admin/staff/:id/archive — admin only
router.patch('/staff/:id/archive', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireAdmin(req, res); if (!ctx) return
    const staffId = parseInt(req.params.id, 10)

    if (staffId === ctx.dbUserId) {
      return res.status(400).json({ error: 'You cannot archive yourself.' })
    }

    // Block if coach still has active assigned clients
    const { rows: assigned } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM users
       WHERE assigned_coach_id = $1 AND role = 'client'
         AND COALESCE(client_status, 'active') = 'active'`,
      [staffId],
    )
    if (assigned[0].n > 0) {
      return res.status(409).json({
        error: `This coach has ${assigned[0].n} assigned client(s). Reassign them before archiving.`,
      })
    }

    const { rows } = await pool.query(
      `UPDATE users SET staff_status = 'archived'
       WHERE id = $1 AND role IN ('coach', 'admin')
       RETURNING id, COALESCE(staff_status, 'active') AS staff_status`,
      [staffId],
    )
    if (!rows.length) return res.status(404).json({ error: 'Staff member not found' })
    res.json(rows[0])
  } catch (err) { next(err) }
})

// PATCH /api/coach-admin/staff/:id/reactivate — admin only
router.patch('/staff/:id/reactivate', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireAdmin(req, res); if (!ctx) return
    const staffId = parseInt(req.params.id, 10)

    const { rows } = await pool.query(
      `UPDATE users SET staff_status = 'active'
       WHERE id = $1 AND role IN ('coach', 'admin')
       RETURNING id, COALESCE(staff_status, 'active') AS staff_status`,
      [staffId],
    )
    if (!rows.length) return res.status(404).json({ error: 'Staff member not found' })
    res.json(rows[0])
  } catch (err) { next(err) }
})

router.post('/clients/invite', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireAdmin(req, res); if (!ctx) return

    const { first_name, last_name, email, phone, assigned_coach_id, notes } = req.body

    if (!first_name?.trim()) return res.status(400).json({ error: 'First name is required.' })
    if (!email?.trim())      return res.status(400).json({ error: 'Email is required.' })

    const normalizedEmail = email.trim().toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' })
    }

    // Block if an active or archived user already exists for this email.
    // Soft-deleted rows (client_status = 'deleted') are intentionally excluded —
    // admins must be able to reinvite after deleting a test / incomplete client.
    const { rows: existing } = await pool.query(
      `SELECT id, client_status
       FROM users
       WHERE LOWER(email) = $1
         AND COALESCE(client_status, 'active') != 'deleted'`,
      [normalizedEmail],
    )
    if (existing.length > 0) {
      const isArchived = existing[0].client_status === 'archived'
      if (isArchived) {
        return res.status(409).json({
          error:       'This email belongs to an archived client. Reactivate them from the client list before reinviting, or use a different email.',
          is_archived: true,
        })
      }
      return res.status(409).json({ error: 'A client with this email already exists in the system.' })
    }

    // Remove any stale pending (unaccepted) invite for this email so the admin
    // can always issue a fresh invite link — replaces rather than blocks.
    // Accepted invites (accepted_at IS NOT NULL) are left untouched.
    await pool.query(
      `DELETE FROM client_invites WHERE LOWER(email) = $1 AND accepted_at IS NULL`,
      [normalizedEmail],
    )

    const coachId = assigned_coach_id ? parseInt(assigned_coach_id, 10) : null

    const { rows: [invite] } = await pool.query(
      `INSERT INTO client_invites
         (email, first_name, last_name, phone, assigned_coach_id, notes, invited_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING token, email, first_name, last_name, created_at, expires_at`,
      [
        normalizedEmail,
        first_name.trim(),
        last_name.trim(),
        phone?.trim() || null,
        coachId,
        notes?.trim() || null,
        ctx.dbUserId,
      ],
    )

    const appUrl    = process.env.APP_BASE_URL ?? process.env.APP_URL ?? 'https://app.lwcvip.com'
    const inviteUrl = `${appUrl}/invite/${invite.token}`

    // Attempt email — never let it block or delay the response.
    // sendInviteEmail never throws; outer race is a belt-and-suspenders cap.
    let emailResult = { sent: false, reason: 'Email send skipped' }
    try {
      emailResult = await Promise.race([
        sendInviteEmail({
          to:        invite.email,
          firstName: invite.first_name,
          inviteUrl,
        }),
        // Hard outer cap — respond within 12 s regardless
        new Promise(resolve =>
          setTimeout(() => resolve({ sent: false, reason: 'Email send timed out' }), 12_000),
        ),
      ])
    } catch (emailErr) {
      emailResult = { sent: false, reason: emailErr.message ?? 'Email send failed' }
    }

    res.status(201).json({
      ok:            true,
      invite_url:    inviteUrl,
      email_sent:    emailResult.sent,
      email_note:    emailResult.sent ? null : emailResult.reason,
      first_name:    invite.first_name,
      last_name:     invite.last_name,
      email:         invite.email,
    })
  } catch (err) { next(err) }
})

// ─── Single client profile ────────────────────────────────────────────────────

// GET /api/coach-admin/clients/:id
router.get('/clients/:id', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const id = parseInt(req.params.id, 10)
    if (!await canAccessClient(ctx, id)) return res.status(403).json({ error: 'Forbidden' })

    const { rows } = await pool.query(`
      SELECT u.*,
        COALESCE(u.start_date, u.paid_at::date, u.created_at::date) AS effective_start_date,
        (SELECT first_name FROM users WHERE id = u.assigned_coach_id) AS assigned_coach_name,
        (SELECT email      FROM users WHERE id = u.assigned_coach_id) AS assigned_coach_email,
        (SELECT MAX(logged_at) FROM meals WHERE user_id = u.id) AS last_meal_at,
        COALESCE((SELECT AVG(completion_percentage)::numeric(5,1)
          FROM habit_completions
          WHERE user_id = u.id AND completion_date >= CURRENT_DATE - INTERVAL '7 days'), 0) AS adherence_7d,
        COALESCE((SELECT AVG(completion_percentage)::numeric(5,1)
          FROM habit_completions
          WHERE user_id = u.id AND completion_date >= CURRENT_DATE - INTERVAL '30 days'), 0) AS adherence_30d,
        (SELECT COUNT(*) FROM comeback_events WHERE user_id = u.id) AS comeback_count,
        ha.first_name           AS assessment_first_name,
        ha.last_name            AS assessment_last_name,
        ha.phone                AS assessment_phone,
        ha.date_of_birth        AS assessment_dob,
        ha.shirt_size           AS assessment_shirt_size,
        ha.street_address       AS assessment_street_address,
        ha.city                 AS assessment_city,
        ha.state                AS assessment_state,
        ha.zip_code             AS assessment_zip_code,
        ha.country              AS assessment_country,
        ha.completed_at         AS assessment_completed_at
      FROM users u
      LEFT JOIN health_assessments ha ON ha.user_id = u.id
      WHERE u.id = $1
    `, [id])
    if (!rows.length) return res.status(404).json({ error: 'Client not found' })

    const c = rows[0]

    // Field fallback chain: users table → health_assessments → null
    const merged = {
      ...c,
      // Build display name from first_name + assessment data
      display_first_name: c.first_name || c.assessment_first_name
        || (c.name ? c.name.split(' ')[0] : null) || null,
      display_last_name: c.assessment_last_name
        || (c.name && c.name.includes(' ') ? c.name.split(' ').slice(1).join(' ') : null)
        || null,
      display_phone:      c.phone_number || c.assessment_phone || null,
      display_dob:        c.assessment_dob || null,
      display_shirt_size: c.assessment_shirt_size || null,
      display_address: {
        street:  c.assessment_street_address || null,
        city:    c.assessment_city || null,
        state:   c.assessment_state || null,
        zip:     c.assessment_zip_code || null,
        country: c.assessment_country || null,
      },
      assessment_has_data: !!(c.assessment_completed_at && (
        c.assessment_first_name || c.assessment_last_name ||
        c.assessment_phone      || c.assessment_dob
      )),
      status_tag: computeStatusTag(c),
      momentum: computeMomentum(c.adherence_7d, c.adherence_30d),
    }
    res.json(merged)
  } catch (err) { next(err) }
})

// PATCH /api/coach-admin/clients/:id — admin can update profile/coaching fields
// Dynamic SET so `assigned_coach_id: null` actually unassigns the coach (unlike
// COALESCE, which would preserve the existing value).
router.patch('/clients/:id', requireAuth(), async (req, res, next) => {
  try {
    if (await requireAdmin(req, res) === null) return
    const id = parseInt(req.params.id, 10)

    const allowed = ['coaching_type', 'assigned_coach_id', 'role', 'start_date',
                     'phone_number', 'paid', 'first_name', 'last_name']
    const setClauses = []
    const params = []
    for (const key of allowed) {
      if (key in req.body) {
        let value = req.body[key]
        if (key === 'coaching_type' && !['vip', 'ai'].includes(value)) {
          return res.status(400).json({ error: 'coaching_type must be vip or ai' })
        }
        // Normalize empty string → NULL for these fields
        if (key === 'assigned_coach_id') {
          value = (value === '' || value === null) ? null : Number(value)
        }
        if (key === 'start_date' && value === '') value = null
        params.push(value)
        setClauses.push(`${key} = $${params.length}`)
        if (key === 'coaching_type') {
          setClauses.push(`coaching_type_source = 'manual'`)
        }
      }
    }

    // When flipping paid → TRUE, also set paid_at if it's currently NULL
    if (req.body.paid === true) {
      setClauses.push('paid_at = COALESCE(paid_at, NOW())')
    }

    if (setClauses.length === 0) {
      const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [id])
      return res.json(rows[0] ?? null)
    }

    params.push(id)
    const { rows } = await pool.query(
      `UPDATE users SET ${setClauses.join(', ')}
       WHERE id = $${params.length}
       RETURNING *`,
      params,
    )
    if (!rows.length) return res.status(404).json({ error: 'Client not found' })
    res.json(rows[0])
  } catch (err) { next(err) }
})

// ─── Lifecycle: archive / reactivate / soft-delete ────────────────────────────

// PATCH /api/coach-admin/clients/:id/archive
router.patch('/clients/:id/archive', requireAuth(), async (req, res, next) => {
  try {
    if (await requireAdmin(req, res) === null) return
    const id = parseInt(req.params.id, 10)
    const { userId } = getAuth(req)
    const adminDbId = await getOrCreateUser(userId)
    const { rows } = await pool.query(`
      UPDATE users
      SET client_status = 'archived',
          archived_at = NOW(),
          archived_by = $2
      WHERE id = $1 AND COALESCE(client_status, 'active') != 'deleted'
      RETURNING id, client_status, archived_at
    `, [id, adminDbId])
    if (!rows.length) return res.status(404).json({ error: 'Client not found' })
    res.json({ ok: true, ...rows[0] })
  } catch (err) { next(err) }
})

// PATCH /api/coach-admin/clients/:id/reactivate
router.patch('/clients/:id/reactivate', requireAuth(), async (req, res, next) => {
  try {
    if (await requireAdmin(req, res) === null) return
    const id = parseInt(req.params.id, 10)
    const { rows } = await pool.query(`
      UPDATE users
      SET client_status = 'active',
          archived_at = NULL,
          archived_by = NULL,
          deleted_at = NULL,
          deleted_by = NULL
      WHERE id = $1
      RETURNING id, client_status
    `, [id])
    if (!rows.length) return res.status(404).json({ error: 'Client not found' })
    res.json({ ok: true, ...rows[0] })
  } catch (err) { next(err) }
})

// DELETE /api/coach-admin/clients/:id — SOFT delete (preserves all data)
// Pass ?hard=true to permanently remove (admin only, requires confirmation
// at the API level by sending {confirm: 'PERMANENT_DELETE'} in the body).
router.delete('/clients/:id', requireAuth(), async (req, res, next) => {
  try {
    if (await requireAdmin(req, res) === null) return
    const id = parseInt(req.params.id, 10)
    const { userId } = getAuth(req)
    const adminDbId = await getOrCreateUser(userId)

    if (id === adminDbId) {
      return res.status(400).json({ error: 'Cannot delete your own account' })
    }

    // Hard delete only if explicitly confirmed
    if (req.query.hard === 'true' && req.body?.confirm === 'PERMANENT_DELETE') {
      await pool.query('DELETE FROM users WHERE id = $1', [id])
      return res.json({ ok: true, hard_deleted: true })
    }

    const { rows } = await pool.query(`
      UPDATE users
      SET client_status = 'deleted',
          deleted_at = NOW(),
          deleted_by = $2
      WHERE id = $1
      RETURNING id, client_status, deleted_at
    `, [id, adminDbId])
    if (!rows.length) return res.status(404).json({ error: 'Client not found' })
    res.json({ ok: true, soft_deleted: true, ...rows[0] })
  } catch (err) { next(err) }
})

// ─── Engagement / progress summary ────────────────────────────────────────────

// GET /api/coach-admin/clients/:id/engagement
router.get('/clients/:id/engagement', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const id = parseInt(req.params.id, 10)
    if (!await canAccessClient(ctx, id)) return res.status(403).json({ error: 'Forbidden' })

    const wk = `CURRENT_DATE - INTERVAL '7 days'`
    const { rows: [stats] } = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM meals WHERE user_id = $1 AND COALESCE(log_date, logged_at::date) >= ${wk}) AS food_logs_week,
        (SELECT COUNT(*) FROM workout_logs WHERE user_id = $1 AND completed_at >= ${wk}) AS workouts_week,
        (SELECT COUNT(*) FROM daily_logs WHERE user_id = $1 AND logged_date >= CURRENT_DATE - 7 AND water_oz IS NOT NULL) AS water_logs_week,
        (SELECT COUNT(*) FROM daily_logs WHERE user_id = $1 AND logged_date >= CURRENT_DATE - 7 AND steps IS NOT NULL) AS step_logs_week,
        (SELECT MAX(logged_at) FROM meals WHERE user_id = $1) AS last_meal_at,
        (SELECT MAX(logged_date) FROM daily_logs WHERE user_id = $1) AS last_daily_log,
        (SELECT COUNT(*) FROM habit_completions WHERE user_id = $1 AND completion_date >= ${wk} AND status = 'complete') AS habits_complete_week,
        (SELECT COUNT(*) FROM habit_completions WHERE user_id = $1 AND completion_date >= ${wk} AND status IS NULL) AS habits_missed_week,
        (SELECT COUNT(*) FROM comeback_events WHERE user_id = $1) AS comeback_count
    `, [id])

    res.json(stats)
  } catch (err) { next(err) }
})

// GET /api/coach-admin/clients/:id/progress?range=daily|weekly|monthly
router.get('/clients/:id/progress', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const id  = parseInt(req.params.id, 10)
    if (!await canAccessClient(ctx, id)) return res.status(403).json({ error: 'Forbidden' })

    const range = ['daily','weekly','monthly'].includes(req.query.range) ? req.query.range : 'daily'
    const md    = `COALESCE(log_date, logged_at::date)` // meal date expression

    // ── Per-range series queries ──────────────────────────────────────────────
    let wt_q, mac_q, stp_q, wko_q, chk_q
    if (range === 'daily') {
      wt_q  = `SELECT logged_date AS date, ROUND(weight_lbs::numeric,1) AS value
               FROM daily_logs WHERE user_id=$1 AND weight_lbs IS NOT NULL
                 AND logged_date >= CURRENT_DATE-30 ORDER BY logged_date`
      mac_q = `SELECT ${md} AS date,
                 ROUND(SUM(calories)) AS calories, ROUND(SUM(protein)::numeric,1) AS protein,
                 ROUND(SUM(carbs)::numeric,1) AS carbs, ROUND(SUM(fat)::numeric,1) AS fat
               FROM meals WHERE user_id=$1 AND ${md} >= CURRENT_DATE-30
               GROUP BY ${md} ORDER BY ${md}`
      stp_q = `SELECT logged_date AS date, steps AS value
               FROM daily_logs WHERE user_id=$1 AND steps IS NOT NULL
                 AND logged_date >= CURRENT_DATE-30 ORDER BY logged_date`
      wko_q = `SELECT completed_at::date AS date, COUNT(*)::int AS count
               FROM workout_logs WHERE user_id=$1 AND completed_at >= NOW()-INTERVAL '30 days'
               GROUP BY 1 ORDER BY 1`
      chk_q = `SELECT DATE_TRUNC('week', week_start)::date AS date,
                 sleep_quality, energy, stress,
                 ROUND(current_weight::numeric,1) AS current_weight
               FROM weekly_checkins WHERE user_id=$1 AND week_start >= CURRENT_DATE-30
               ORDER BY week_start`
    } else if (range === 'weekly') {
      wt_q  = `SELECT DATE_TRUNC('week', logged_date)::date AS date,
                 ROUND(AVG(weight_lbs)::numeric,1) AS value
               FROM daily_logs WHERE user_id=$1 AND weight_lbs IS NOT NULL
                 AND logged_date >= CURRENT_DATE-84
               GROUP BY 1 ORDER BY 1`
      mac_q = `SELECT DATE_TRUNC('week', d)::date AS date,
                 ROUND(AVG(cal)) AS calories, ROUND(AVG(prot)::numeric,1) AS protein,
                 ROUND(AVG(crb)::numeric,1) AS carbs, ROUND(AVG(ft)::numeric,1) AS fat
               FROM (SELECT ${md} AS d, SUM(calories) cal, SUM(protein) prot,
                       SUM(carbs) crb, SUM(fat) ft
                     FROM meals WHERE user_id=$1 AND ${md} >= CURRENT_DATE-84 GROUP BY d) t
               GROUP BY 1 ORDER BY 1`
      stp_q = `SELECT DATE_TRUNC('week', logged_date)::date AS date, ROUND(AVG(steps)) AS value
               FROM daily_logs WHERE user_id=$1 AND steps IS NOT NULL
                 AND logged_date >= CURRENT_DATE-84
               GROUP BY 1 ORDER BY 1`
      wko_q = `SELECT DATE_TRUNC('week', completed_at)::date AS date, COUNT(*)::int AS count
               FROM workout_logs WHERE user_id=$1 AND completed_at >= NOW()-INTERVAL '84 days'
               GROUP BY 1 ORDER BY 1`
      chk_q = `SELECT DATE_TRUNC('week', week_start)::date AS date,
                 sleep_quality, energy, stress,
                 ROUND(current_weight::numeric,1) AS current_weight
               FROM weekly_checkins WHERE user_id=$1 AND week_start >= CURRENT_DATE-84
               ORDER BY week_start`
    } else {
      wt_q  = `SELECT DATE_TRUNC('month', logged_date)::date AS date,
                 ROUND(AVG(weight_lbs)::numeric,1) AS value
               FROM daily_logs WHERE user_id=$1 AND weight_lbs IS NOT NULL
                 AND logged_date >= CURRENT_DATE-180
               GROUP BY 1 ORDER BY 1`
      mac_q = `SELECT DATE_TRUNC('month', d)::date AS date,
                 ROUND(AVG(cal)) AS calories, ROUND(AVG(prot)::numeric,1) AS protein,
                 ROUND(AVG(crb)::numeric,1) AS carbs, ROUND(AVG(ft)::numeric,1) AS fat
               FROM (SELECT ${md} AS d, SUM(calories) cal, SUM(protein) prot,
                       SUM(carbs) crb, SUM(fat) ft
                     FROM meals WHERE user_id=$1 AND ${md} >= CURRENT_DATE-180 GROUP BY d) t
               GROUP BY 1 ORDER BY 1`
      stp_q = `SELECT DATE_TRUNC('month', logged_date)::date AS date, ROUND(AVG(steps)) AS value
               FROM daily_logs WHERE user_id=$1 AND steps IS NOT NULL
                 AND logged_date >= CURRENT_DATE-180
               GROUP BY 1 ORDER BY 1`
      wko_q = `SELECT DATE_TRUNC('month', completed_at)::date AS date, COUNT(*)::int AS count
               FROM workout_logs WHERE user_id=$1 AND completed_at >= NOW()-INTERVAL '180 days'
               GROUP BY 1 ORDER BY 1`
      chk_q = `SELECT DATE_TRUNC('month', week_start)::date AS date,
                 ROUND(AVG(sleep_quality)::numeric,1) AS sleep_quality,
                 ROUND(AVG(energy)::numeric,1) AS energy,
                 ROUND(AVG(stress)::numeric,1) AS stress,
                 ROUND(AVG(current_weight)::numeric,1) AS current_weight
               FROM weekly_checkins WHERE user_id=$1 AND week_start >= CURRENT_DATE-180
               GROUP BY 1 ORDER BY 1`
    }

    // ── Summary always from last 30 days ──────────────────────────────────────
    const sum_q = `
      SELECT
        (SELECT ROUND(weight_lbs::numeric,1) FROM daily_logs WHERE user_id=$1
           AND weight_lbs IS NOT NULL AND logged_date >= CURRENT_DATE-30
           ORDER BY logged_date ASC  LIMIT 1) AS weight_start,
        (SELECT ROUND(weight_lbs::numeric,1) FROM daily_logs WHERE user_id=$1
           AND weight_lbs IS NOT NULL AND logged_date >= CURRENT_DATE-30
           ORDER BY logged_date DESC LIMIT 1) AS weight_end,
        (SELECT ROUND(AVG(dc)) FROM
           (SELECT SUM(calories) dc FROM meals WHERE user_id=$1
              AND ${md} >= CURRENT_DATE-30 GROUP BY ${md}) t) AS avg_calories,
        (SELECT ROUND(AVG(dp)::numeric,1) FROM
           (SELECT SUM(protein) dp FROM meals WHERE user_id=$1
              AND ${md} >= CURRENT_DATE-30 GROUP BY ${md}) t) AS avg_protein,
        (SELECT ROUND(AVG(steps)) FROM daily_logs WHERE user_id=$1
           AND steps IS NOT NULL AND logged_date >= CURRENT_DATE-30) AS avg_steps,
        (SELECT COUNT(*)::int FROM workout_logs WHERE user_id=$1
           AND completed_at >= NOW()-INTERVAL '30 days') AS workouts_completed,
        (SELECT COUNT(DISTINCT ${md})::int FROM meals WHERE user_id=$1
           AND ${md} >= CURRENT_DATE-30) AS logged_day_count`

    const [sumR, wtR, macR, stpR, wkoR, chkR, photoR] = await Promise.all([
      pool.query(sum_q, [id]),
      pool.query(wt_q,  [id]),
      pool.query(mac_q, [id]),
      pool.query(stp_q, [id]),
      pool.query(wko_q, [id]),
      pool.query(chk_q, [id]),
      pool.query(`SELECT id, photo_url, angle, taken_at FROM progress_photos
                  WHERE user_id=$1 ORDER BY taken_at DESC LIMIT 12`, [id]),
    ])

    // ── Summary: compute weight change ────────────────────────────────────────
    const summary = { ...sumR.rows[0] }
    summary.weight_change = (summary.weight_start != null && summary.weight_end != null)
      ? Math.round((Number(summary.weight_end) - Number(summary.weight_start)) * 10) / 10
      : null

    // ── Merge series into table_rows by date key ──────────────────────────────
    const tmap = new Map()
    const row = (d) => {
      const key = d instanceof Date ? d.toISOString().slice(0,10) : String(d).slice(0,10)
      if (!tmap.has(key)) tmap.set(key, { date: key })
      return tmap.get(key)
    }
    for (const r of wtR.rows)  { const o = row(r.date); o.weight   = r.value }
    for (const r of macR.rows) { const o = row(r.date); o.calories = r.calories; o.protein = r.protein; o.carbs = r.carbs; o.fat = r.fat }
    for (const r of stpR.rows) { const o = row(r.date); o.steps    = r.value }
    for (const r of wkoR.rows) { const o = row(r.date); o.workouts = r.count }
    for (const r of chkR.rows) {
      const o = row(r.date)
      if (r.sleep_quality  != null) o.sleep_quality = r.sleep_quality
      if (r.energy         != null) o.energy        = r.energy
      if (r.current_weight != null && o.weight == null) o.weight = r.current_weight
    }

    const limit     = range === 'daily' ? 14 : range === 'weekly' ? 12 : 6
    const table_rows = [...tmap.values()]
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, limit)
      .map(r => {
        const d = new Date(r.date + 'T12:00:00Z')
        r.period = range === 'monthly'
          ? d.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })
          : range === 'weekly'
            ? 'Week of ' + d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
            : d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })
        return r
      })

    res.json({ range, summary, weight_series: wtR.rows, macro_series: macR.rows,
               step_series: stpR.rows, workout_series: wkoR.rows, checkin_series: chkR.rows,
               table_rows, progress_photos: photoR.rows })
  } catch (err) { next(err) }
})

// ─── Client Measurements ──────────────────────────────────────────────────────

// GET /api/coach-admin/clients/:id/measurements
router.get('/clients/:id/measurements', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const id = parseInt(req.params.id, 10)
    if (!await canAccessClient(ctx, id)) return res.status(403).json({ error: 'Forbidden' })
    const { rows } = await pool.query(
      `SELECT id, user_id, measurement_date, chest, waist, hips, created_at
       FROM client_measurements WHERE user_id = $1
       ORDER BY measurement_date DESC, created_at DESC`,
      [id],
    )
    res.json(rows)
  } catch (err) { next(err) }
})

// POST /api/coach-admin/clients/:id/measurements
router.post('/clients/:id/measurements', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const id = parseInt(req.params.id, 10)
    if (!await canAccessClient(ctx, id)) return res.status(403).json({ error: 'Forbidden' })
    const { measurement_date, chest, waist, hips } = req.body
    const date = measurement_date || new Date().toISOString().slice(0, 10)
    const { rows } = await pool.query(
      `INSERT INTO client_measurements (user_id, measurement_date, chest, waist, hips)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, user_id, measurement_date, chest, waist, hips, created_at`,
      [id, date, chest ?? null, waist ?? null, hips ?? null],
    )
    res.json(rows[0])
  } catch (err) { next(err) }
})

// ─── Nutrition data for coaches ───────────────────────────────────────────────

// GET /api/coach-admin/clients/:id/nutrition?date=YYYY-MM-DD
router.get('/clients/:id/nutrition', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const id = parseInt(req.params.id, 10)
    if (!await canAccessClient(ctx, id)) return res.status(403).json({ error: 'Forbidden' })

    const date = req.query.date ?? new Date().toISOString().slice(0, 10)
    const [macros, daily] = await Promise.all([
      pool.query(`
        SELECT
          COALESCE(SUM(calories), 0)::int AS total_calories,
          COALESCE(SUM(protein),  0)::int AS total_protein,
          COALESCE(SUM(carbs),    0)::int AS total_carbs,
          COALESCE(SUM(fat),      0)::int AS total_fat,
          COALESCE(SUM(fiber),    0)::int AS total_fiber,
          COUNT(*)::int                   AS meal_count
        FROM meals
        WHERE user_id = $1 AND COALESCE(log_date, logged_at::date) = $2::date
      `, [id, date]),
      pool.query(`
        SELECT water_oz, steps, weight_lbs
        FROM daily_logs WHERE user_id = $1 AND logged_date = $2::date
      `, [id, date]),
    ])
    res.json({ ...macros.rows[0], ...(daily.rows[0] ?? { water_oz: null, steps: null, weight_lbs: null }) })
  } catch (err) { next(err) }
})

// GET /api/coach-admin/clients/:id/nutrition/weekly
router.get('/clients/:id/nutrition/weekly', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const id = parseInt(req.params.id, 10)
    if (!await canAccessClient(ctx, id)) return res.status(403).json({ error: 'Forbidden' })

    const [macros, daily] = await Promise.all([
      pool.query(`
        SELECT
          ROUND(AVG(dc))::int     AS avg_calories,
          ROUND(AVG(dp))::int     AS avg_protein,
          ROUND(AVG(dcarbs))::int AS avg_carbs,
          ROUND(AVG(dfat))::int   AS avg_fat,
          ROUND(AVG(dfiber))::int AS avg_fiber
        FROM (
          SELECT SUM(calories) AS dc, SUM(protein) AS dp,
                 SUM(carbs) AS dcarbs, SUM(fat) AS dfat,
                 COALESCE(SUM(fiber), 0) AS dfiber
          FROM meals
          WHERE user_id = $1 AND COALESCE(log_date, logged_at::date) >= CURRENT_DATE - INTERVAL '7 days'
          GROUP BY COALESCE(log_date, logged_at::date)
        ) t
      `, [id]),
      pool.query(`
        SELECT
          ROUND(AVG(water_oz))::int           AS avg_water_oz,
          ROUND(AVG(steps))::int              AS avg_steps,
          ROUND(AVG(weight_lbs)::numeric, 1)  AS avg_weight_lbs
        FROM daily_logs
        WHERE user_id = $1 AND logged_date >= CURRENT_DATE - INTERVAL '7 days'
      `, [id]),
    ])
    res.json({ ...macros.rows[0], ...(daily.rows[0] ?? { avg_water_oz: null, avg_steps: null, avg_weight_lbs: null }) })
  } catch (err) { next(err) }
})

// GET /api/coach-admin/clients/:id/meals?date=YYYY-MM-DD — food log for a day
router.get('/clients/:id/meals', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const id = parseInt(req.params.id, 10)
    if (!await canAccessClient(ctx, id)) return res.status(403).json({ error: 'Forbidden' })

    const date = req.query.date ?? new Date().toISOString().slice(0, 10)
    const { rows } = await pool.query(`
      SELECT
        id, meal_name, meal_slot,
        ROUND(calories)::int     AS calories,
        ROUND(protein::numeric, 1)  AS protein,
        ROUND(carbs::numeric,   1)  AS carbs,
        ROUND(fat::numeric,     1)  AS fat,
        ROUND(fiber::numeric,   1)  AS fiber,
        serving_size, serving_unit,
        logged_at
      FROM meals
      WHERE user_id = $1 AND COALESCE(log_date, logged_at::date) = $2::date
      ORDER BY
        CASE meal_slot
          WHEN 'Breakfast'  THEN 1
          WHEN 'AM Snack'   THEN 2
          WHEN 'Lunch'      THEN 3
          WHEN 'PM Snack'   THEN 4
          WHEN 'Snack'      THEN 5
          WHEN 'Dinner'     THEN 6
          WHEN 'Late Snack' THEN 7
          ELSE 8
        END,
        logged_at
    `, [id, date])
    res.json(rows)
  } catch (err) { next(err) }
})

// ─── Habit assignment ─────────────────────────────────────────────────────────

// GET /api/coach-admin/clients/:id/habits — list assigned habits
router.get('/clients/:id/habits', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const id = parseInt(req.params.id, 10)
    if (!await canAccessClient(ctx, id)) return res.status(403).json({ error: 'Forbidden' })

    const { rows } = await pool.query(`
      SELECT h.*, (SELECT first_name FROM users WHERE id = h.assigned_by_user_id) AS assigned_by_name
      FROM coach_assigned_habits h
      WHERE h.user_id = $1
      ORDER BY h.start_date DESC, h.created_at DESC
    `, [id])
    res.json(rows)
  } catch (err) { next(err) }
})

// POST /api/coach-admin/clients/:id/habits — assign new habit
router.post('/clients/:id/habits', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const id = parseInt(req.params.id, 10)
    if (!await canAccessClient(ctx, id)) return res.status(403).json({ error: 'Forbidden' })

    const {
      habit_name, habit_type = 'boolean', target_value, unit,
      frequency = 'daily', start_date, end_date, days_of_week, notes,
    } = req.body
    if (!habit_name?.trim() || !start_date) {
      return res.status(400).json({ error: 'habit_name and start_date required' })
    }

    const { rows } = await pool.query(`
      INSERT INTO coach_assigned_habits
        (user_id, assigned_by_user_id, habit_name, habit_type, target_value, unit,
         frequency, start_date, end_date, days_of_week, notes)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING *
    `, [
      id, ctx.dbUserId,
      habit_name.trim(), habit_type,
      target_value != null ? Number(target_value) : null,
      unit?.trim() || null,
      frequency, start_date, end_date ?? null,
      days_of_week ?? null,
      notes?.trim() || null,
    ])
    res.status(201).json(rows[0])
  } catch (err) { next(err) }
})

// PATCH /api/coach-admin/habits/:habitId — edit habit
router.patch('/habits/:habitId', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const habitId = parseInt(req.params.habitId, 10)

    // verify access via the habit's user
    const { rows: hRows } = await pool.query('SELECT user_id FROM coach_assigned_habits WHERE id = $1', [habitId])
    if (!hRows.length) return res.status(404).json({ error: 'Habit not found' })
    if (!await canAccessClient(ctx, hRows[0].user_id)) return res.status(403).json({ error: 'Forbidden' })

    const {
      habit_name, habit_type, target_value, unit,
      frequency, start_date, end_date, days_of_week, notes, active,
    } = req.body

    const { rows } = await pool.query(`
      UPDATE coach_assigned_habits SET
        habit_name   = COALESCE($1, habit_name),
        habit_type   = COALESCE($2, habit_type),
        target_value = COALESCE($3, target_value),
        unit         = COALESCE($4, unit),
        frequency    = COALESCE($5, frequency),
        start_date   = COALESCE($6, start_date),
        end_date     = COALESCE($7, end_date),
        days_of_week = COALESCE($8, days_of_week),
        notes        = COALESCE($9, notes),
        active       = COALESCE($10, active),
        updated_at   = NOW()
      WHERE id = $11 RETURNING *
    `, [
      habit_name ?? null, habit_type ?? null,
      target_value != null ? Number(target_value) : null,
      unit ?? null, frequency ?? null,
      start_date ?? null, end_date ?? null, days_of_week ?? null,
      notes ?? null, active ?? null,
      habitId,
    ])
    res.json(rows[0])
  } catch (err) { next(err) }
})

// DELETE /api/coach-admin/habits/:habitId
router.delete('/habits/:habitId', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const habitId = parseInt(req.params.habitId, 10)

    const { rows: hRows } = await pool.query('SELECT user_id FROM coach_assigned_habits WHERE id = $1', [habitId])
    if (!hRows.length) return res.status(404).json({ error: 'Habit not found' })
    if (!await canAccessClient(ctx, hRows[0].user_id)) return res.status(403).json({ error: 'Forbidden' })

    await pool.query('DELETE FROM coach_assigned_habits WHERE id = $1', [habitId])
    res.json({ ok: true })
  } catch (err) { next(err) }
})

// GET /api/coach-admin/clients/:id/habits/calendar?start=...&end=...
// Expand habits into per-day instances for the calendar view
router.get('/clients/:id/habits/calendar', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const id = parseInt(req.params.id, 10)
    if (!await canAccessClient(ctx, id)) return res.status(403).json({ error: 'Forbidden' })

    const startDate = req.query.start ?? new Date().toISOString().slice(0, 10)
    const endDate   = req.query.end   ?? new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10)

    // Get all habits that overlap the window, plus completions
    const { rows: habits } = await pool.query(`
      SELECT * FROM coach_assigned_habits
      WHERE user_id = $1 AND active = TRUE
        AND start_date <= $3::date
        AND (end_date IS NULL OR end_date >= $2::date)
    `, [id, startDate, endDate])

    const { rows: completions } = await pool.query(`
      SELECT habit_id, completion_date, completed_value, completion_percentage, status
      FROM habit_completions
      WHERE user_id = $1
        AND completion_date BETWEEN $2::date AND $3::date
    `, [id, startDate, endDate])

    // Helper: pg returns DATE as a JS Date in server local TZ. Use local
    // components — do NOT use toISOString() which can shift the day.
    const toISODate = v => {
      if (v == null) return null
      if (typeof v === 'string') return v.slice(0, 10)
      if (v instanceof Date) {
        const y = v.getFullYear()
        const m = String(v.getMonth() + 1).padStart(2, '0')
        const d = String(v.getDate()).padStart(2, '0')
        return `${y}-${m}-${d}`
      }
      return String(v).slice(0, 10)
    }

    // Build a {habit_id: {date: completion}} map
    const compMap = {}
    for (const c of completions) {
      const dateKey = toISODate(c.completion_date)
      if (!compMap[c.habit_id]) compMap[c.habit_id] = {}
      compMap[c.habit_id][dateKey] = c
    }

    // Expand each habit into per-day instances within the window
    const calendar = {}  // { 'YYYY-MM-DD': [{ habit, completion }] }
    const start = new Date(`${startDate}T00:00:00`)
    const end   = new Date(`${endDate}T00:00:00`)
    for (const habit of habits) {
      const hStartISO = toISODate(habit.start_date)
      const hEndISO   = toISODate(habit.end_date)
      const habitStart = new Date(`${hStartISO}T00:00:00`)
      const habitEnd   = hEndISO ? new Date(`${hEndISO}T00:00:00`) : end
      const allowed = habit.days_of_week
        ? habit.days_of_week.split(',').map(s => parseInt(s, 10))
        : null

      const iterStart = new Date(Math.max(start.getTime(), habitStart.getTime()))
      const iterEnd   = new Date(Math.min(end.getTime(), habitEnd.getTime()))
      for (let d = new Date(iterStart); d <= iterEnd; d.setDate(d.getDate() + 1)) {
        if (habit.frequency === 'specific_days' && allowed && !allowed.includes(d.getDay())) continue
        if (habit.frequency === 'weekly' && d.getDay() !== habitStart.getDay()) continue

        const key = toISODate(d)
        if (!calendar[key]) calendar[key] = []
        calendar[key].push({
          habit: { ...habit, start_date: hStartISO, end_date: hEndISO },
          completion: compMap[habit.id]?.[key] ?? null,
        })
      }
    }

    res.json({ start: startDate, end: endDate, calendar })
  } catch (err) { next(err) }
})

// ─── Notes ────────────────────────────────────────────────────────────────────

// GET /api/coach-admin/clients/:id/notes
router.get('/clients/:id/notes', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const id = parseInt(req.params.id, 10)
    if (!await canAccessClient(ctx, id)) return res.status(403).json({ error: 'Forbidden' })

    // Coaches cannot see admin_private notes
    const visibilityFilter = ctx.role === 'admin'
      ? ''
      : `AND n.visibility = 'shared_staff'`

    const { rows } = await pool.query(`
      SELECT n.*, u.first_name AS author_name
      FROM client_notes n
      LEFT JOIN users u ON u.id = n.author_id
      WHERE n.client_id = $1 ${visibilityFilter}
      ORDER BY n.created_at DESC
    `, [id])
    res.json(rows)
  } catch (err) { next(err) }
})

// POST /api/coach-admin/clients/:id/notes
router.post('/clients/:id/notes', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const id = parseInt(req.params.id, 10)
    if (!await canAccessClient(ctx, id)) return res.status(403).json({ error: 'Forbidden' })

    const { note_body, visibility = 'shared_staff' } = req.body
    if (!note_body?.trim()) return res.status(400).json({ error: 'note_body required' })

    // Only admins can create admin_private notes
    const finalVisibility = (visibility === 'admin_private' && ctx.role !== 'admin')
      ? 'shared_staff'
      : visibility

    const { rows } = await pool.query(`
      INSERT INTO client_notes (client_id, author_id, note_body, visibility)
      VALUES ($1, $2, $3, $4) RETURNING *
    `, [id, ctx.dbUserId, note_body.trim(), finalVisibility])
    res.status(201).json(rows[0])
  } catch (err) { next(err) }
})

// DELETE /api/coach-admin/notes/:noteId
router.delete('/notes/:noteId', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const noteId = parseInt(req.params.noteId, 10)

    const { rows: nRows } = await pool.query('SELECT client_id, author_id, visibility FROM client_notes WHERE id = $1', [noteId])
    if (!nRows.length) return res.status(404).json({ error: 'Note not found' })

    // Coaches can only delete their own notes; admins can delete any
    if (ctx.role !== 'admin' && nRows[0].author_id !== ctx.dbUserId) {
      return res.status(403).json({ error: 'Cannot delete this note' })
    }
    if (nRows[0].visibility === 'admin_private' && ctx.role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden' })
    }

    await pool.query('DELETE FROM client_notes WHERE id = $1', [noteId])
    res.json({ ok: true })
  } catch (err) { next(err) }
})

// ─── Messages ─────────────────────────────────────────────────────────────────

// GET /api/coach-admin/messaging/inbox — returns all threads across accessible clients with unread counts
router.get('/messaging/inbox', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const isAdmin = ctx.role === 'admin'
    const params = []
    let extraWhere = `COALESCE(u.client_status, 'active') != 'deleted'`
    if (!isAdmin) {
      params.push(ctx.dbUserId)
      extraWhere += ` AND u.assigned_coach_id = $${params.length} AND m.thread_type = 'coach_thread'`
    }
    const { rows } = await pool.query(`
      SELECT
        u.id AS client_id,
        u.first_name,
        m.thread_type,
        COUNT(*) FILTER (WHERE m.sender_role = 'client' AND m.read_at IS NULL)::int AS unread,
        MAX(m.created_at) AS last_message_at,
        (SELECT CASE WHEN message_body != '' THEN message_body ELSE '📷 Image' END
          FROM client_messages
          WHERE client_id = u.id AND thread_type = m.thread_type
          ORDER BY created_at DESC LIMIT 1) AS last_message_body,
        (SELECT sender_role FROM client_messages
          WHERE client_id = u.id AND thread_type = m.thread_type
          ORDER BY created_at DESC LIMIT 1) AS last_sender_role
      FROM client_messages m
      JOIN users u ON u.id = m.client_id
      WHERE ${extraWhere}
      GROUP BY u.id, u.first_name, m.thread_type
      ORDER BY MAX(m.created_at) DESC
    `, params)
    res.json(rows)
  } catch (err) { next(err) }
})

// GET /api/coach-admin/clients/:id/messages?thread=coach_thread|admin_private|ai_admin
router.get('/clients/:id/messages', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const id = parseInt(req.params.id, 10)
    if (!await canAccessClient(ctx, id)) return res.status(403).json({ error: 'Forbidden' })

    const thread = req.query.thread

    // Permission gate per thread type:
    // coach_thread:  admin + assigned coach can view
    // admin_private: admin only
    // ai_admin:      admin only
    if ((thread === 'admin_private' || thread === 'ai_admin') && ctx.role !== 'admin') {
      return res.status(403).json({ error: 'Admin only thread' })
    }

    const params = [id]
    let where = 'WHERE m.client_id = $1'
    if (thread) {
      params.push(thread)
      where += ` AND m.thread_type = $${params.length}`
    } else if (ctx.role !== 'admin') {
      // Coaches default to coach_thread only
      where += ` AND m.thread_type = 'coach_thread'`
    }

    const { rows } = await pool.query(`
      SELECT m.*, u.first_name AS sender_name
      FROM client_messages m
      LEFT JOIN users u ON u.id = m.sender_id
      ${where}
      ORDER BY m.created_at ASC
    `, params)

    // Mark client messages as read now that staff has viewed the thread
    const readParams = [id]
    let readWhere = `WHERE client_id = $1 AND sender_role = 'client' AND read_at IS NULL`
    if (thread) {
      readParams.push(thread)
      readWhere += ` AND thread_type = $${readParams.length}`
    }
    await pool.query(`UPDATE client_messages SET read_at = NOW() ${readWhere}`, readParams)

    res.json(rows)
  } catch (err) { next(err) }
})

// POST /api/coach-admin/clients/:id/messages
router.post('/clients/:id/messages', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const id = parseInt(req.params.id, 10)
    if (!await canAccessClient(ctx, id)) return res.status(403).json({ error: 'Forbidden' })

    const { message_body = '', thread_type = 'coach_thread', image_url } = req.body
    if (!message_body?.trim() && !image_url) return res.status(400).json({ error: 'message_body or image required' })

    // Coach can only send to coach_thread
    if (ctx.role === 'coach' && thread_type !== 'coach_thread') {
      return res.status(403).json({ error: 'Coaches can only send to coach thread' })
    }

    // Determine visibility based on thread_type
    const visibility = (thread_type === 'admin_private' || thread_type === 'ai_admin')
      ? 'client_and_admin_only'
      : 'client_and_staff'

    // If sending to ai_admin, verify client is an AI client
    if (thread_type === 'ai_admin') {
      const { rows } = await pool.query('SELECT coaching_type FROM users WHERE id = $1', [id])
      if (rows[0]?.coaching_type !== 'ai') {
        return res.status(400).json({ error: 'ai_admin thread is only for AI coaching clients' })
      }
    }

    const { rows } = await pool.query(`
      INSERT INTO client_messages
        (client_id, sender_id, sender_role, message_body, thread_type, visibility, image_url)
      VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *
    `, [id, ctx.dbUserId, ctx.role, message_body.trim(), thread_type, visibility, image_url ?? null])

    res.status(201).json(rows[0])
  } catch (err) { next(err) }
})

// ─── Weekly Check-Ins ─────────────────────────────────────────────────────────

// GET /api/coach-admin/clients/:id/checkins — staff views client's check-in history
// Admin sees all clients; assigned coach sees their own clients only (enforced by canAccessClient)
router.get('/clients/:id/checkins', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const id = parseInt(req.params.id, 10)
    if (!await canAccessClient(ctx, id)) return res.status(403).json({ error: 'Forbidden' })
    const { rows } = await pool.query(
      'SELECT * FROM weekly_checkins WHERE user_id = $1 ORDER BY week_start DESC',
      [id],
    )
    res.json(rows)
  } catch (err) { next(err) }
})

// ─── Assessment view/edit ─────────────────────────────────────────────────────

// GET /api/coach-admin/clients/:id/assessment — admin/coach can view assessment
router.get('/clients/:id/assessment', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const id = parseInt(req.params.id, 10)
    if (!await canAccessClient(ctx, id)) return res.status(403).json({ error: 'Forbidden' })
    const { rows } = await pool.query('SELECT * FROM health_assessments WHERE user_id = $1', [id])
    res.json(rows[0] ?? null)
  } catch (err) { next(err) }
})

// PATCH /api/coach-admin/clients/:id/assessment — admin/coach can edit assessment
router.patch('/clients/:id/assessment', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const id = parseInt(req.params.id, 10)
    if (!await canAccessClient(ctx, id)) return res.status(403).json({ error: 'Forbidden' })

    // Use a simple field-by-field COALESCE approach for safety
    const fields = [
      'first_name', 'last_name', 'phone', 'street_address', 'city', 'state', 'zip_code', 'country',
      'date_of_birth', 'shirt_size', 'coach_name', 'supplements', 'goals_6_months',
      'injuries_limitations', 'num_kids', 'occupation', 'energy_level', 'sleep_hours',
      'stress_management', 'sleep_quality', 'daily_water', 'alcohol_weekdays', 'alcohol_weekends',
      'happiness_level', 'confidence_level', 'activity_level',
    ]
    const setClauses = []
    const params = []
    for (const f of fields) {
      if (req.body[f] !== undefined) {
        params.push(req.body[f])
        setClauses.push(`${f} = $${params.length}`)
      }
    }
    if (!setClauses.length) return res.json({ ok: true })
    params.push(id)
    const { rows } = await pool.query(`
      UPDATE health_assessments SET ${setClauses.join(', ')}, updated_at = NOW()
      WHERE user_id = $${params.length} RETURNING *
    `, params)
    res.json(rows[0] ?? null)
  } catch (err) { next(err) }
})

// ─── Comeback events ──────────────────────────────────────────────────────────

// POST /api/coach-admin/clients/:id/comeback — manually log a comeback (system can also call this)
router.post('/clients/:id/comeback', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const id = parseInt(req.params.id, 10)
    if (!await canAccessClient(ctx, id)) return res.status(403).json({ error: 'Forbidden' })

    const { gap_start_date, gap_end_date, comeback_date, comeback_type = 'returned_to_logging' } = req.body
    if (!comeback_date) return res.status(400).json({ error: 'comeback_date required' })
    const { rows } = await pool.query(`
      INSERT INTO comeback_events (user_id, gap_start_date, gap_end_date, comeback_date, comeback_type)
      VALUES ($1, $2, $3, $4, $5) RETURNING *
    `, [id, gap_start_date ?? null, gap_end_date ?? null, comeback_date, comeback_type])
    res.status(201).json(rows[0])
  } catch (err) { next(err) }
})

// GET /api/coach-admin/clients/:id/comeback
router.get('/clients/:id/comeback', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const id = parseInt(req.params.id, 10)
    if (!await canAccessClient(ctx, id)) return res.status(403).json({ error: 'Forbidden' })
    const { rows } = await pool.query(
      'SELECT * FROM comeback_events WHERE user_id = $1 ORDER BY comeback_date DESC LIMIT 20',
      [id],
    )
    res.json(rows)
  } catch (err) { next(err) }
})

// ─── Form Submissions (staff view) ───────────────────────────────────────────

// GET /api/coach-admin/clients/:id/form-submissions
// Returns all form submissions for a client, with the version schema embedded
// so the viewer can show exact questions alongside answers.
router.get('/clients/:id/form-submissions', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const id = parseInt(req.params.id, 10)
    if (!await canAccessClient(ctx, id)) return res.status(403).json({ error: 'Forbidden' })

    const { rows } = await pool.query(`
      SELECT
        fs.id, fs.template_id, fs.version_id, fs.user_id,
        fs.answers, fs.submitted_at, fs.updated_at,
        fs.reviewed_at, fs.reviewed_by, fs.coach_note,
        ft.title  AS form_title,
        ft.status AS form_status,
        fv.version_num,
        fv.schema AS version_schema,
        reviewer.first_name AS reviewed_by_name
      FROM form_submissions fs
      JOIN form_templates ft ON ft.id = fs.template_id
      JOIN form_versions  fv ON fv.id = fs.version_id
      LEFT JOIN users reviewer ON reviewer.id = fs.reviewed_by
      WHERE fs.user_id = $1
      ORDER BY fs.submitted_at DESC
    `, [id])

    res.json(rows)
  } catch (err) { next(err) }
})

// GET /api/coach-admin/form-submissions/:submissionId
// Single submission with full answers + schema (staff only, permission checked via client lookup)
router.get('/form-submissions/:submissionId', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const subId = parseInt(req.params.submissionId, 10)

    const { rows: [sub] } = await pool.query(`
      SELECT
        fs.id, fs.template_id, fs.version_id, fs.user_id,
        fs.answers, fs.submitted_at, fs.updated_at,
        fs.reviewed_at, fs.reviewed_by, fs.coach_note,
        ft.title  AS form_title,
        ft.status AS form_status,
        fv.version_num,
        fv.schema AS version_schema,
        reviewer.first_name AS reviewed_by_name
      FROM form_submissions fs
      JOIN form_templates ft ON ft.id = fs.template_id
      JOIN form_versions  fv ON fv.id = fs.version_id
      LEFT JOIN users reviewer ON reviewer.id = fs.reviewed_by
      WHERE fs.id = $1
    `, [subId])

    if (!sub) return res.status(404).json({ error: 'Submission not found' })
    if (!await canAccessClient(ctx, sub.user_id)) return res.status(403).json({ error: 'Forbidden' })

    res.json(sub)
  } catch (err) { next(err) }
})

// PATCH /api/coach-admin/form-submissions/:submissionId/mark-reviewed
// Stamps reviewed_at/reviewed_by on explicit staff action (not on open).
// Idempotent: never overwrites an existing reviewed_at.
router.patch('/form-submissions/:submissionId/mark-reviewed', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const subId = parseInt(req.params.submissionId, 10)

    const { rows: [sub] } = await pool.query(
      `SELECT fs.id, fs.user_id, fs.reviewed_at, fs.reviewed_by,
              reviewer.first_name AS reviewed_by_name
       FROM form_submissions fs
       LEFT JOIN users reviewer ON reviewer.id = fs.reviewed_by
       WHERE fs.id = $1`,
      [subId],
    )
    if (!sub) return res.status(404).json({ error: 'Submission not found' })
    if (!await canAccessClient(ctx, sub.user_id)) return res.status(403).json({ error: 'Forbidden' })

    if (sub.reviewed_at) {
      return res.json({
        already_reviewed: true,
        reviewed_at:      sub.reviewed_at,
        reviewed_by:      sub.reviewed_by,
        reviewed_by_name: sub.reviewed_by_name,
      })
    }

    const { rows: [updated] } = await pool.query(
      `UPDATE form_submissions SET reviewed_at = NOW(), reviewed_by = $1
       WHERE id = $2 RETURNING reviewed_at, reviewed_by`,
      [ctx.dbUserId, subId],
    )
    // Return reviewer name so the UI can display it without a page reload
    const { rows: [reviewer] } = await pool.query(
      'SELECT first_name FROM users WHERE id = $1',
      [ctx.dbUserId],
    )
    res.json({
      ok:               true,
      reviewed_at:      updated.reviewed_at,
      reviewed_by:      updated.reviewed_by,
      reviewed_by_name: reviewer?.first_name ?? null,
    })
  } catch (err) { next(err) }
})

// PATCH /api/coach-admin/form-submissions/:submissionId/note
// Saves or replaces the staff coach note for a submission.
router.patch('/form-submissions/:submissionId/note', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const subId = parseInt(req.params.submissionId, 10)
    const { note } = req.body
    const normalizedNote = typeof note === 'string' ? note.trim() : ''

    const { rows: [sub] } = await pool.query(
      'SELECT id, user_id FROM form_submissions WHERE id = $1',
      [subId],
    )
    if (!sub) return res.status(404).json({ error: 'Submission not found' })
    if (!await canAccessClient(ctx, sub.user_id)) return res.status(403).json({ error: 'Forbidden' })

    const { rows: [updated] } = await pool.query(
      'UPDATE form_submissions SET coach_note = $1 WHERE id = $2 RETURNING coach_note',
      [normalizedNote || null, subId],
    )
    res.json({ ok: true, coach_note: updated.coach_note })
  } catch (err) { next(err) }
})

// ─── Form Send / Assignment ───────────────────────────────────────────────────

// POST /api/coach-admin/forms/:id/send
// Body: { client_ids: [1, 2, 3] }
// Creates a form_assignment and an in-app message for each accessible client.
router.post('/forms/:id/send', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return

    const templateId = parseInt(req.params.id, 10)
    const { client_ids } = req.body

    if (!Array.isArray(client_ids) || client_ids.length === 0) {
      return res.status(400).json({ error: 'client_ids must be a non-empty array.' })
    }

    // Verify form exists and is published
    const { rows: [tpl] } = await pool.query(
      'SELECT id, title, status, current_version_id FROM form_templates WHERE id = $1',
      [templateId],
    )
    if (!tpl) return res.status(404).json({ error: 'Form not found' })
    if (tpl.status !== 'published' || !tpl.current_version_id) {
      return res.status(400).json({ error: 'Form must be published before sending.' })
    }

    const sent = []
    const skipped = []

    for (const rawId of client_ids) {
      const clientId = parseInt(rawId, 10)
      if (isNaN(clientId)) { skipped.push({ client_id: rawId, reason: 'Invalid ID' }); continue }

      // Permission: admin sees all, coach sees only assigned clients
      if (!await canAccessClient(ctx, clientId)) {
        skipped.push({ client_id: clientId, reason: 'Not assigned to you' })
        continue
      }

      // Fetch client details needed for message personalisation + thread routing
      const { rows: [client] } = await pool.query(
        'SELECT id, first_name, coaching_type, client_status FROM users WHERE id = $1',
        [clientId],
      )
      if (!client) { skipped.push({ client_id: clientId, reason: 'Client not found' }); continue }
      if (client.client_status === 'archived' || client.client_status === 'deleted') {
        skipped.push({ client_id: clientId, reason: 'Client is not active' })
        continue
      }

      // Create assignment record
      const { rows: [assignment] } = await pool.query(`
        INSERT INTO form_assignments
          (template_id, client_id, assigned_by, send_at, is_active, assignment_type, status, sent_at)
        VALUES ($1, $2, $3, NOW(), TRUE, 'manual', 'sent', NOW())
        RETURNING id
      `, [templateId, clientId, ctx.dbUserId])

      // Determine thread type and visibility
      // Coaches are limited to coach_thread; admin uses admin_private for AI clients, coach_thread for VIP
      let thread_type = 'coach_thread'
      if (ctx.role === 'admin' && client.coaching_type === 'ai') thread_type = 'ai_admin'

      const visibility = (thread_type === 'admin_private' || thread_type === 'ai_admin')
        ? 'client_and_admin_only'
        : 'client_and_staff'

      const firstName = client.first_name ?? 'there'
      const messageBody = `Hey ${firstName}, please complete your ${tpl.title} when you have a chance.`
      const metadata = { form_id: templateId, assignment_id: assignment.id, form_title: tpl.title }

      await pool.query(`
        INSERT INTO client_messages
          (client_id, sender_id, sender_role, message_body, thread_type, visibility, metadata)
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
      `, [clientId, ctx.dbUserId, ctx.role, messageBody, thread_type, visibility, JSON.stringify(metadata)])

      sent.push({ client_id: clientId, assignment_id: assignment.id })
    }

    res.status(201).json({
      sent:         sent.length,
      skipped:      skipped.length,
      sent_list:    sent,
      skipped_list: skipped,
    })
  } catch (err) { next(err) }
})

// ─── Form Scheduling ──────────────────────────────────────────────────────────

// Helper: next occurrence of dayOfWeek/hour/minute after `after`
function computeNextSendAt(dayOfWeek, hour, minute = 0, after = new Date()) {
  const dt = new Date(after)
  dt.setHours(hour, minute, 0, 0)
  const currentDay = dt.getDay()
  let daysUntil = (dayOfWeek - currentDay + 7) % 7
  if (daysUntil === 0 && dt <= after) daysUntil = 7
  dt.setDate(dt.getDate() + daysUntil)
  return dt
}

// POST /api/coach-admin/forms/:id/schedule
// Body: { client_ids, send_mode:'scheduled'|'recurring', send_at:ISO, recurring_rule:{day_of_week,hour,minute} }
router.post('/forms/:id/schedule', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return

    const templateId = parseInt(req.params.id, 10)
    const { client_ids, send_mode, send_at, recurring_rule } = req.body

    if (!Array.isArray(client_ids) || client_ids.length === 0)
      return res.status(400).json({ error: 'client_ids must be a non-empty array.' })
    if (!['scheduled', 'recurring'].includes(send_mode))
      return res.status(400).json({ error: 'send_mode must be scheduled or recurring.' })
    if (send_mode === 'scheduled' && !send_at)
      return res.status(400).json({ error: 'send_at is required for scheduled sends.' })
    if (send_mode === 'recurring' && (!recurring_rule || recurring_rule.day_of_week == null || recurring_rule.hour == null))
      return res.status(400).json({ error: 'recurring_rule with day_of_week and hour is required for recurring sends.' })

    const { rows: [tpl] } = await pool.query(
      'SELECT id, title, status, current_version_id FROM form_templates WHERE id = $1',
      [templateId],
    )
    if (!tpl) return res.status(404).json({ error: 'Form not found' })
    if (tpl.status !== 'published' || !tpl.current_version_id)
      return res.status(400).json({ error: 'Form must be published before scheduling.' })

    const scheduled = []
    const skipped   = []

    for (const rawId of client_ids) {
      const clientId = parseInt(rawId, 10)
      if (isNaN(clientId)) { skipped.push({ client_id: rawId, reason: 'Invalid ID' }); continue }

      if (!await canAccessClient(ctx, clientId)) {
        skipped.push({ client_id: clientId, reason: 'Not assigned to you' }); continue
      }

      const { rows: [client] } = await pool.query(
        'SELECT id, first_name, client_status FROM users WHERE id = $1',
        [clientId],
      )
      if (!client) { skipped.push({ client_id: clientId, reason: 'Client not found' }); continue }
      if (client.client_status === 'archived' || client.client_status === 'deleted') {
        skipped.push({ client_id: clientId, reason: 'Client is not active' }); continue
      }

      let nextSendAt, recurringRuleJson = null, status

      if (send_mode === 'scheduled') {
        nextSendAt = new Date(send_at)
        status     = 'pending'
      } else {
        const rule    = recurring_rule
        nextSendAt    = computeNextSendAt(rule.day_of_week, rule.hour, rule.minute ?? 0)
        recurringRuleJson = JSON.stringify(rule)
        status        = 'active'
      }

      const { rows: [assignment] } = await pool.query(`
        INSERT INTO form_assignments
          (template_id, client_id, assigned_by, send_at, recurring_rule, is_active,
           assignment_type, status, next_send_at)
        VALUES ($1, $2, $3, $4, $5::jsonb, TRUE, $6, $7, $8)
        RETURNING id
      `, [templateId, clientId, ctx.dbUserId, nextSendAt, recurringRuleJson, send_mode, status, nextSendAt])

      scheduled.push({ client_id: clientId, assignment_id: assignment.id })
    }

    res.status(201).json({
      scheduled:      scheduled.length,
      skipped:        skipped.length,
      scheduled_list: scheduled,
      skipped_list:   skipped,
    })
  } catch (err) { next(err) }
})

// GET /api/coach-admin/form-schedules
// Returns all non-manual assignments; admin sees all, coach sees assigned clients only.
router.get('/form-schedules', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return

    const baseSelect = `
      SELECT fa.id, fa.template_id, fa.client_id, fa.assigned_by,
             fa.assignment_type, fa.status, fa.next_send_at, fa.last_sent_at,
             fa.sent_at, fa.recurring_rule, fa.created_at, fa.is_active,
             ft.title AS form_title,
             u.first_name AS client_first_name, u.last_name AS client_last_name
      FROM form_assignments fa
      JOIN form_templates ft ON ft.id = fa.template_id
      JOIN users u ON u.id = fa.client_id
      WHERE fa.assignment_type IN ('scheduled', 'recurring')
    `

    let rows
    if (ctx.role === 'admin') {
      ;({ rows } = await pool.query(baseSelect + ' ORDER BY fa.created_at DESC LIMIT 200'))
    } else {
      ;({ rows } = await pool.query(
        baseSelect + ' AND u.assigned_coach_id = $1 ORDER BY fa.created_at DESC LIMIT 200',
        [ctx.dbUserId],
      ))
    }

    res.json(rows)
  } catch (err) { next(err) }
})

// PATCH /api/coach-admin/form-schedules/:id/cancel
router.patch('/form-schedules/:id/cancel', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const id  = parseInt(req.params.id, 10)

    const { rows: [fa] } = await pool.query(
      'SELECT id, client_id, assignment_type, status FROM form_assignments WHERE id = $1',
      [id],
    )
    if (!fa) return res.status(404).json({ error: 'Schedule not found' })
    if (!await canAccessClient(ctx, fa.client_id))
      return res.status(403).json({ error: 'Not your client' })
    if (!['scheduled', 'recurring'].includes(fa.assignment_type))
      return res.status(400).json({ error: 'Only scheduled or recurring form sends can be cancelled.' })
    if (fa.assignment_type === 'scheduled' && fa.status !== 'pending')
      return res.status(400).json({ error: 'Only pending scheduled sends can be cancelled.' })
    if (fa.assignment_type === 'recurring' && !['active', 'paused'].includes(fa.status))
      return res.status(400).json({ error: 'Only active or paused recurring schedules can be cancelled.' })

    const { rows: [updated] } = await pool.query(
      `UPDATE form_assignments SET status = 'cancelled', is_active = FALSE WHERE id = $1 RETURNING *`,
      [id],
    )
    res.json(updated)
  } catch (err) { next(err) }
})

// PATCH /api/coach-admin/form-schedules/:id/pause  (recurring only)
router.patch('/form-schedules/:id/pause', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const id  = parseInt(req.params.id, 10)

    const { rows: [fa] } = await pool.query(
      'SELECT id, client_id, assignment_type, status FROM form_assignments WHERE id = $1',
      [id],
    )
    if (!fa) return res.status(404).json({ error: 'Schedule not found' })
    if (fa.assignment_type !== 'recurring') return res.status(400).json({ error: 'Only recurring schedules can be paused.' })
    if (!await canAccessClient(ctx, fa.client_id)) return res.status(403).json({ error: 'Not your client' })
    if (fa.status !== 'active') return res.status(400).json({ error: 'Only active recurring schedules can be paused.' })

    const { rows: [updated] } = await pool.query(
      `UPDATE form_assignments SET status = 'paused', is_active = FALSE WHERE id = $1 RETURNING *`,
      [id],
    )
    res.json(updated)
  } catch (err) { next(err) }
})

// PATCH /api/coach-admin/form-schedules/:id/resume  (recurring only)
router.patch('/form-schedules/:id/resume', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const id  = parseInt(req.params.id, 10)

    const { rows: [fa] } = await pool.query(
      'SELECT id, client_id, assignment_type, status, recurring_rule FROM form_assignments WHERE id = $1',
      [id],
    )
    if (!fa) return res.status(404).json({ error: 'Schedule not found' })
    if (fa.assignment_type !== 'recurring') return res.status(400).json({ error: 'Only recurring schedules can be resumed.' })
    if (!await canAccessClient(ctx, fa.client_id)) return res.status(403).json({ error: 'Not your client' })
    if (fa.status !== 'paused') return res.status(400).json({ error: 'Only paused recurring schedules can be resumed.' })

    const rule     = fa.recurring_rule
    const nextSend = computeNextSendAt(rule.day_of_week, rule.hour, rule.minute ?? 0)

    const { rows: [updated] } = await pool.query(
      `UPDATE form_assignments SET status = 'active', is_active = TRUE, next_send_at = $1 WHERE id = $2 RETURNING *`,
      [nextSend, id],
    )
    res.json(updated)
  } catch (err) { next(err) }
})

// POST /api/coach-admin/form-schedules/process  (admin only — manual trigger)
router.post('/form-schedules/process', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireAdmin(req, res); if (!ctx) return
    const { processFormSchedules } = await import('../jobs/formScheduler.js')
    const count = await processFormSchedules()
    res.json({ processed: count })
  } catch (err) { next(err) }
})

export default router
