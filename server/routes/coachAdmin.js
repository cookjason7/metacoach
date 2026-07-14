import { Router } from 'express'
import { requireAuth, getAuth, clerkClient } from '@clerk/express'
import { v2 as cloudinary } from 'cloudinary'
import { pool, getOrCreateUser } from '../db.js'
import { sendInviteEmail } from '../services/email.js'
import { getAppBaseUrl } from '../services/appUrl.js'
import { notifyNewDirectMessage, notifyNewFormDelivery } from '../services/pushService.js'
import { generateWorkoutPlan } from '../services/workoutGenerator.js'

const router = Router()

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function getCurrentStaff(req) {
  const { userId } = getAuth(req)
  const dbUserId = await getOrCreateUser(userId)
  const { rows } = await pool.query('SELECT id, role FROM users WHERE id = $1', [dbUserId])
  return { dbUserId, role: rows[0]?.role ?? 'client' }
}

function isAdminRole(role) {
  return role === 'admin' || role === 'account_owner'
}

async function requireStaff(req, res) {
  const ctx = await getCurrentStaff(req)
  if (!isAdminRole(ctx.role) && ctx.role !== 'coach' && ctx.role !== 'staff') {
    res.status(403).json({ error: 'Staff only' })
    return null
  }
  return ctx
}

async function requireAdmin(req, res) {
  const ctx = await getCurrentStaff(req)
  if (!isAdminRole(ctx.role)) {
    res.status(403).json({ error: 'Admin only' })
    return null
  }
  return ctx
}

// Returns true if staff member (admin or coach) can access this client
async function canAccessClient(ctx, clientId) {
  if (isAdminRole(ctx.role)) return true
  const { rows } = await pool.query(
    'SELECT id FROM users WHERE id = $1 AND assigned_coach_id = $2',
    [clientId, ctx.dbUserId],
  )
  return rows.length > 0
}

// True when this admin IS the client's assigned coach — coach_thread and admin_private
// then point at the same person and should present/behave as a single merged thread
// instead of two (a client reply could otherwise land in whichever tab staff wasn't
// looking at, making it look like the message never arrived).
async function isAdminAssignedCoach(ctx, clientId) {
  if (!isAdminRole(ctx.role)) return false
  const { rows } = await pool.query('SELECT assigned_coach_id FROM users WHERE id = $1', [clientId])
  return rows[0]?.assigned_coach_id === ctx.dbUserId
}

// Collapse per-client coach_thread/admin_private row pairs into one 'coach_thread' row
// wherever is_assigned_coach is true. Used to post-process /messaging/inbox and
// /clients/:id/thread-types results (see isAdminAssignedCoach).
function mergeAssignedCoachRows(rows) {
  const passthrough = []
  const byClient = new Map()
  for (const row of rows) {
    const mergeable = row.is_assigned_coach === true
      && (row.thread_type === 'coach_thread' || row.thread_type === 'admin_private')
    if (!mergeable) { passthrough.push(row); continue }
    const existing = byClient.get(row.client_id)
    if (!existing) {
      byClient.set(row.client_id, { ...row, thread_type: 'coach_thread' })
      continue
    }
    existing.unread = (Number(existing.unread) || 0) + (Number(row.unread) || 0)
    existing.marked_unread = existing.marked_unread || row.marked_unread
    existing.archived = existing.archived && row.archived
    const existingTime = existing.last_message_at ? new Date(existing.last_message_at).getTime() : -1
    const rowTime = row.last_message_at ? new Date(row.last_message_at).getTime() : -1
    if (rowTime > existingTime) {
      existing.last_message_at = row.last_message_at
      existing.last_message_body = row.last_message_body
      if ('last_sender_role' in row) existing.last_sender_role = row.last_sender_role
    }
  }
  return [...passthrough, ...byClient.values()]
}

function publicIdFromCloudinaryUrl(url) {
  try {
    const parsed = new URL(url)
    const parts = parsed.pathname.split('/').filter(Boolean)
    const uploadIdx = parts.indexOf('upload')
    if (uploadIdx === -1) return null
    const assetParts = parts.slice(uploadIdx + 1).filter(p => !/^v\d+$/.test(p))
    const joined = assetParts.join('/')
    return joined.replace(/\.[a-zA-Z0-9]+$/, '') || null
  } catch {
    return null
  }
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

// GET /api/coach-admin/clients?status=active|deactivated|all (default active)
router.get('/clients', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const params = []
    let where = `WHERE u.role = 'client' AND COALESCE(u.client_status, 'active') != 'deleted'`

    const statusFilter = req.query.status ?? 'active'
    if (statusFilter === 'active') {
      where += ` AND COALESCE(u.client_status, 'active') = 'active'`
    } else if (statusFilter === 'deactivated') {
      where += ` AND u.client_status = 'deactivated'`
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
        COALESCE(u.last_name, ha.last_name,
          (SELECT ci.last_name FROM client_invites ci WHERE ci.email = u.email AND ci.last_name IS NOT NULL AND ci.last_name <> '' ORDER BY ci.created_at DESC LIMIT 1),
          CASE WHEN u.name LIKE '% %'
            THEN LTRIM(SUBSTRING(u.name FROM POSITION(' ' IN u.name)))
          END
        ) AS display_last_name,
        COALESCE(u.phone_number, ha.phone)            AS phone_number,
        u.email,
        u.goal_calories, u.goal_protein, u.goal_carbs, u.goal_fat,
        u.coaching_type, u.assigned_coach_id, u.role,
        u.onboarding_complete, u.assessment_complete,
        u.last_login_at, u.start_date, u.paid, u.paid_at, u.created_at,
        u.client_status, u.deactivated_at,
        -- Effective start date: explicit start_date → paid_at → created_at
        COALESCE(u.start_date, u.paid_at::date, u.created_at::date) AS effective_start_date,
        (SELECT first_name FROM users WHERE id = u.assigned_coach_id) AS assigned_coach_name,
        (SELECT email      FROM users WHERE id = u.assigned_coach_id) AS assigned_coach_email,
        (SELECT MAX(logged_at) FROM meals WHERE user_id = u.id) AS last_meal_at,
        (SELECT MAX(submitted_at) FROM form_submissions WHERE user_id = u.id) AS last_checkin_at,
        (SELECT COUNT(*) FROM form_submissions fs2
         JOIN form_templates ft2 ON ft2.id = fs2.template_id
         WHERE fs2.user_id = u.id
           AND fs2.submitted_at >= NOW() - INTERVAL '8 days'
           AND ft2.title ILIKE '%check%in%') > 0 AS check_in_this_week,
        -- ID + reviewed state of the most recent check-in submission (for the 🙂 replied button)
        (SELECT fs3.id FROM form_submissions fs3
         JOIN form_templates ft3 ON ft3.id = fs3.template_id
         WHERE fs3.user_id = u.id AND ft3.title ILIKE '%check%in%'
         ORDER BY fs3.submitted_at DESC LIMIT 1) AS latest_checkin_submission_id,
        (SELECT fs3.reviewed_at IS NOT NULL FROM form_submissions fs3
         JOIN form_templates ft3 ON ft3.id = fs3.template_id
         WHERE fs3.user_id = u.id AND ft3.title ILIKE '%check%in%'
         ORDER BY fs3.submitted_at DESC LIMIT 1) AS checkin_reviewed,
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
        AND COALESCE(staff_status, 'active') = 'active'
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
          COALESCE(fs.due_at, fa.send_at, fa.sent_at, fa.next_send_at) AS due_at,
          COALESCE(fs.is_late, FALSE) AS is_late,
          CASE WHEN fs.reviewed_at IS NULL THEN 'Needs review' ELSE 'Reviewed' END AS status
        FROM form_submissions fs
        JOIN accessible_clients ac ON ac.id = fs.user_id
        JOIN form_templates ft ON ft.id = fs.template_id
        LEFT JOIN form_assignments fa ON fa.id = fs.assignment_id
        WHERE fs.reviewed_at IS NULL
          AND ft.title ILIKE '%check%in%'
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
                 'form' AS type,
                 CASE WHEN ft.title ILIKE '%check%in%' THEN 'Submitted check-in: ' || ft.title
                      ELSE 'Submitted form: ' || ft.title
                 END AS label
          FROM form_submissions fs
          JOIN accessible_clients ac ON ac.id = fs.user_id
          JOIN form_templates ft ON ft.id = fs.template_id
          WHERE fs.submitted_at >= NOW() - INTERVAL '30 days'

          UNION ALL

          SELECT m.client_id, ac.client_name, m.created_at AS occurred_at,
                 'message' AS type,
                 CASE WHEN m.audio_url IS NOT NULL AND COALESCE(m.message_body, '') = '' THEN 'Sent voice message'
                      WHEN m.image_url IS NOT NULL AND COALESCE(m.message_body, '') = '' THEN 'Sent photo message'
                      ELSE 'Sent message'
                 END AS label
          FROM client_messages m
          JOIN accessible_clients ac ON ac.id = m.client_id
          WHERE m.sender_role = 'client'
            AND m.deleted_at IS NULL
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
    if (role !== undefined && !isAdminRole(ctx.role)) {
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

// POST /api/coach-admin/staff/invite — admin only, creates staff invite record
// Declared before /staff/:id so Express doesn't treat 'invite' as an :id param.
router.post('/staff/invite', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireAdmin(req, res); if (!ctx) return

    const { first_name, last_name, email, role } = req.body

    if (!first_name?.trim()) return res.status(400).json({ error: 'First name is required.' })
    if (!email?.trim())      return res.status(400).json({ error: 'Email is required.' })

    const resolvedRole = ['coach', 'admin'].includes(role) ? role : 'coach'

    const normalizedEmail = email.trim().toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' })
    }

    // Block if a non-deleted user already exists with this email as staff
    const { rows: existing } = await pool.query(
      `SELECT id, role FROM users WHERE LOWER(email) = $1 AND role IN ('coach', 'admin')`,
      [normalizedEmail],
    )
    if (existing.length > 0) {
      return res.status(409).json({ error: 'A staff member with this email already exists in the system.' })
    }

    // Remove any stale unaccepted staff invite for this email
    await pool.query(
      `DELETE FROM staff_invites WHERE LOWER(email) = $1 AND accepted_at IS NULL`,
      [normalizedEmail],
    )

    const { rows: [invite] } = await pool.query(
      `INSERT INTO staff_invites (email, first_name, last_name, role, invited_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING token, email, first_name, last_name, role, created_at, expires_at`,
      [
        normalizedEmail,
        first_name.trim(),
        last_name?.trim() || null,
        resolvedRole,
        ctx.dbUserId,
      ],
    )

    const appUrl    = getAppBaseUrl()
    const inviteUrl = `${appUrl}/staff-invite/${invite.token}`

    res.status(201).json({
      ok:         true,
      invite_url: inviteUrl,
      first_name: invite.first_name,
      last_name:  invite.last_name,
      email:      invite.email,
      role:       invite.role,
    })
  } catch (err) { next(err) }
})

router.post('/clients/invite', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return

    const { first_name, last_name, email, phone, assigned_coach_id, coaching_type, notes } = req.body

    if (!first_name?.trim()) return res.status(400).json({ error: 'First name is required.' })
    if (!email?.trim())      return res.status(400).json({ error: 'Email is required.' })

    const validCoachingTypes = ['vip', 'ai', 'hybrid', 'basic']
    const resolvedType = validCoachingTypes.includes(coaching_type) ? coaching_type : 'vip'

    const normalizedEmail = email.trim().toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' })
    }

    // Block if an active or deactivated user already exists for this email.
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
      const isDeactivated = existing[0].client_status === 'deactivated'
      if (isDeactivated) {
        return res.status(409).json({
          error:          'This email belongs to a deactivated client. Reactivate them from the client list before reinviting, or use a different email.',
          is_deactivated: true,
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

    const coachId = (['ai', 'hybrid', 'basic'].includes(resolvedType) || !assigned_coach_id) ? null : parseInt(assigned_coach_id, 10)

    const { rows: [invite] } = await pool.query(
      `INSERT INTO client_invites
         (email, first_name, last_name, phone, assigned_coach_id, coaching_type, notes, invited_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING token, email, first_name, last_name, coaching_type, created_at, expires_at`,
      [
        normalizedEmail,
        first_name.trim(),
        last_name?.trim() || null,
        phone?.trim() || null,
        coachId,
        resolvedType,
        notes?.trim() || null,
        ctx.dbUserId,
      ],
    )

    const appUrl    = getAppBaseUrl()
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
      coaching_type: invite.coaching_type,
    })
  } catch (err) { next(err) }
})

// GET /api/coach-admin/clients/pending-invites — staff+, returns unaccepted invites
// Must be declared before /clients/:id so Express doesn't treat 'pending-invites' as an id.
router.get('/clients/pending-invites', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const appUrl = getAppBaseUrl()

    const params = []
    let extra = ''
    if (ctx.role === 'coach') {
      params.push(ctx.dbUserId)
      extra = `AND ci.assigned_coach_id = $${params.length}`
    }

    const { rows } = await pool.query(`
      SELECT ci.id, ci.email, ci.first_name, ci.last_name, ci.coaching_type,
             ci.created_at, ci.expires_at, ci.token,
             (SELECT first_name FROM users WHERE id = ci.invited_by)      AS invited_by_name,
             (SELECT first_name FROM users WHERE id = ci.assigned_coach_id) AS assigned_coach_name
      FROM client_invites ci
      WHERE ci.accepted_at IS NULL
        AND (ci.expires_at IS NULL OR ci.expires_at > NOW())
        ${extra}
      ORDER BY ci.created_at DESC
    `, params)

    res.json(rows.map(r => ({ ...r, invite_url: `${appUrl}/invite/${r.token}` })))
  } catch (err) { next(err) }
})

// POST /api/coach-admin/clients/pending-invites/:id/resend — resend invite email
router.post('/clients/pending-invites/:id/resend', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const id = parseInt(req.params.id, 10)

    const { rows } = await pool.query(
      `SELECT * FROM client_invites WHERE id = $1 AND accepted_at IS NULL`,
      [id],
    )
    if (!rows.length) return res.status(404).json({ error: 'Invite not found or already accepted.' })

    const invite  = rows[0]
    const appUrl  = getAppBaseUrl()
    const inviteUrl = `${appUrl}/invite/${invite.token}`

    let emailResult = { sent: false, reason: 'Email send skipped' }
    try {
      emailResult = await Promise.race([
        sendInviteEmail({ to: invite.email, firstName: invite.first_name, inviteUrl }),
        new Promise(resolve => setTimeout(() => resolve({ sent: false, reason: 'Email timed out' }), 12_000)),
      ])
    } catch (emailErr) {
      emailResult = { sent: false, reason: emailErr.message ?? 'Email send failed' }
    }

    res.json({
      ok:         true,
      email_sent: emailResult.sent,
      email_note: emailResult.sent ? null : emailResult.reason,
      invite_url: inviteUrl,
    })
  } catch (err) { next(err) }
})

// DELETE /api/coach-admin/clients/pending-invites/:id — cancel a pending invite
router.delete('/clients/pending-invites/:id', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const id = parseInt(req.params.id, 10)

    // Admins cancel any invite; coaches only ones they created or are assigned to
    const params = [id]
    let extra = ''
    if (ctx.role === 'coach') {
      params.push(ctx.dbUserId)
      extra = `AND (assigned_coach_id = $2 OR invited_by = $2)`
    }

    const { rows } = await pool.query(
      `DELETE FROM client_invites
       WHERE id = $1 AND accepted_at IS NULL ${extra}
       RETURNING id`,
      params,
    )

    if (!rows.length) return res.status(404).json({ error: 'Invite not found, already accepted, or you do not have permission.' })
    res.json({ ok: true })
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
        lw.latest_weight_lbs,
        lw.latest_weight_source,
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
        ha.activity_level       AS assessment_activity_level,
        ha.completed_at         AS assessment_completed_at,
        bi.confirmed_age        AS confirmed_age,
        bi.confirmed_sex        AS confirmed_sex,
        bi.confirmed_height_inches AS confirmed_height_inches,
        bi.confirmed_weight_lbs AS confirmed_weight_lbs
      FROM users u
      LEFT JOIN LATERAL (
        SELECT ROUND(weight_lbs::numeric, 1) AS latest_weight_lbs, source AS latest_weight_source
        FROM (
          SELECT dl.weight_lbs, dl.logged_date AS entry_date, 'daily_log' AS source
          FROM daily_logs dl
          WHERE dl.user_id = u.id AND dl.weight_lbs IS NOT NULL
          UNION ALL
          SELECT wc.current_weight AS weight_lbs, wc.week_start AS entry_date, 'weekly_checkin' AS source
          FROM weekly_checkins wc
          WHERE wc.user_id = u.id AND wc.current_weight IS NOT NULL
        ) weights
        ORDER BY entry_date DESC
        LIMIT 1
      ) lw ON TRUE
      LEFT JOIN health_assessments ha ON ha.user_id = u.id
      LEFT JOIN bloodwork_intake bi ON bi.user_id = u.id
      LEFT JOIN LATERAL (
        SELECT ci.first_name AS invite_first_name, ci.last_name AS invite_last_name
        FROM client_invites ci
        WHERE ci.email = u.email
          AND (ci.first_name IS NOT NULL OR ci.last_name IS NOT NULL)
        ORDER BY ci.created_at DESC LIMIT 1
      ) ci_name ON TRUE
      WHERE u.id = $1
    `, [id])
    if (!rows.length) return res.status(404).json({ error: 'Client not found' })

    const c = rows[0]
    const ageFromDob = dob => {
      if (!dob) return null
      const birth = new Date(dob)
      if (Number.isNaN(birth.getTime())) return null
      const today = new Date()
      let years = today.getFullYear() - birth.getFullYear()
      const monthDiff = today.getMonth() - birth.getMonth()
      if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birth.getDate())) years -= 1
      return years > 0 ? years : null
    }
    const firstPresent = (...values) => values.find(v => v !== null && v !== undefined && v !== '') ?? null
    const firstPositive = (...values) => values.find(v => {
      if (v === null || v === undefined || v === '') return false
      const n = Number(v)
      return Number.isFinite(n) && n > 0
    }) ?? null

    // Field fallback chain: users table → health_assessments → null
    const merged = {
      ...c,
      // Build display name: users table → health_assessments → client_invites → name split
      display_first_name: c.first_name || c.assessment_first_name
        || c.invite_first_name
        || (c.name ? c.name.split(' ')[0] : null) || null,
      display_last_name: c.last_name || c.assessment_last_name
        || c.invite_last_name
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
      // True when the client has actually completed the health assessment form.
      // Use assessment_complete (users table flag) as the primary signal — it is set
      // atomically by the completion handler and is more reliable than checking whether
      // health_assessments contact fields are populated (they can be NULL if an earlier
      // fire-and-forget autosave failed silently before final completion).
      assessment_has_data: !!(c.assessment_complete || c.assessment_completed_at),
      nutrition_calculator_defaults: {
        sex:             firstPresent(c.gender, c.confirmed_sex),
        age:             firstPositive(ageFromDob(c.assessment_dob), c.age, c.confirmed_age),
        height_inches:   firstPositive(c.height_inches, c.confirmed_height_inches),
        weight_lbs:      firstPositive(c.latest_weight_lbs, c.confirmed_weight_lbs, c.starting_weight_lbs),
        weight_source:   c.latest_weight_lbs != null ? c.latest_weight_source : c.confirmed_weight_lbs != null ? 'confirmed_weight' : c.starting_weight_lbs != null ? 'starting_weight' : null,
        goal_weight_lbs: firstPositive(c.goal_weight_lbs),
        activity_level:  firstPresent(c.activity_level, c.assessment_activity_level),
      },
      status_tag: computeStatusTag(c),
      momentum: computeMomentum(c.adherence_7d, c.adherence_30d),
    }
    // Payment status is not shown in the Client Info view — strip before responding.
    // (The underlying `paid` / `paid_at` data is untouched in the database.)
    delete merged.paid
    delete merged.paid_at
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
                     'program_end_date', 'phone_number', 'paid', 'first_name', 'last_name',
                     'starting_weight_lbs']
    const setClauses = []
    const params = []
    for (const key of allowed) {
      if (key in req.body) {
        let value = req.body[key]
        if (key === 'coaching_type' && !['vip', 'ai', 'hybrid', 'basic'].includes(value)) {
          return res.status(400).json({ error: 'coaching_type must be vip, ai, hybrid, or basic' })
        }
        // Normalize empty string → NULL for these fields
        if (key === 'assigned_coach_id') {
          value = (value === '' || value === null) ? null : Number(value)
        }
        if ((key === 'start_date' || key === 'program_end_date') && value === '') value = null
        if (key === 'starting_weight_lbs') {
          value = (value === '' || value === null) ? null : Number(value)
        }
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

// ─── Lifecycle: deactivate / reactivate / soft-delete ─────────────────────────

// PATCH /api/coach-admin/clients/:id/deactivate
// Blocks the client's access two ways: (1) revokes any Clerk sessions they
// currently hold, so they're logged out immediately, and (2) flips
// client_status to 'deactivated', which the global blockDeactivatedClients
// middleware (server/index.js) checks on every subsequent request — so even a
// freshly-issued session can't be used again until they're reactivated.
router.patch('/clients/:id/deactivate', requireAuth(), async (req, res, next) => {
  try {
    if (await requireAdmin(req, res) === null) return
    const id = parseInt(req.params.id, 10)
    const { userId } = getAuth(req)
    const adminDbId = await getOrCreateUser(userId)

    // Guardrail: admins can never deactivate themselves or another admin account.
    if (id === adminDbId) {
      return res.status(400).json({ error: 'You cannot deactivate your own account.' })
    }
    const { rows: targetRows } = await pool.query('SELECT role FROM users WHERE id = $1', [id])
    if (!targetRows.length) return res.status(404).json({ error: 'Client not found' })
    if (isAdminRole(targetRows[0].role)) {
      return res.status(400).json({ error: 'Admin accounts cannot be deactivated.' })
    }

    const { rows } = await pool.query(`
      UPDATE users
      SET client_status = 'deactivated',
          deactivated_at = NOW(),
          deactivated_by = $2
      WHERE id = $1 AND COALESCE(client_status, 'active') != 'deleted'
      RETURNING id, client_status, deactivated_at, clerk_user_id
    `, [id, adminDbId])
    if (!rows.length) return res.status(404).json({ error: 'Client not found' })

    const clerkUserId = rows[0].clerk_user_id
    if (clerkUserId) {
      try {
        const { data: sessions } = await clerkClient.sessions.getSessionList({ userId: clerkUserId, status: 'active' })
        await Promise.all(sessions.map(s => clerkClient.sessions.revokeSession(s.id)))
      } catch (sessionErr) {
        console.error('[deactivate] failed to revoke Clerk sessions:', sessionErr.message)
      }
    }

    res.json({ ok: true, id: rows[0].id, client_status: rows[0].client_status, deactivated_at: rows[0].deactivated_at })
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
          deactivated_at = NULL,
          deactivated_by = NULL,
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
        (SELECT COUNT(*) FROM workout_logs WHERE user_id = $1 AND completed_at >= ${wk})
          + (SELECT COUNT(*) FROM activity_logs WHERE user_id = $1 AND logged_at >= ${wk}) AS movement_week,
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

// GET /api/coach-admin/clients/:id/health-connections — Apple Health / Google
// Health-Fitbit connection status for the coach/admin Overview tab.
//
// Google Health/Fitbit has a real connection record (fitbit_tokens row created
// at OAuth time, deleted on disconnect), so `connected` reflects that directly.
//
// Apple Health has no equivalent — syncs are pushed from the client app with no
// persistent "connected" flag or token to check. The best available signal is
// whether any daily_logs row has ever been written with steps_source or
// sleep_source = 'apple_health'; `connected` here means "has synced at least
// once", and last_synced_at is the actual proxy coaches should read.
router.get('/clients/:id/health-connections', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const id = parseInt(req.params.id, 10)
    if (!await canAccessClient(ctx, id)) return res.status(403).json({ error: 'Forbidden' })

    const [{ rows: fitbitRows }, { rows: appleRows }] = await Promise.all([
      pool.query(
        `SELECT last_synced_at, last_sync_error FROM fitbit_tokens WHERE user_id = $1`,
        [id],
      ),
      pool.query(
        `SELECT
           MAX(steps_source_updated_at) FILTER (WHERE steps_source = 'apple_health') AS last_steps_sync,
           MAX(sleep_source_updated_at) FILTER (WHERE sleep_source = 'apple_health') AS last_sleep_sync
         FROM daily_logs WHERE user_id = $1`,
        [id],
      ),
    ])

    const fitbit = fitbitRows[0]
    const apple  = appleRows[0]
    const appleLastSyncedAt = [apple?.last_steps_sync, apple?.last_sleep_sync]
      .filter(Boolean)
      .sort((a, b) => new Date(b) - new Date(a))[0] ?? null

    res.json({
      google_health: {
        connected:       Boolean(fitbit),
        last_synced_at:  fitbit?.last_synced_at  ?? null,
        last_sync_error: fitbit?.last_sync_error ?? null,
      },
      apple_health: {
        connected:      appleLastSyncedAt !== null,
        last_synced_at: appleLastSyncedAt,
      },
    })
  } catch (err) { next(err) }
})

// GET /api/coach-admin/clients/:id/progress?range=daily|weekly|monthly|custom&start_date=YYYY-MM-DD&end_date=YYYY-MM-DD
router.get('/clients/:id/progress', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const id  = parseInt(req.params.id, 10)
    if (!await canAccessClient(ctx, id)) return res.status(403).json({ error: 'Forbidden' })

    const range = ['daily','weekly','monthly','custom'].includes(req.query.range) ? req.query.range : 'daily'
    const isoDate = d => d.toISOString().slice(0, 10)
    const shiftDays = n => {
      const d = new Date()
      d.setHours(12, 0, 0, 0)
      d.setDate(d.getDate() - n)
      return isoDate(d)
    }
    const validDate = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
    let startDate = range === 'daily' ? shiftDays(30) : range === 'weekly' ? shiftDays(84) : shiftDays(180)
    let endDate   = shiftDays(0)
    if (range === 'custom') {
      if (!validDate(req.query.start_date) || !validDate(req.query.end_date)) {
        return res.status(400).json({ error: 'Custom range requires start_date and end_date in YYYY-MM-DD format.' })
      }
      startDate = req.query.start_date
      endDate   = req.query.end_date
      if (startDate > endDate) return res.status(400).json({ error: 'start_date must be on or before end_date.' })
    }
    const md    = `COALESCE(log_date, logged_at::date)` // meal date expression
    // PostgreSQL DATE_TRUNC('week', ...) groups by ISO week: Monday through Sunday.
    const group = range === 'monthly'
      ? { exprLog: `DATE_TRUNC('month', logged_date)::date`, exprMeal: `DATE_TRUNC('month', d)::date`, exprWorkout: `DATE_TRUNC('month', completed_at)::date`, exprActivity: `DATE_TRUNC('month', logged_at)::date`, exprCheckin: `DATE_TRUNC('month', week_start)::date` }
      : range === 'weekly'
        ? { exprLog: `DATE_TRUNC('week', logged_date)::date`, exprMeal: `DATE_TRUNC('week', d)::date`, exprWorkout: `DATE_TRUNC('week', completed_at)::date`, exprActivity: `DATE_TRUNC('week', logged_at)::date`, exprCheckin: `DATE_TRUNC('week', week_start)::date` }
        : { exprLog: `logged_date`, exprMeal: `d`, exprWorkout: `completed_at::date`, exprActivity: `logged_at::date`, exprCheckin: `DATE_TRUNC('week', week_start)::date` }
    const isDailyLike = range === 'daily' || range === 'custom'

    // ── Per-range series queries ──────────────────────────────────────────────
    const wt_q  = isDailyLike
      ? `SELECT logged_date AS date, ROUND(weight_lbs::numeric,1) AS value
         FROM daily_logs WHERE user_id=$1 AND weight_lbs IS NOT NULL
           AND logged_date BETWEEN $2::date AND $3::date ORDER BY logged_date`
      : `SELECT ${group.exprLog} AS date, ROUND(AVG(weight_lbs)::numeric,1) AS value
         FROM daily_logs WHERE user_id=$1 AND weight_lbs IS NOT NULL
           AND logged_date BETWEEN $2::date AND $3::date
         GROUP BY 1 ORDER BY 1`
    const mac_q = isDailyLike
      ? `SELECT ${md} AS date,
           ROUND(SUM(calories)) AS calories, ROUND(SUM(protein)::numeric,1) AS protein,
           ROUND(SUM(carbs)::numeric,1) AS carbs, ROUND(SUM(fat)::numeric,1) AS fat,
           ROUND(COALESCE(SUM((micronutrients->>'sodium_mg')::numeric),0)) AS sodium_mg,
           ROUND(COALESCE(SUM(fiber)::numeric,0),1) AS fiber,
           ROUND(COALESCE(SUM(sugar)::numeric,0),1) AS sugar
         FROM meals WHERE user_id=$1 AND ${md} BETWEEN $2::date AND $3::date
         GROUP BY ${md} ORDER BY ${md}`
      : `SELECT ${group.exprMeal} AS date,
           ROUND(AVG(cal)) AS calories, ROUND(AVG(prot)::numeric,1) AS protein,
           ROUND(AVG(crb)::numeric,1) AS carbs, ROUND(AVG(ft)::numeric,1) AS fat,
           ROUND(AVG(sod), 0) AS sodium_mg,
           ROUND(AVG(fib)::numeric,1) AS fiber,
           ROUND(AVG(sug)::numeric,1) AS sugar
         FROM (SELECT ${md} AS d, SUM(calories) cal, SUM(protein) prot,
                 SUM(carbs) crb, SUM(fat) ft,
                 COALESCE(SUM((micronutrients->>'sodium_mg')::numeric),0) sod,
                 COALESCE(SUM(fiber)::numeric,0) fib,
                 COALESCE(SUM(sugar)::numeric,0) sug
               FROM meals WHERE user_id=$1 AND ${md} BETWEEN $2::date AND $3::date GROUP BY d) t
         GROUP BY 1 ORDER BY 1`
    const stp_q = isDailyLike
      ? `SELECT logged_date AS date, steps AS value
         FROM daily_logs WHERE user_id=$1 AND steps IS NOT NULL
           AND logged_date BETWEEN $2::date AND $3::date ORDER BY logged_date`
      : `SELECT ${group.exprLog} AS date, ROUND(AVG(steps)) AS value
         FROM daily_logs WHERE user_id=$1 AND steps IS NOT NULL
           AND logged_date BETWEEN $2::date AND $3::date
         GROUP BY 1 ORDER BY 1`
    const slp_q = isDailyLike
      ? `SELECT logged_date AS date, sleep_minutes AS value
         FROM daily_logs WHERE user_id=$1 AND sleep_minutes IS NOT NULL
           AND logged_date BETWEEN $2::date AND $3::date ORDER BY logged_date`
      : `SELECT ${group.exprLog} AS date, ROUND(AVG(sleep_minutes)) AS value
         FROM daily_logs WHERE user_id=$1 AND sleep_minutes IS NOT NULL
           AND logged_date BETWEEN $2::date AND $3::date
         GROUP BY 1 ORDER BY 1`
    // Movement = workout_logs (completed workouts) + activity_logs (quick logs)
    // Same definition as the client-facing /api/daily-logs/progress endpoint.
    const mov_q = `
      SELECT t.date, SUM(t.cnt)::int AS count FROM (
        SELECT ${group.exprWorkout} AS date, COUNT(*)::int AS cnt
        FROM workout_logs
        WHERE user_id=$1 AND completed_at::date BETWEEN $2::date AND $3::date
        GROUP BY 1
        UNION ALL
        SELECT ${group.exprActivity} AS date, COUNT(*)::int AS cnt
        FROM activity_logs
        WHERE user_id=$1 AND logged_at::date BETWEEN $2::date AND $3::date
        GROUP BY 1
      ) t GROUP BY t.date ORDER BY t.date`
    const chk_q = range === 'monthly'
      ? `SELECT ${group.exprCheckin} AS date,
           ROUND(AVG(sleep_quality)::numeric,1) AS sleep_quality,
           ROUND(AVG(energy)::numeric,1) AS energy,
           ROUND(AVG(stress)::numeric,1) AS stress,
           ROUND(AVG(current_weight)::numeric,1) AS current_weight
         FROM weekly_checkins WHERE user_id=$1 AND week_start BETWEEN $2::date AND $3::date
         GROUP BY 1 ORDER BY 1`
      : `SELECT ${group.exprCheckin} AS date,
           sleep_quality, energy, stress,
           ROUND(current_weight::numeric,1) AS current_weight
         FROM weekly_checkins WHERE user_id=$1 AND week_start BETWEEN $2::date AND $3::date
         ORDER BY week_start`
    const wat_q = isDailyLike
      ? `SELECT logged_date AS date, water_oz AS value
         FROM daily_logs WHERE user_id=$1 AND water_oz IS NOT NULL
           AND logged_date BETWEEN $2::date AND $3::date ORDER BY logged_date`
      : `SELECT ${group.exprLog} AS date, ROUND(AVG(water_oz)::numeric,1) AS value
         FROM daily_logs WHERE user_id=$1 AND water_oz IS NOT NULL
           AND logged_date BETWEEN $2::date AND $3::date
         GROUP BY 1 ORDER BY 1`
    // Notes are per-metric, per-day; for weekly/monthly ranges concatenate same-period notes.
    const noteCol = col => `SELECT ${group.exprLog} AS date, string_agg(${col}, ' | ') AS value
       FROM daily_logs WHERE user_id=$1 AND ${col} IS NOT NULL AND ${col} <> ''
         AND logged_date BETWEEN $2::date AND $3::date
       GROUP BY 1 ORDER BY 1`
    const weight_note_q = noteCol('weight_note')
    const water_note_q  = noteCol('water_note')
    const sleep_note_q  = noteCol('sleep_note')

    // ── Summary — all core metrics follow the selected date range ──────────────
    const sum_q = `
      SELECT
        (SELECT ROUND(weight_lbs::numeric,1) FROM daily_logs WHERE user_id=$1
           AND weight_lbs IS NOT NULL AND logged_date BETWEEN $2::date AND $3::date
           ORDER BY logged_date ASC  LIMIT 1) AS weight_start,
        (SELECT ROUND(weight_lbs::numeric,1) FROM daily_logs WHERE user_id=$1
           AND weight_lbs IS NOT NULL AND logged_date BETWEEN $2::date AND $3::date
           ORDER BY logged_date DESC LIMIT 1) AS weight_end,
        (SELECT ROUND(AVG(dc)) FROM
           (SELECT SUM(calories) dc FROM meals WHERE user_id=$1
              AND ${md} BETWEEN $2::date AND $3::date GROUP BY ${md}) t) AS avg_calories,
        (SELECT ROUND(AVG(dp)::numeric,1) FROM
           (SELECT SUM(protein) dp FROM meals WHERE user_id=$1
              AND ${md} BETWEEN $2::date AND $3::date GROUP BY ${md}) t) AS avg_protein,
        (SELECT ROUND(AVG(steps)) FROM daily_logs WHERE user_id=$1
           AND steps IS NOT NULL AND logged_date BETWEEN $2::date AND $3::date) AS avg_steps,
        (SELECT ROUND(AVG(sleep_minutes)) FROM daily_logs WHERE user_id=$1
           AND sleep_minutes IS NOT NULL AND logged_date BETWEEN $2::date AND $3::date) AS avg_sleep_minutes,
        (SELECT COUNT(*)::int FROM workout_logs WHERE user_id=$1
           AND completed_at::date BETWEEN $2::date AND $3::date) AS workouts_completed,
        (SELECT COUNT(*)::int FROM activity_logs WHERE user_id=$1
           AND logged_at::date BETWEEN $2::date AND $3::date) AS activities_completed,
        (SELECT COUNT(DISTINCT ${md})::int FROM meals WHERE user_id=$1
           AND ${md} BETWEEN $2::date AND $3::date) AS logged_day_count,
        (SELECT ROUND(COALESCE(SUM((micronutrients->>'sodium_mg')::numeric),0))
           FROM meals WHERE user_id=$1 AND ${md} BETWEEN $2::date AND $3::date) AS total_sodium_mg,
        (SELECT ROUND(AVG(dns)) FROM
           (SELECT SUM((micronutrients->>'sodium_mg')::numeric) dns FROM meals WHERE user_id=$1
              AND ${md} BETWEEN $2::date AND $3::date GROUP BY ${md}) t) AS avg_sodium_mg`

    const [sumR, wtR, macR, stpR, slpR, movR, chkR, photoR, watR, weightNoteR, waterNoteR, sleepNoteR, profR, wtCurR] = await Promise.all([
      pool.query(sum_q, [id, startDate, endDate]),
      pool.query(wt_q,  [id, startDate, endDate]),
      pool.query(mac_q, [id, startDate, endDate]),
      pool.query(stp_q, [id, startDate, endDate]),
      pool.query(slp_q, [id, startDate, endDate]),
      pool.query(mov_q, [id, startDate, endDate]),
      pool.query(chk_q, [id, startDate, endDate]),
      pool.query(
        `SELECT
           photo_session_id AS session_id,
           MIN(taken_at)    AS session_date,
           json_agg(
             json_build_object(
               'id',        id,
               'photo_url', photo_url,
               'angle',     angle,
               'taken_at',  taken_at
             ) ORDER BY taken_at
           ) AS photos
         FROM progress_photos
         WHERE user_id = $1
           AND taken_at::date BETWEEN $2::date AND $3::date
         GROUP BY photo_session_id
         ORDER BY MIN(taken_at) DESC
         LIMIT 30`,
        [id, startDate, endDate],
      ),
      pool.query(wat_q, [id, startDate, endDate]),
      pool.query(weight_note_q, [id, startDate, endDate]),
      pool.query(water_note_q,  [id, startDate, endDate]),
      pool.query(sleep_note_q,  [id, startDate, endDate]),
      pool.query(`
        SELECT u.age, u.height_inches, u.starting_weight_lbs,
          COALESCE(u.start_date, u.paid_at::date, u.created_at::date) AS effective_start_date,
          u.program_end_date, u.goal_calories, u.goal_protein, u.goal_carbs, u.goal_fat
        FROM users u WHERE u.id = $1
      `, [id]),
      pool.query(`
        SELECT ROUND(weight_lbs::numeric, 1) AS weight_current, source AS weight_current_source
        FROM (
          SELECT dl.weight_lbs, dl.logged_date AS entry_date, 'daily_log' AS source
          FROM daily_logs dl
          WHERE dl.user_id = $1 AND dl.weight_lbs IS NOT NULL
          UNION ALL
          SELECT wc.current_weight AS weight_lbs, wc.week_start AS entry_date, 'weekly_checkin' AS source
          FROM weekly_checkins wc
          WHERE wc.user_id = $1 AND wc.current_weight IS NOT NULL
        ) weights
        ORDER BY entry_date DESC
        LIMIT 1
      `, [id]),
    ])

    // ── Summary: compute weight change + unified movement total ──────────────
    const summary = { ...sumR.rows[0] }
    summary.weight_change = (summary.weight_start != null && summary.weight_end != null)
      ? Math.round((Number(summary.weight_end) - Number(summary.weight_start)) * 10) / 10
      : null
    // total_movement mirrors the client-side definition: workout_logs + activity_logs
    summary.total_movement = (Number(summary.workouts_completed) || 0) + (Number(summary.activities_completed) || 0)

    // ── Merge series into table_rows by date key ──────────────────────────────
    const tmap = new Map()
    const row = (d) => {
      const key = d instanceof Date ? d.toISOString().slice(0,10) : String(d).slice(0,10)
      if (!tmap.has(key)) tmap.set(key, { date: key })
      return tmap.get(key)
    }
    for (const r of wtR.rows)  { const o = row(r.date); o.weight        = r.value }
    for (const r of macR.rows) { const o = row(r.date); o.calories = r.calories; o.protein = r.protein; o.carbs = r.carbs; o.fat = r.fat; o.sodium_mg = r.sodium_mg; o.fiber = r.fiber; o.sugar = r.sugar }
    for (const r of stpR.rows) { const o = row(r.date); o.steps         = r.value }
    for (const r of slpR.rows) { const o = row(r.date); o.sleep_minutes = r.value }
    for (const r of movR.rows) { const o = row(r.date); o.movement      = r.count }
    for (const r of watR.rows) { const o = row(r.date); o.water_oz      = r.value }
    for (const r of weightNoteR.rows) { const o = row(r.date); o.weight_note = r.value }
    for (const r of waterNoteR.rows)  { const o = row(r.date); o.water_note  = r.value }
    for (const r of sleepNoteR.rows)  { const o = row(r.date); o.sleep_note  = r.value }
    for (const r of chkR.rows) {
      const o = row(r.date)
      if (r.sleep_quality  != null) o.sleep_quality = r.sleep_quality
      if (r.energy         != null) o.energy        = r.energy
      if (r.current_weight != null && o.weight == null) o.weight = r.current_weight
    }

    const limit     = isDailyLike ? 14 : range === 'weekly' ? 12 : 6
    const table_rows = [...tmap.values()]
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, limit)
      .map(r => {
        const d = new Date(r.date + 'T12:00:00Z')
        r.period = range === 'monthly'
          ? d.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })
          : range === 'weekly'
            ? (() => {
              const end = new Date(d)
              end.setUTCDate(end.getUTCDate() + 6)
              return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}-${end.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}`
            })()
            : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
        return r
      })

    // Shape photo sessions: photos array → { front, side, back } map per session
    const photoSessions = photoR.rows.map(row => {
      const byAngle = { front: null, side: null, back: null }
      for (const p of row.photos) {
        if (['front', 'side', 'back'].includes(p.angle)) byAngle[p.angle] = p
      }
      return { session_id: row.session_id, session_date: row.session_date, photos: byAngle }
    })

    const prof = profR.rows[0] ?? {}
    const weight_current = wtCurR.rows[0]?.weight_current ?? prof.starting_weight_lbs ?? null
    const weight_current_source = wtCurR.rows[0]?.weight_current_source ?? (prof.starting_weight_lbs != null ? 'starting_weight' : null)
    res.json({ range, start_date: startDate, end_date: endDate, summary, weight_series: wtR.rows, macro_series: macR.rows,
               step_series: stpR.rows, sleep_series: slpR.rows, movement_series: movR.rows,
               checkin_series: chkR.rows, table_rows, progress_photos: photoSessions,
               weight_current,
               weight_current_source,
               age:                  prof.age                  ?? null,
               height_inches:        prof.height_inches        ?? null,
               starting_weight_lbs:  prof.starting_weight_lbs  ?? null,
               effective_start_date: prof.effective_start_date ?? null,
               program_end_date:     prof.program_end_date     ?? null,
               goal_calories:        prof.goal_calories        ?? null,
               goal_protein:         prof.goal_protein         ?? null,
               goal_carbs:           prof.goal_carbs           ?? null,
               goal_fat:             prof.goal_fat             ?? null,
             })
  } catch (err) { next(err) }
})

// ─── Client Measurements ──────────────────────────────────────────────────────

// GET /api/coach-admin/clients/:id/measurements
router.get('/clients/:id/measurements', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const id = parseInt(req.params.id, 10)
    if (!await canAccessClient(ctx, id)) return res.status(403).json({ error: 'Forbidden' })
    const validDate = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
    const hasRange = validDate(req.query.start_date) && validDate(req.query.end_date)
    if ((req.query.start_date || req.query.end_date) && !hasRange) {
      return res.status(400).json({ error: 'Measurements range requires start_date and end_date in YYYY-MM-DD format.' })
    }
    const { rows } = await pool.query(
      `SELECT id, user_id, measurement_date, chest, waist, hips, created_at
       FROM client_measurements WHERE user_id = $1
       ${hasRange ? 'AND measurement_date BETWEEN $2::date AND $3::date' : ''}
       ORDER BY measurement_date DESC, created_at DESC`,
      hasRange ? [id, req.query.start_date, req.query.end_date] : [id],
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

// PATCH /api/coach-admin/clients/:id/measurements/:measurementId
router.patch('/clients/:id/measurements/:measurementId', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const id = parseInt(req.params.id, 10)
    const measurementId = parseInt(req.params.measurementId, 10)
    if (!await canAccessClient(ctx, id)) return res.status(403).json({ error: 'Forbidden' })
    const { measurement_date, chest, waist, hips } = req.body
    const { rows } = await pool.query(
      `UPDATE client_measurements SET
         measurement_date = COALESCE($1::date, measurement_date),
         chest            = $2,
         waist            = $3,
         hips             = $4,
         updated_at       = NOW()
       WHERE id = $5 AND user_id = $6
       RETURNING id, user_id, measurement_date, chest, waist, hips, created_at`,
      [measurement_date || null, chest ?? null, waist ?? null, hips ?? null, measurementId, id],
    )
    if (!rows.length) return res.status(404).json({ error: 'Measurement not found' })
    res.json(rows[0])
  } catch (err) { next(err) }
})

// DELETE /api/coach-admin/clients/:id/measurements/:measurementId
router.delete('/clients/:id/measurements/:measurementId', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const id = parseInt(req.params.id, 10)
    const measurementId = parseInt(req.params.measurementId, 10)
    if (!await canAccessClient(ctx, id)) return res.status(403).json({ error: 'Forbidden' })
    const { rowCount } = await pool.query(
      'DELETE FROM client_measurements WHERE id = $1 AND user_id = $2',
      [measurementId, id],
    )
    if (!rowCount) return res.status(404).json({ error: 'Measurement not found' })
    res.json({ ok: true })
  } catch (err) { next(err) }
})

// DELETE /api/coach-admin/clients/:id/progress-photos/:photoId
router.delete('/clients/:id/progress-photos/:photoId', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const id = parseInt(req.params.id, 10)
    const photoId = parseInt(req.params.photoId, 10)
    if (!await canAccessClient(ctx, id)) return res.status(403).json({ error: 'Forbidden' })
    const { rows } = await pool.query(
      `DELETE FROM progress_photos
       WHERE id = $1 AND user_id = $2
       RETURNING id, photo_url`,
      [photoId, id],
    )
    if (!rows.length) return res.status(404).json({ error: 'Photo not found' })
    const publicId = publicIdFromCloudinaryUrl(rows[0].photo_url)
    if (publicId) {
      cloudinary.uploader.destroy(publicId).catch(err => {
        console.warn('[staff progress photo delete] Cloudinary cleanup skipped:', err.message)
      })
    }
    res.json({ ok: true, id: photoId })
  } catch (err) { next(err) }
})

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
          ROUND(COALESCE(SUM((micronutrients->>'sodium_mg')::numeric), 0))::int AS total_sodium_mg,
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

// POST /api/coach-admin/clients/:id/weight
// Upserts weight_lbs for a given date, preserving all other daily_log fields.
router.post('/clients/:id/weight', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const id = parseInt(req.params.id, 10)
    if (!await canAccessClient(ctx, id)) return res.status(403).json({ error: 'Forbidden' })

    const { date, weight_lbs } = req.body
    if (!date || weight_lbs == null || isNaN(Number(weight_lbs))) {
      return res.status(400).json({ error: 'date and weight_lbs are required' })
    }
    const w = Math.round(Number(weight_lbs) * 10) / 10

    const { rows } = await pool.query(`
      INSERT INTO daily_logs (user_id, logged_date, weight_lbs)
      VALUES ($1, $2::date, $3)
      ON CONFLICT (user_id, logged_date)
      DO UPDATE SET weight_lbs = EXCLUDED.weight_lbs
      RETURNING logged_date, weight_lbs
    `, [id, date, w])

    res.json(rows[0])
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

// ─── Mindset watch progress ───────────────────────────────────────────────────

// GET /api/coach-admin/clients/:id/mindset-progress
router.get('/clients/:id/mindset-progress', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const clientId = parseInt(req.params.id, 10)
    if (!await canAccessClient(ctx, clientId)) return res.status(403).json({ error: 'Forbidden' })

    // Monday midnight UTC as week start
    const now = new Date()
    const weekStart = new Date(now)
    weekStart.setUTCHours(0, 0, 0, 0)
    const daysFromMon = (weekStart.getUTCDay() + 6) % 7
    weekStart.setUTCDate(weekStart.getUTCDate() - daysFromMon)
    const weekStartISO = weekStart.toISOString()

    // All-time totals
    const { rows: totalsRows } = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE vwp.highest_pct >= 50)::int AS watched50_count,
        COUNT(*) FILTER (WHERE vwp.completed = TRUE)::int  AS completed_count
      FROM video_watch_progress vwp
      JOIN mindset_videos mv ON mv.id = vwp.video_id
      WHERE vwp.user_id = $1
    `, [clientId])

    // This-week totals
    const { rows: weekRows } = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE vwp.highest_pct >= 50)::int   AS watched50_count,
        COUNT(*) FILTER (WHERE vwp.completed = TRUE)::int    AS completed_count,
        MAX(vwp.highest_pct)                                 AS best_progress,
        MAX(vwp.last_watched_at)                             AS last_watched_at
      FROM video_watch_progress vwp
      JOIN mindset_videos mv ON mv.id = vwp.video_id
      WHERE vwp.user_id = $1
        AND vwp.last_watched_at >= $2
    `, [clientId, weekStartISO])

    // 3 most recent published in-app videos with progress if it exists
    const { rows: videoRows } = await pool.query(`
      SELECT
        mv.id, mv.title, mv.module_name,
        COALESCE(vwp.highest_pct, 0)    AS highest_pct,
        COALESCE(vwp.completed, FALSE)  AS completed,
        COALESCE(vwp.started, FALSE)    AS started,
        vwp.last_watched_at
      FROM mindset_videos mv
      LEFT JOIN video_watch_progress vwp
        ON vwp.video_id = mv.id AND vwp.user_id = $1
      WHERE mv.published = TRUE
      ORDER BY mv.display_order ASC, mv.created_at DESC
      LIMIT 3
    `, [clientId])

    const week = weekRows[0]
    const totals = totalsRows[0]

    res.json({
      thisWeek: {
        watched50Count: week.watched50_count ?? 0,
        completedCount: week.completed_count ?? 0,
        bestProgress:   week.best_progress != null ? parseFloat(week.best_progress) : null,
        lastWatchedAt:  week.last_watched_at ?? null,
      },
      totals: {
        watched50Count: totals.watched50_count ?? 0,
        completedCount: totals.completed_count ?? 0,
      },
      recentVideos: videoRows.map(r => ({
        id:             r.id,
        title:          r.title,
        module_name:    r.module_name,
        highest_pct:    parseFloat(r.highest_pct),
        completed:      r.completed,
        started:        r.started,
        last_watched_at: r.last_watched_at ?? null,
      })),
    })
  } catch (err) { next(err) }
})

// ─── Identity Momentum snapshot (admin) ──────────────────────────────────────

// GET /api/coach-admin/clients/:id/identity-momentum
// Returns the same identity stage + pillar data computed for the client, so staff
// can see where each client is in their Identity Momentum journey.
router.get('/clients/:id/identity-momentum', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const clientId = parseInt(req.params.id, 10)
    if (!await canAccessClient(ctx, clientId)) return res.status(403).json({ error: 'Forbidden' })

    const now      = new Date()
    const weekStart = new Date(now)
    weekStart.setUTCHours(0, 0, 0, 0)
    const daysFromMon = (weekStart.getUTCDay() + 6) % 7
    weekStart.setUTCDate(weekStart.getUTCDate() - daysFromMon)

    const lastWeekStart  = new Date(weekStart); lastWeekStart.setUTCDate(lastWeekStart.getUTCDate() - 7)
    const twelveWeeksAgo = new Date(weekStart); twelveWeeksAgo.setUTCDate(twelveWeeksAgo.getUTCDate() - 84)

    // Pillar check (mirrors gamification momentum query)
    const { rows: [row] } = await pool.query(`
      SELECT
        (
          (SELECT COUNT(DISTINCT COALESCE(log_date, logged_at::date))
           FROM meals WHERE user_id=$1 AND COALESCE(log_date, logged_at::date) >= $2::date) >= 3
          OR EXISTS (SELECT 1 FROM habit_completions hc JOIN coach_assigned_habits cah ON cah.id = hc.habit_id
            WHERE hc.user_id=$1 AND hc.completion_date >= $2::date AND cah.identity_category = 'food_tracking')
        ) AS food_tracking,
        (
          (SELECT COUNT(*) FROM workout_logs WHERE user_id=$1 AND completed_at >= $2) > 0
          OR (SELECT COUNT(*) FROM daily_logs WHERE user_id=$1 AND steps IS NOT NULL AND logged_date >= $2::date) >= 3
          OR EXISTS (SELECT 1 FROM habit_completions hc JOIN coach_assigned_habits cah ON cah.id = hc.habit_id
            WHERE hc.user_id=$1 AND hc.completion_date >= $2::date AND cah.identity_category = 'movement')
        ) AS movement,
        (
          EXISTS (SELECT 1 FROM video_watch_progress vwp JOIN mindset_videos mv ON mv.id = vwp.video_id
            WHERE vwp.user_id=$1 AND vwp.highest_pct >= 50 AND vwp.last_watched_at >= $2 AND mv.published = TRUE)
          OR EXISTS (SELECT 1 FROM habit_completions hc JOIN coach_assigned_habits cah ON cah.id = hc.habit_id
            WHERE hc.user_id=$1 AND hc.completion_date >= $2::date AND cah.identity_category = 'mindset')
        ) AS mindset,
        (
          (SELECT COUNT(*) FROM form_submissions WHERE user_id=$1 AND submitted_at >= $2) > 0
          OR EXISTS (SELECT 1 FROM habit_completions hc JOIN coach_assigned_habits cah ON cah.id = hc.habit_id
            WHERE hc.user_id=$1 AND hc.completion_date >= $2::date AND cah.identity_category = 'check_ins')
        ) AS check_ins,
        (
          (SELECT COUNT(*) FROM daily_logs WHERE user_id=$1 AND weight_lbs IS NOT NULL AND logged_date >= $2::date) > 0
          OR (SELECT COUNT(*) FROM progress_photos WHERE user_id=$1 AND taken_at >= $2) > 0
          OR EXISTS (SELECT 1 FROM habit_completions hc JOIN coach_assigned_habits cah ON cah.id = hc.habit_id
            WHERE hc.user_id=$1 AND hc.completion_date >= $2::date AND cah.identity_category = 'progress')
        ) AS progress
    `, [clientId, weekStart.toISOString()])

    const categories = [
      { key: 'food_tracking', label: 'Food Tracking', active: row.food_tracking },
      { key: 'movement',      label: 'Movement',      active: row.movement      },
      { key: 'mindset',       label: 'Mindset',       active: row.mindset       },
      { key: 'check_ins',     label: 'Check-Ins',     active: row.check_ins     },
      { key: 'progress',      label: 'Progress',      active: row.progress      },
    ]
    const activeCount = categories.filter(c => c.active).length
    const inactiveCategories = categories.filter(c => !c.active).map(c => c.label)

    // Active weeks (same formula as client endpoint)
    const { rows: [wkRow] } = await pool.query(`
      SELECT COUNT(DISTINCT
        COALESCE(log_date, logged_at::date)
        - ((EXTRACT(DOW FROM COALESCE(log_date, logged_at::date))::int + 6) % 7)
      ) AS active_weeks
      FROM meals
      WHERE user_id=$1
        AND COALESCE(log_date, logged_at::date) >= $2::date
        AND COALESCE(log_date, logged_at::date) <  $3::date
    `, [clientId, twelveWeeksAgo.toISOString(), weekStart.toISOString()])
    const activeWeeks = parseInt(wkRow.active_weeks, 10) || 0

    // Last week meals
    const { rows: [lwRow] } = await pool.query(`
      SELECT COUNT(*) AS meal_count FROM meals
      WHERE user_id=$1
        AND COALESCE(log_date, logged_at::date) >= $2::date
        AND COALESCE(log_date, logged_at::date) <  $3::date
    `, [clientId, lastWeekStart.toISOString(), weekStart.toISOString()])
    const isComeback = (parseInt(lwRow.meal_count, 10) || 0) === 0 && activeWeeks >= 1 && activeCount >= 2

    // Reuse same stage helper logic inline
    let stage, stageDesc
    if (isComeback)          { stage = 'Resilient Warrior';    stageDesc = "Coming back is a choice — and they made it." }
    else if (activeWeeks >= 10) { stage = 'Life Warrior';       stageDesc = "Consistency is their identity now." }
    else if (activeWeeks >= 7)  { stage = 'Consistency Warrior'; stageDesc = "They show up even when it's hard." }
    else if (activeWeeks >= 4)  { stage = 'Self-Trust Builder'; stageDesc = "Building self-trust week by week." }
    else if (activeWeeks >= 2)  { stage = 'Momentum Builder';   stageDesc = "Building momentum, week by week." }
    else                        { stage = 'Starting Strong';    stageDesc = "Early in the journey." }

    res.json({
      identity_stage:      stage,
      stage_description:   stageDesc,
      active_count:        activeCount,
      active_weeks:        activeWeeks,
      categories,
      inactive_categories: inactiveCategories,
      weakest_category:    inactiveCategories[0] ?? null,
      is_comeback:         isComeback,
      comeback_message:    isComeback
        ? "This client returned after a quiet week — acknowledge the comeback."
        : null,
    })
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
      frequency = 'daily', start_date, end_date, days_of_week, notes, identity_category,
    } = req.body
    if (!habit_name?.trim() || !start_date) {
      return res.status(400).json({ error: 'habit_name and start_date required' })
    }
    const VALID_IC = ['food_tracking', 'hydration', 'movement', 'mindset', 'check_ins', 'progress']
    if (identity_category && !VALID_IC.includes(identity_category)) {
      return res.status(400).json({ error: 'Invalid identity_category' })
    }

    const { rows } = await pool.query(`
      INSERT INTO coach_assigned_habits
        (user_id, assigned_by_user_id, habit_name, habit_type, target_value, unit,
         frequency, start_date, end_date, days_of_week, notes, identity_category)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING *
    `, [
      id, ctx.dbUserId,
      habit_name.trim(), habit_type,
      target_value != null ? Number(target_value) : null,
      unit?.trim() || null,
      frequency, start_date, end_date ?? null,
      days_of_week ?? null,
      notes?.trim() || null,
      identity_category ?? null,
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
      frequency, start_date, end_date, days_of_week, notes, active, identity_category,
    } = req.body
    const VALID_IC = ['food_tracking', 'hydration', 'movement', 'mindset', 'check_ins', 'progress']
    if (identity_category && !VALID_IC.includes(identity_category)) {
      return res.status(400).json({ error: 'Invalid identity_category' })
    }

    const { rows } = await pool.query(`
      UPDATE coach_assigned_habits SET
        habit_name        = COALESCE($1, habit_name),
        habit_type        = COALESCE($2, habit_type),
        target_value      = COALESCE($3, target_value),
        unit              = COALESCE($4, unit),
        frequency         = COALESCE($5, frequency),
        start_date        = COALESCE($6, start_date),
        end_date          = $7,
        days_of_week      = COALESCE($8, days_of_week),
        notes             = $9,
        active            = COALESCE($10, active),
        identity_category = COALESCE($11, identity_category),
        updated_at        = NOW()
      WHERE id = $12 RETURNING *
    `, [
      habit_name ?? null, habit_type ?? null,
      target_value != null ? Number(target_value) : null,
      unit ?? null, frequency ?? null,
      start_date ?? null, end_date ?? null, days_of_week ?? null,
      notes ?? null, active ?? null,
      identity_category ?? null,
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
    const visibilityFilter = isAdminRole(ctx.role)
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
    const finalVisibility = (visibility === 'admin_private' && !isAdminRole(ctx.role))
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
    if (!isAdminRole(ctx.role) && nRows[0].author_id !== ctx.dbUserId) {
      return res.status(403).json({ error: 'Cannot delete this note' })
    }
    if (nRows[0].visibility === 'admin_private' && !isAdminRole(ctx.role)) {
      return res.status(403).json({ error: 'Forbidden' })
    }

    await pool.query('DELETE FROM client_notes WHERE id = $1', [noteId])
    res.json({ ok: true })
  } catch (err) { next(err) }
})

// PATCH /api/coach-admin/notes/:noteId
router.patch('/notes/:noteId', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const noteId = parseInt(req.params.noteId, 10)

    const { rows: nRows } = await pool.query(
      'SELECT client_id, author_id, visibility FROM client_notes WHERE id = $1', [noteId]
    )
    if (!nRows.length) return res.status(404).json({ error: 'Note not found' })

    if (!isAdminRole(ctx.role) && nRows[0].author_id !== ctx.dbUserId) {
      return res.status(403).json({ error: 'Cannot edit this note' })
    }
    if (nRows[0].visibility === 'admin_private' && !isAdminRole(ctx.role)) {
      return res.status(403).json({ error: 'Forbidden' })
    }

    const { note_body } = req.body
    if (!note_body || !note_body.trim()) {
      return res.status(400).json({ error: 'note_body is required' })
    }

    const { rows } = await pool.query(
      `UPDATE client_notes SET note_body = $1
       WHERE id = $2
       RETURNING id, client_id, author_id, note_body, visibility, created_at`,
      [note_body.trim(), noteId]
    )
    res.json(rows[0])
  } catch (err) { next(err) }
})

// ─── Messages ─────────────────────────────────────────────────────────────────

// GET /api/coach-admin/messaging/inbox — returns all threads across accessible clients with unread counts
// ?view=active (default) | archived
router.get('/messaging/inbox', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const isAdmin = isAdminRole(ctx.role)
    const wantArchived = req.query.view === 'archived'

    // $1 = ctx.dbUserId (used for states join AND coach scope filter)
    // $2 = wantArchived (archived state filter)
    const params = [ctx.dbUserId, wantArchived]
    let extraWhere = `COALESCE(u.client_status, 'active') != 'deleted'`
      + ` AND m.deleted_at IS NULL`
      + ` AND m.thread_type IN ('admin_private', 'coach_thread', 'ai_admin')`
    if (!isAdmin) {
      extraWhere += ` AND u.assigned_coach_id = $1 AND m.thread_type = 'coach_thread'`
    }
    const { rows } = await pool.query(`
      SELECT
        u.id AS client_id,
        COALESCE(NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), ''), u.first_name, 'Client') AS first_name,
        u.last_name,
        m.thread_type,
        (u.assigned_coach_id = $1) AS is_assigned_coach,
        COUNT(*) FILTER (WHERE m.sender_role = 'client' AND m.read_at IS NULL)::int AS unread,
        COALESCE(sis.marked_unread, FALSE) AS marked_unread,
        COALESCE(sis.archived, FALSE)      AS archived,
        MAX(m.created_at) AS last_message_at,
        (SELECT CASE
            WHEN message_body IS NOT NULL AND message_body != '' THEN message_body
            WHEN audio_url IS NOT NULL THEN 'Voice message'
            WHEN image_url IS NOT NULL THEN 'Image'
            ELSE ''
          END
          FROM client_messages
          WHERE client_id = u.id AND thread_type = m.thread_type AND deleted_at IS NULL
          ORDER BY created_at DESC LIMIT 1) AS last_message_body,
        (SELECT sender_role FROM client_messages
          WHERE client_id = u.id AND thread_type = m.thread_type AND deleted_at IS NULL
          ORDER BY created_at DESC LIMIT 1) AS last_sender_role
      FROM client_messages m
      JOIN users u ON u.id = m.client_id
      LEFT JOIN staff_inbox_states sis
        ON sis.staff_id = $1 AND sis.client_id = u.id AND sis.thread_type = m.thread_type
      WHERE ${extraWhere}
        AND COALESCE(sis.archived, FALSE) = $2
      GROUP BY u.id, u.first_name, u.last_name, m.thread_type, sis.marked_unread, sis.archived
      ORDER BY
        -- Conversations with unread client messages or manually marked-unread
        -- float to the top; within each bucket sort by most recent message.
        (COUNT(*) FILTER (WHERE m.sender_role = 'client' AND m.read_at IS NULL) > 0
         OR COALESCE(sis.marked_unread, FALSE)) DESC,
        MAX(m.created_at) DESC
    `, params)

    // Merge coach_thread + admin_private for clients whose assigned coach is this admin,
    // then restore the unread/recency ordering the SQL above already established.
    const merged = isAdmin ? mergeAssignedCoachRows(rows) : rows
    merged.sort((a, b) => {
      const aUnread = (Number(a.unread) > 0 || a.marked_unread) ? 1 : 0
      const bUnread = (Number(b.unread) > 0 || b.marked_unread) ? 1 : 0
      if (bUnread !== aUnread) return bUnread - aUnread
      const aTime = a.last_message_at ? new Date(a.last_message_at).getTime() : 0
      const bTime = b.last_message_at ? new Date(b.last_message_at).getTime() : 0
      return bTime - aTime
    })
    res.json(merged)
  } catch (err) { next(err) }
})

// GET /api/coach-admin/messaging/unread-count — total unread client messages across
// accessible conversations (nav badge). Mirrors the scoping in messaging/inbox above.
router.get('/messaging/unread-count', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const isAdmin = isAdminRole(ctx.role)

    const params = [ctx.dbUserId]
    let extraWhere = `COALESCE(u.client_status, 'active') != 'deleted'`
      + ` AND m.deleted_at IS NULL`
      + ` AND m.thread_type IN ('admin_private', 'coach_thread', 'ai_admin')`
    if (!isAdmin) {
      extraWhere += ` AND u.assigned_coach_id = $1 AND m.thread_type = 'coach_thread'`
    }
    const { rows } = await pool.query(`
      SELECT COUNT(*) FILTER (WHERE m.sender_role = 'client' AND m.read_at IS NULL)::int AS unread
      FROM client_messages m
      JOIN users u ON u.id = m.client_id
      LEFT JOIN staff_inbox_states sis
        ON sis.staff_id = $1 AND sis.client_id = u.id AND sis.thread_type = m.thread_type
      WHERE ${extraWhere}
        AND COALESCE(sis.archived, FALSE) = FALSE
    `, params)
    res.json({ unread: rows[0]?.unread ?? 0 })
  } catch (err) { next(err) }
})

// GET /api/coach-admin/messaging/client-search?q=... — lightweight name/email search for compose
// Admin: all active clients. Coach: only assigned clients.
// Returns: [{ id, full_name, email, coaching_type }]
router.get('/messaging/client-search', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const q = (req.query.q ?? '').trim()
    if (!q) return res.json([])

    const params = [`%${q}%`, `%${q}%`, ctx.dbUserId]
    let coachFilter = ''
    if (ctx.role === 'coach') {
      coachFilter = ` AND u.assigned_coach_id = $3`
    }

    const { rows } = await pool.query(`
      SELECT
        u.id,
        COALESCE(NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), ''), u.email, 'Client') AS full_name,
        u.email,
        u.coaching_type,
        (u.assigned_coach_id = $3) AS is_assigned_coach
      FROM users u
      WHERE u.role = 'client'
        AND COALESCE(u.client_status, 'active') = 'active'
        AND (
          LOWER(CONCAT_WS(' ', u.first_name, u.last_name)) LIKE LOWER($1)
          OR LOWER(u.email) LIKE LOWER($2)
        )
        ${coachFilter}
      ORDER BY u.first_name, u.last_name
      LIMIT 20
    `, params)
    res.json(rows)
  } catch (err) { next(err) }
})

// GET /api/coach-admin/clients/:id/messages/unread — count unread client messages (staff-side only)
router.get('/clients/:id/messages/unread', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const id = parseInt(req.params.id, 10)
    if (!await canAccessClient(ctx, id)) return res.status(403).json({ error: 'Forbidden' })

    let where = `client_id = $1 AND sender_role = 'client' AND read_at IS NULL AND deleted_at IS NULL`
    const params = [id]
    if (!isAdminRole(ctx.role)) where += ` AND thread_type = 'coach_thread'`

    const { rows: [row] } = await pool.query(
      `SELECT COUNT(*)::int AS unread FROM client_messages WHERE ${where}`, params
    )
    res.json({ unread: row.unread })
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
    if ((thread === 'admin_private' || thread === 'ai_admin') && !isAdminRole(ctx.role)) {
      return res.status(403).json({ error: 'Admin only thread' })
    }

    // When this admin is the client's assigned coach, coach_thread and admin_private
    // are the same person — read and mark-read across both (see isAdminAssignedCoach)
    // so a message sent to either tab is never hidden from the other.
    const merged = (thread === 'coach_thread' || thread === 'admin_private')
      && await isAdminAssignedCoach(ctx, id)
    const threadTypes = merged
      ? ['coach_thread', 'admin_private']
      : thread ? [thread] : (!isAdminRole(ctx.role) ? ['coach_thread'] : null)

    const params = [id]
    let where = 'WHERE m.client_id = $1 AND m.deleted_at IS NULL'
    if (threadTypes) {
      params.push(threadTypes)
      where += ` AND m.thread_type = ANY($${params.length}::text[])`
    }

    const limit = Math.min(parseInt(req.query.limit) || 50, 200)
    const beforeId = req.query.before_id ? parseInt(req.query.before_id) : null

    if (beforeId) {
      params.push(beforeId)
      where += ` AND m.id < $${params.length}`
    }
    params.push(limit + 1)

    const { rows } = await pool.query(`
      SELECT m.*,
        COALESCE(NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), ''), u.first_name) AS sender_name
      FROM client_messages m
      LEFT JOIN users u ON u.id = m.sender_id
      ${where}
      ORDER BY m.id DESC
      LIMIT $${params.length}
    `, params)

    const hasMore = rows.length > limit
    if (hasMore) rows.pop()
    rows.reverse()

    // Mark client messages as read now that staff has viewed the thread
    const readParams = [id]
    let readWhere = `WHERE client_id = $1 AND sender_role = 'client' AND read_at IS NULL`
    if (threadTypes) {
      readParams.push(threadTypes)
      readWhere += ` AND thread_type = ANY($${readParams.length}::text[])`
    }
    await pool.query(`UPDATE client_messages SET read_at = NOW() ${readWhere}`, readParams)

    res.json({
      messages: rows,
      hasMore,
      nextBeforeId: hasMore ? rows[0].id : null,
    })
  } catch (err) { next(err) }
})

// POST /api/coach-admin/clients/:id/messages
router.post('/clients/:id/messages', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const id = parseInt(req.params.id, 10)
    if (!await canAccessClient(ctx, id)) return res.status(403).json({ error: 'Forbidden' })

    const { message_body = '', thread_type = 'coach_thread', image_url, audio_url } = req.body
    if (!message_body?.trim() && !image_url && !audio_url) return res.status(400).json({ error: 'message_body, image, or audio required' })

    // Coach can only send to coach_thread
    if (ctx.role === 'coach' && thread_type !== 'coach_thread') {
      return res.status(403).json({ error: 'Coaches can only send to coach thread' })
    }

    // Canonicalize to coach_thread when this admin is the client's assigned coach, so
    // sends never re-fragment across the two thread_types (see isAdminAssignedCoach).
    const canonicalThreadType = (thread_type === 'coach_thread' || thread_type === 'admin_private')
      && await isAdminAssignedCoach(ctx, id)
      ? 'coach_thread'
      : thread_type

    // Determine visibility based on thread_type
    const visibility = (canonicalThreadType === 'admin_private' || canonicalThreadType === 'ai_admin')
      ? 'client_and_admin_only'
      : 'client_and_staff'

    // If sending to ai_admin, verify client is an AI client
    if (canonicalThreadType === 'ai_admin') {
      const { rows } = await pool.query('SELECT coaching_type FROM users WHERE id = $1', [id])
      if (rows[0]?.coaching_type !== 'ai') {
        return res.status(400).json({ error: 'ai_admin thread is only for AI coaching clients' })
      }
    }

    const { rows } = await pool.query(`
      INSERT INTO client_messages
        (client_id, sender_id, sender_role, message_body, thread_type, visibility, image_url, audio_url)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *
    `, [id, ctx.dbUserId, ctx.role, message_body.trim(), canonicalThreadType, visibility, image_url ?? null, audio_url ?? null])

    // Push: notify the client — fire-and-forget
    notifyNewDirectMessage(id).catch(() => {})

    res.status(201).json(rows[0])
  } catch (err) { next(err) }
})

// POST /api/coach-admin/messages/bulk — broadcast a message to many clients at once
// Body: { client_ids: number[], message_body: string, thread_type?: string (default 'coach_client') }
router.post('/messages/bulk', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const { client_ids, message_body, thread_type = 'coach_client' } = req.body

    if (!Array.isArray(client_ids) || client_ids.length === 0) {
      return res.status(400).json({ error: 'client_ids must be a non-empty array' })
    }
    if (!message_body?.trim()) {
      return res.status(400).json({ error: 'message_body is required' })
    }

    // Coaches can only broadcast to their own coach_thread conversations
    const requestedThreadType = ['coach_thread', 'admin_private', 'coach_client'].includes(thread_type)
      ? thread_type
      : 'coach_thread'
    const effectiveThreadType = requestedThreadType === 'coach_client' ? 'coach_thread' : requestedThreadType
    if (ctx.role === 'coach' && effectiveThreadType !== 'coach_thread') {
      return res.status(403).json({ error: 'Coaches can only send to coach thread' })
    }

    const visibility = effectiveThreadType === 'admin_private' ? 'client_and_admin_only' : 'client_and_staff'
    const trimmedBody = message_body.trim()

    let sent = 0
    const failed = []
    for (const rawId of client_ids) {
      const clientId = parseInt(rawId, 10)
      if (!Number.isInteger(clientId)) { failed.push({ client_id: rawId, error: 'Invalid client id' }); continue }
      try {
        if (!await canAccessClient(ctx, clientId)) {
          failed.push({ client_id: clientId, error: 'Forbidden' })
          continue
        }
        // Canonicalize to coach_thread when this admin is the client's assigned coach, so
        // sends never re-fragment across the two thread_types (see isAdminAssignedCoach).
        const canonicalThreadType = (effectiveThreadType === 'coach_thread' || effectiveThreadType === 'admin_private')
          && await isAdminAssignedCoach(ctx, clientId)
          ? 'coach_thread'
          : effectiveThreadType

        await pool.query(`
          INSERT INTO client_messages
            (client_id, sender_id, sender_role, message_body, thread_type, visibility)
          VALUES ($1, $2, $3, $4, $5, $6)
        `, [clientId, ctx.dbUserId, ctx.role, trimmedBody, canonicalThreadType, visibility])

        notifyNewDirectMessage(clientId).catch(() => {})
        sent++
      } catch (err) {
        failed.push({ client_id: clientId, error: err.message })
      }
    }

    res.json({ sent, failed })
  } catch (err) { next(err) }
})

// DELETE /api/coach-admin/clients/:id/messages/:messageId
// Soft-delete: only the original sender (this staff member) may delete their own message.
// The row is retained with deleted_at set so history/threads stay consistent.
router.delete('/clients/:id/messages/:messageId', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const clientId  = parseInt(req.params.id, 10)
    const messageId = parseInt(req.params.messageId, 10)
    if (!Number.isInteger(messageId)) return res.status(400).json({ error: 'Invalid message id' })
    if (!await canAccessClient(ctx, clientId)) return res.status(403).json({ error: 'Forbidden' })

    const { rows } = await pool.query(
      'SELECT client_id, sender_id, sender_role, deleted_at FROM client_messages WHERE id = $1',
      [messageId],
    )
    const msg = rows[0]
    if (!msg || msg.client_id !== clientId) return res.status(404).json({ error: 'Message not found' })

    // Sender identity check: must be a staff message this exact user sent.
    if (msg.sender_role === 'client' || msg.sender_id !== ctx.dbUserId) {
      return res.status(403).json({ error: 'You can only delete your own messages' })
    }

    if (!msg.deleted_at) {
      await pool.query('UPDATE client_messages SET deleted_at = NOW() WHERE id = $1', [messageId])
    }
    res.json({ ok: true, id: messageId })
  } catch (err) { next(err) }
})

// PATCH /api/coach-admin/messaging/states/:clientId/:threadType
// Upserts per-staff conversation state: archived, marked_unread.
// Body: { archived?: boolean, marked_unread?: boolean }
router.patch('/messaging/states/:clientId/:threadType', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const clientId  = parseInt(req.params.clientId, 10)
    const threadType = req.params.threadType

    // Coaches can only manage their own coach_thread
    if (ctx.role === 'coach' && threadType !== 'coach_thread') {
      return res.status(403).json({ error: 'Coaches can only manage coach_thread conversations' })
    }

    const { archived, marked_unread } = req.body
    const vals = [ctx.dbUserId, clientId, threadType]
    const insertCols = ['staff_id', 'client_id', 'thread_type']
    const insertPlaceholders = ['$1', '$2', '$3']
    const updates = []

    if (typeof archived === 'boolean') {
      insertCols.push('archived')
      insertPlaceholders.push(`$${vals.push(archived)}`)
      updates.push(`archived = EXCLUDED.archived`)
      if (archived) updates.push(`archived_at = NOW()`)
      else          updates.push(`archived_at = NULL`)
    }
    if (typeof marked_unread === 'boolean') {
      insertCols.push('marked_unread')
      insertPlaceholders.push(`$${vals.push(marked_unread)}`)
      updates.push(`marked_unread = EXCLUDED.marked_unread`)
    }

    if (updates.length === 0) return res.json({ ok: true })

    await pool.query(`
      INSERT INTO staff_inbox_states (${insertCols.join(', ')})
      VALUES (${insertPlaceholders.join(', ')})
      ON CONFLICT (staff_id, client_id, thread_type) DO UPDATE SET
        ${updates.join(', ')}
    `, vals)

    res.json({ ok: true })
  } catch (err) { next(err) }
})

// GET /api/coach-admin/clients/:id/thread-types
// Returns all thread types with message counts for this client, ignoring archive state.
// Used by the UI to show thread tabs regardless of which inbox view (active/archived) is open.
router.get('/clients/:id/thread-types', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const id = parseInt(req.params.id, 10)
    if (!await canAccessClient(ctx, id)) return res.status(403).json({ error: 'Forbidden' })

    // Role-gated: coaches only see coach_thread
    const allowedTypes = isAdminRole(ctx.role)
      ? ['admin_private', 'coach_thread', 'ai_admin']
      : ['coach_thread']

    const { rows } = await pool.query(`
      SELECT thread_type,
        COUNT(*) FILTER (WHERE sender_role = 'client' AND read_at IS NULL)::int AS unread,
        MAX(created_at) AS last_message_at
      FROM client_messages
      WHERE client_id = $1 AND thread_type = ANY($2::text[]) AND deleted_at IS NULL
      GROUP BY thread_type
      ORDER BY MAX(created_at) DESC
    `, [id, allowedTypes])

    // Merge coach_thread + admin_private into one tab when this admin is the
    // client's assigned coach (see isAdminAssignedCoach).
    let result = rows
    if (await isAdminAssignedCoach(ctx, id)) {
      const coachRow = rows.find(r => r.thread_type === 'coach_thread')
      const adminRow = rows.find(r => r.thread_type === 'admin_private')
      if (coachRow || adminRow) {
        const coachTime = coachRow?.last_message_at ? new Date(coachRow.last_message_at).getTime() : -1
        const adminTime = adminRow?.last_message_at ? new Date(adminRow.last_message_at).getTime() : -1
        const mergedRow = {
          thread_type: 'coach_thread',
          unread: (Number(coachRow?.unread) || 0) + (Number(adminRow?.unread) || 0),
          last_message_at: adminTime > coachTime ? adminRow.last_message_at : (coachRow?.last_message_at ?? adminRow?.last_message_at),
        }
        result = rows
          .filter(r => r.thread_type !== 'coach_thread' && r.thread_type !== 'admin_private')
          .concat([mergedRow])
          .sort((a, b) => {
            const aTime = a.last_message_at ? new Date(a.last_message_at).getTime() : 0
            const bTime = b.last_message_at ? new Date(b.last_message_at).getTime() : 0
            return bTime - aTime
          })
      }
    }

    res.json(result)
  } catch (err) { next(err) }
})

// GET /api/coach-admin/clients/:id/katie-history — read-only AI Katie conversation for staff
// Admin sees all; coaches see only if canAccessClient passes (assigned clients).
// Returns coaching_conversations rows — completely separate from client_messages.
router.get('/clients/:id/katie-history', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const clientId = parseInt(req.params.id, 10)
    if (isNaN(clientId)) return res.status(400).json({ error: 'Invalid id' })
    if (!await canAccessClient(ctx, clientId)) return res.status(403).json({ error: 'Forbidden' })

    const { rows } = await pool.query(
      `SELECT role, message, is_proactive, proactive_trigger, created_at
       FROM coaching_conversations
       WHERE user_id = $1
       ORDER BY created_at ASC
       LIMIT 100`,
      [clientId],
    )
    res.json(rows)
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
        fs.reviewed_at, fs.reviewed_by, fs.coach_note, fs.due_at, fs.is_late,
        fs.completed_at, fs.completed_by,
        ft.title  AS form_title,
        ft.status AS form_status,
        fv.version_num,
        fv.schema AS version_schema,
        reviewer.first_name  AS reviewed_by_name,
        completer.first_name AS completed_by_name
      FROM form_submissions fs
      JOIN form_templates ft ON ft.id = fs.template_id
      JOIN form_versions  fv ON fv.id = fs.version_id
      LEFT JOIN users reviewer  ON reviewer.id  = fs.reviewed_by
      LEFT JOIN users completer ON completer.id = fs.completed_by
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
        fs.reviewed_at, fs.reviewed_by, fs.coach_note, fs.due_at, fs.is_late,
        fs.completed_at, fs.completed_by,
        ft.title  AS form_title,
        ft.status AS form_status,
        fv.version_num,
        fv.schema AS version_schema,
        reviewer.first_name  AS reviewed_by_name,
        completer.first_name AS completed_by_name
      FROM form_submissions fs
      JOIN form_templates ft ON ft.id = fs.template_id
      JOIN form_versions  fv ON fv.id = fs.version_id
      LEFT JOIN users reviewer  ON reviewer.id  = fs.reviewed_by
      LEFT JOIN users completer ON completer.id = fs.completed_by
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

// PATCH /api/coach-admin/form-submissions/:submissionId/unmark-reviewed
// Clears reviewed_at/reviewed_by (toggle off the 🙂 "replied" check-in marker).
router.patch('/form-submissions/:submissionId/unmark-reviewed', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const subId = parseInt(req.params.submissionId, 10)
    const { rows: [sub] } = await pool.query('SELECT id, user_id FROM form_submissions WHERE id = $1', [subId])
    if (!sub) return res.status(404).json({ error: 'Submission not found' })
    if (!await canAccessClient(ctx, sub.user_id)) return res.status(403).json({ error: 'Forbidden' })
    await pool.query('UPDATE form_submissions SET reviewed_at = NULL, reviewed_by = NULL WHERE id = $1', [subId])
    res.json({ ok: true })
  } catch (err) { next(err) }
})

// PATCH /api/coach-admin/form-submissions/:submissionId/mark-complete
// Stamps completed_at/completed_by after a submission has been reviewed.
// Idempotent: never overwrites an existing completed_at.
router.patch('/form-submissions/:submissionId/mark-complete', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const subId = parseInt(req.params.submissionId, 10)

    const { rows: [sub] } = await pool.query(
      `SELECT fs.id, fs.user_id, fs.reviewed_at, fs.completed_at, fs.completed_by,
              completer.first_name AS completed_by_name
       FROM form_submissions fs
       LEFT JOIN users completer ON completer.id = fs.completed_by
       WHERE fs.id = $1`,
      [subId],
    )
    if (!sub) return res.status(404).json({ error: 'Submission not found' })
    if (!await canAccessClient(ctx, sub.user_id)) return res.status(403).json({ error: 'Forbidden' })
    if (!sub.reviewed_at) return res.status(400).json({ error: 'Must be reviewed before marking complete' })

    if (sub.completed_at) {
      return res.json({
        already_completed:  true,
        completed_at:       sub.completed_at,
        completed_by:       sub.completed_by,
        completed_by_name:  sub.completed_by_name,
      })
    }

    const { rows: [updated] } = await pool.query(
      `UPDATE form_submissions SET completed_at = NOW(), completed_by = $1
       WHERE id = $2 RETURNING completed_at, completed_by`,
      [ctx.dbUserId, subId],
    )
    const { rows: [completer] } = await pool.query(
      'SELECT first_name FROM users WHERE id = $1',
      [ctx.dbUserId],
    )
    res.json({
      ok:                true,
      completed_at:      updated.completed_at,
      completed_by:      updated.completed_by,
      completed_by_name: completer?.first_name ?? null,
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
function isWeeklyCheckInForm(title = '') {
  return /weekly\s+check[-\s]?in/i.test(title)
}

function formMessageBody(firstName, title) {
  if (isWeeklyCheckInForm(title)) return 'Please complete your weekly check-in.'
  return `Hey ${firstName}, please complete your ${title}.`
}

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
      if (client.client_status === 'deactivated' || client.client_status === 'deleted') {
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
      if (isAdminRole(ctx.role) && client.coaching_type === 'ai') thread_type = 'ai_admin'

      const visibility = (thread_type === 'admin_private' || thread_type === 'ai_admin')
        ? 'client_and_admin_only'
        : 'client_and_staff'

      const firstName = client.first_name ?? 'there'
      const messageBody = formMessageBody(firstName, tpl.title)
      const metadata = { form_id: templateId, assignment_id: assignment.id, form_title: tpl.title }

      const { rows: [message] } = await pool.query(`
        INSERT INTO client_messages
          (client_id, sender_id, sender_role, message_body, thread_type, visibility, metadata)
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
        RETURNING id, metadata
      `, [clientId, ctx.dbUserId, ctx.role, messageBody, thread_type, visibility, JSON.stringify(metadata)])

      console.log('[formSend] message inserted', {
        message_id: message.id,
        client_id: clientId,
        template_id: templateId,
        assignment_id: assignment.id,
        thread_type,
        has_form_metadata: Boolean(message.metadata?.form_id && message.metadata?.assignment_id),
      })

      // Push: notify client about the form/check-in delivery — fire-and-forget
      notifyNewFormDelivery(clientId).catch(() => {})

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

// Helper: next occurrence of dayOfWeek/hour/minute after `after`.
// timezoneOffsetMinutes follows browser Date#getTimezoneOffset().
function computeNextSendAt(dayOfWeek, hour, minute = 0, after = new Date(), timezoneOffsetMinutes = null) {
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

// POST /api/coach-admin/forms/:id/schedule
// Body: { client_ids, send_mode:'scheduled'|'recurring', send_at:ISO, recurring_rule:{day_of_week,hour,minute} }
router.post('/forms/:id/schedule', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return

    const templateId = parseInt(req.params.id, 10)
    const { client_ids, send_mode, send_at, recurring_rule, selected_local_time, timezone, timezone_offset_minutes } = req.body

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
      if (client.client_status === 'deactivated' || client.client_status === 'deleted') {
        skipped.push({ client_id: clientId, reason: 'Client is not active' }); continue
      }

      let nextSendAt, recurringRuleJson = null, status

      if (send_mode === 'scheduled') {
        nextSendAt = new Date(send_at)
        recurringRuleJson = JSON.stringify({
          timezone: timezone ?? null,
          timezone_offset_minutes: timezone_offset_minutes ?? null,
          selected_local_time: selected_local_time ?? null,
        })
        status     = 'pending'
        console.log('[formSchedule] scheduled local to UTC', {
          selected_local_time: selected_local_time ?? null,
          timezone: timezone ?? null,
          timezone_offset_minutes: timezone_offset_minutes ?? null,
          stored_utc: nextSendAt.toISOString(),
          display_time: nextSendAt.toLocaleString('en-US', { timeZone: timezone || undefined }),
        })
      } else {
        const rule    = {
          ...recurring_rule,
          timezone: timezone ?? recurring_rule.timezone ?? null,
          timezone_offset_minutes: timezone_offset_minutes ?? recurring_rule.timezone_offset_minutes ?? null,
          end_date: recurring_rule.end_date || null,
        }
        nextSendAt    = computeNextSendAt(rule.day_of_week, rule.hour, rule.minute ?? 0, new Date(), rule.timezone_offset_minutes)
        recurringRuleJson = JSON.stringify(rule)
        status        = 'active'
        console.log('[formSchedule] recurring local to UTC', {
          selected_local_time: selected_local_time ?? `day ${rule.day_of_week} ${String(rule.hour).padStart(2, '0')}:${String(rule.minute ?? 0).padStart(2, '0')}`,
          timezone: rule.timezone,
          timezone_offset_minutes: rule.timezone_offset_minutes,
          end_date: rule.end_date,
          stored_utc: nextSendAt.toISOString(),
          display_time: nextSendAt.toLocaleString('en-US', { timeZone: rule.timezone || undefined }),
        })
      }

      const { rows: existingScheduleRows } = await pool.query(`
        SELECT id FROM form_assignments
        WHERE template_id = $1
          AND client_id = $2
          AND assignment_type = $3
          AND status IN ('pending', 'active')
          AND is_active = TRUE
          AND (
            ($3 = 'scheduled' AND ABS(EXTRACT(EPOCH FROM (next_send_at - $4::timestamptz))) < 60)
            OR
            ($3 = 'recurring'
              AND (recurring_rule->>'day_of_week')::int = $5
              AND (recurring_rule->>'hour')::int = $6
              AND COALESCE((recurring_rule->>'minute')::int, 0) = $7)
          )
        LIMIT 1
      `, [
        templateId,
        clientId,
        send_mode,
        nextSendAt,
        recurring_rule?.day_of_week ?? null,
        recurring_rule?.hour ?? null,
        recurring_rule?.minute ?? 0,
      ])
      if (existingScheduleRows.length > 0) {
        console.log('[formSchedule] skipped duplicate active schedule', {
          existing_assignment_id: existingScheduleRows[0].id,
          template_id: templateId,
          client_id: clientId,
          assignment_type: send_mode,
          next_send_at: nextSendAt?.toISOString?.() ?? nextSendAt,
        })
        skipped.push({ client_id: clientId, reason: 'Duplicate active schedule already exists' })
        continue
      }

      const { rows: [assignment] } = await pool.query(`
        INSERT INTO form_assignments
          (template_id, client_id, assigned_by, send_at, recurring_rule, is_active,
           assignment_type, status, next_send_at)
        VALUES ($1, $2, $3, $4, $5::jsonb, TRUE, $6, $7, $8)
        RETURNING id
      `, [templateId, clientId, ctx.dbUserId, nextSendAt, recurringRuleJson, send_mode, status, nextSendAt])

      console.log('[formSchedule] created assignment', {
        assignment_id: assignment.id,
        template_id: templateId,
        client_id: clientId,
        assignment_type: send_mode,
        status,
        is_active: true,
        next_send_at: nextSendAt?.toISOString?.() ?? nextSendAt,
      })

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
// Returns form delivery assignments; admin sees all, coach sees assigned clients only.
// Optional ?client_id= narrows to a single client (used by the client profile Overview tab).
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
      WHERE fa.assignment_type IN ('manual', 'scheduled', 'recurring')
    `

    const clientId = req.query.client_id ? parseInt(req.query.client_id, 10) : null
    const clientClause = clientId ? ' AND fa.client_id = $__CLIENT__' : ''

    let rows
    if (isAdminRole(ctx.role)) {
      const params = clientId ? [clientId] : []
      const clause = clientId ? clientClause.replace('$__CLIENT__', '$1') : ''
      ;({ rows } = await pool.query(baseSelect + clause + ' ORDER BY fa.created_at DESC LIMIT 200', params))
    } else {
      const params = clientId ? [ctx.dbUserId, clientId] : [ctx.dbUserId]
      const clause = clientId ? clientClause.replace('$__CLIENT__', '$2') : ''
      ;({ rows } = await pool.query(
        baseSelect + ' AND u.assigned_coach_id = $1' + clause + ' ORDER BY fa.created_at DESC LIMIT 200',
        params,
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
    const nextSend = computeNextSendAt(rule.day_of_week, rule.hour, rule.minute ?? 0, new Date(), rule.timezone_offset_minutes)

    const { rows: [updated] } = await pool.query(
      `UPDATE form_assignments SET status = 'active', is_active = TRUE, next_send_at = $1 WHERE id = $2 RETURNING *`,
      [nextSend, id],
    )
    res.json(updated)
  } catch (err) { next(err) }
})

// PATCH /api/coach-admin/form-schedules/:id  — edit future schedule details (staff only)
router.patch('/form-schedules/:id', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const id  = parseInt(req.params.id, 10)

    const { rows: [fa] } = await pool.query(
      'SELECT id, client_id, assignment_type, status, recurring_rule FROM form_assignments WHERE id = $1',
      [id],
    )
    if (!fa) return res.status(404).json({ error: 'Schedule not found' })
    if (!await canAccessClient(ctx, fa.client_id)) return res.status(403).json({ error: 'Not your client' })

    if (fa.assignment_type === 'scheduled') {
      if (fa.status !== 'pending')
        return res.status(400).json({ error: 'Only pending scheduled sends can be edited.' })

      const { send_at, selected_local_time, timezone, timezone_offset_minutes } = req.body
      if (!send_at) return res.status(400).json({ error: 'send_at is required.' })
      const dt = new Date(send_at)
      if (isNaN(dt.getTime())) return res.status(400).json({ error: 'send_at is not a valid date.' })
      if (dt <= new Date()) return res.status(400).json({ error: 'send_at must be in the future.' })
      console.log('[formSchedule] edit scheduled local to UTC', {
        assignment_id: id,
        selected_local_time: selected_local_time ?? null,
        timezone: timezone ?? null,
        timezone_offset_minutes: timezone_offset_minutes ?? null,
        stored_utc: dt.toISOString(),
        display_time: dt.toLocaleString('en-US', { timeZone: timezone || undefined }),
      })

      const { rows: [updated] } = await pool.query(
        `UPDATE form_assignments SET send_at = $1, next_send_at = $1 WHERE id = $2 RETURNING *`,
        [dt, id],
      )
      return res.json(updated)
    }

    if (fa.assignment_type === 'recurring') {
      if (!['active', 'paused'].includes(fa.status))
        return res.status(400).json({ error: 'Only active or paused recurring schedules can be edited.' })

      const { recurring_rule, selected_local_time, timezone, timezone_offset_minutes } = req.body
      if (!recurring_rule || recurring_rule.day_of_week == null || recurring_rule.hour == null)
        return res.status(400).json({ error: 'recurring_rule with day_of_week and hour is required.' })

      const rule = {
        ...recurring_rule,
        timezone: timezone ?? recurring_rule.timezone ?? null,
        timezone_offset_minutes: timezone_offset_minutes ?? recurring_rule.timezone_offset_minutes ?? null,
        end_date: recurring_rule.end_date || null,
      }
      const nextSend = computeNextSendAt(rule.day_of_week, rule.hour, rule.minute ?? 0, new Date(), rule.timezone_offset_minutes)
      console.log('[formSchedule] edit recurring local to UTC', {
        assignment_id: id,
        selected_local_time: selected_local_time ?? null,
        timezone: rule.timezone,
        timezone_offset_minutes: rule.timezone_offset_minutes,
        end_date: rule.end_date,
        stored_utc: nextSend.toISOString(),
        display_time: nextSend.toLocaleString('en-US', { timeZone: rule.timezone || undefined }),
      })
      const { rows: [updated] } = await pool.query(
        `UPDATE form_assignments SET recurring_rule = $1::jsonb, next_send_at = $2 WHERE id = $3 RETURNING *`,
        [JSON.stringify(rule), nextSend, id],
      )
      return res.json(updated)
    }

    return res.status(400).json({ error: 'This schedule type cannot be edited.' })
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

// ─── Coach Workout Management ──────────────────────────────────────────────────
// Coaches/admins can create, view, and edit workout programs assigned to clients.

// GET /api/coach-admin/exercises?search=&movement_pattern= — library lookup for the
// coach-side exercise autocomplete. Not client-scoped (the library is shared), so
// only requireStaff applies — no canAccessClient check needed.
router.get('/exercises', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const { search, movement_pattern } = req.query
    const conditions = []
    const params = []
    if (search?.trim()) {
      params.push(`%${search.trim()}%`)
      conditions.push(`name ILIKE $${params.length}`)
    }
    if (movement_pattern?.trim()) {
      params.push(movement_pattern.trim())
      conditions.push(`movement_pattern = $${params.length}`)
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    const { rows } = await pool.query(
      `SELECT id, name, movement_pattern, is_unilateral, equipment, difficulty
       FROM exercises ${where} ORDER BY name LIMIT 25`,
      params,
    )
    res.json(rows)
  } catch (err) { next(err) }
})

// GET /api/coach-admin/clients/:id/workouts
router.get('/clients/:id/workouts', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const clientId = parseInt(req.params.id, 10)
    if (!(await canAccessClient(ctx, clientId))) return res.status(403).json({ error: 'Access denied' })
    const { rows } = await pool.query(
      `SELECT w.id, w.name, w.description, w.status, w.created_at,
              (SELECT COUNT(*) FROM workout_exercises WHERE workout_id = w.id)::int AS exercise_count,
              (SELECT COUNT(DISTINCT day) FROM workout_exercises WHERE workout_id = w.id)::int AS day_count,
              (SELECT MAX(completed_at) FROM workout_logs WHERE workout_id = w.id AND user_id = $1) AS last_logged_at,
              (SELECT COUNT(*) FROM workout_logs WHERE workout_id = w.id AND user_id = $1)::int AS log_count
       FROM workouts w WHERE w.user_id = $1 ORDER BY w.created_at DESC`,
      [clientId],
    )
    res.json(rows)
  } catch (err) { next(err) }
})

// GET /api/coach-admin/clients/:id/workouts/:wid
router.get('/clients/:id/workouts/:wid', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const clientId  = parseInt(req.params.id, 10)
    const workoutId = parseInt(req.params.wid, 10)
    if (!(await canAccessClient(ctx, clientId))) return res.status(403).json({ error: 'Access denied' })
    const { rows: [workout] } = await pool.query(
      'SELECT * FROM workouts WHERE id=$1 AND user_id=$2', [workoutId, clientId])
    if (!workout) return res.status(404).json({ error: 'Workout not found' })
    const { rows: exercises } = await pool.query(
      `SELECT we.*,
              COALESCE(
                (SELECT image_url FROM exercises WHERE id = we.exercise_id),
                (SELECT image_url FROM exercises
                   WHERE lower(trim(name)) = lower(trim(we.exercise_name))
                     AND image_url IS NOT NULL
                   ORDER BY id LIMIT 1)
              ) AS image_url
       FROM workout_exercises we
       WHERE we.workout_id=$1 ORDER BY we.sort_order, we.id`, [workoutId])
    const { rows: logs } = await pool.query(
      'SELECT * FROM workout_logs WHERE workout_id=$1 AND user_id=$2 ORDER BY completed_at DESC LIMIT 10',
      [workoutId, clientId])
    res.json({ ...workout, exercises, logs })
  } catch (err) { next(err) }
})

// POST /api/coach-admin/clients/:id/workouts/generate — generate a Katie plan for a client
// Must be defined BEFORE the /:wid route so Express doesn't treat "generate" as a wid.
router.post('/clients/:id/workouts/generate', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const clientId = parseInt(req.params.id, 10)
    if (!(await canAccessClient(ctx, clientId))) return res.status(403).json({ error: 'Access denied' })

    const answers = req.body
    if (!answers.goals || !answers.days_per_week || !answers.fitness_level || !answers.supersets || !answers.circuits) {
      return res.status(400).json({ error: 'Missing required fields' })
    }

    // Use the client's first name in the Katie prompt
    const { rows: [client] } = await pool.query('SELECT first_name FROM users WHERE id=$1', [clientId])
    const firstName = client?.first_name || 'your client'

    const { rows: [assessment] } = await pool.query(
      'SELECT injuries_limitations FROM health_assessments WHERE user_id = $1', [clientId],
    )

    const plan = await generateWorkoutPlan(pool, firstName, answers, {
      healthAssessmentInjuries: assessment?.injuries_limitations ?? null,
      forceBilateral: answers.force_bilateral === true,
    })
    res.json(plan)
  } catch (err) { next(err) }
})

// POST /api/coach-admin/clients/:id/workouts — create a workout program for a client
// Accepts optional `days` (AI-generated plan structure) to save full program at once.
router.post('/clients/:id/workouts', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const clientId = parseInt(req.params.id, 10)
    if (!(await canAccessClient(ctx, clientId))) return res.status(403).json({ error: 'Access denied' })
    const { name, description, days, status } = req.body
    if (!name?.trim()) return res.status(400).json({ error: 'name required' })
    if (status && !['draft', 'assigned'].includes(status)) {
      return res.status(400).json({ error: 'status must be draft or assigned' })
    }
    const { rows: [workout] } = await pool.query(
      'INSERT INTO workouts (user_id, name, description, status) VALUES ($1,$2,$3,$4) RETURNING *',
      [clientId, name.trim(), description ?? null, status === 'draft' ? 'draft' : 'assigned'],
    )
    // If a full plan with days was provided (e.g. from Katie generation), save exercises too
    if (Array.isArray(days) && days.length > 0) {
      for (const day of days) {
        let dayOrder = 0
        for (const ex of (day.exercises || [])) {
          await pool.query(
            `INSERT INTO workout_exercises
               (workout_id, day, exercise_name, exercise_id, day_focus, sets, reps, rest_seconds, notes, sort_order)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [workout.id, day.day_name, ex.name, ex.exercise_id ?? null, day.focus ?? null,
             ex.sets ?? null, ex.reps ?? null, ex.rest_seconds ?? null, ex.notes ?? null, dayOrder++],
          )
        }
      }
    }
    res.status(201).json(workout)
  } catch (err) { next(err) }
})

// PUT /api/coach-admin/clients/:id/workouts/:wid — update workout name/description
router.put('/clients/:id/workouts/:wid', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const clientId  = parseInt(req.params.id, 10)
    const workoutId = parseInt(req.params.wid, 10)
    if (!(await canAccessClient(ctx, clientId))) return res.status(403).json({ error: 'Access denied' })
    const { name, description, status } = req.body
    if (status && !['draft', 'assigned'].includes(status)) {
      return res.status(400).json({ error: 'status must be draft or assigned' })
    }
    const { rows: [w] } = await pool.query(
      `UPDATE workouts SET name=COALESCE($3, name), description=COALESCE($4, description),
                            status=COALESCE($5, status)
       WHERE id=$1 AND user_id=$2 RETURNING *`,
      [workoutId, clientId, name?.trim() ?? null, description ?? null, status ?? null],
    )
    if (!w) return res.status(404).json({ error: 'Workout not found' })
    res.json(w)
  } catch (err) { next(err) }
})

// POST /api/coach-admin/clients/:id/workouts/:wid/exercises — add exercise
router.post('/clients/:id/workouts/:wid/exercises', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const clientId  = parseInt(req.params.id, 10)
    const workoutId = parseInt(req.params.wid, 10)
    if (!(await canAccessClient(ctx, clientId))) return res.status(403).json({ error: 'Access denied' })
    const { rows: [w] } = await pool.query(
      'SELECT id FROM workouts WHERE id=$1 AND user_id=$2', [workoutId, clientId])
    if (!w) return res.status(404).json({ error: 'Workout not found' })
    const { day, exercise_name, exercise_id, sets, reps, weight, rest_seconds, notes, sort_order } = req.body
    if (!exercise_name?.trim()) return res.status(400).json({ error: 'exercise_name required' })
    const { rows: [ex] } = await pool.query(
      `INSERT INTO workout_exercises (workout_id, day, exercise_name, exercise_id, sets, reps, weight, rest_seconds, notes, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *, COALESCE(
         (SELECT image_url FROM exercises WHERE id = workout_exercises.exercise_id),
         (SELECT image_url FROM exercises
            WHERE lower(trim(name)) = lower(trim(workout_exercises.exercise_name))
              AND image_url IS NOT NULL
            ORDER BY id LIMIT 1)
       ) AS image_url`,
      [workoutId, day ?? 'Day 1', exercise_name.trim(), exercise_id ?? null, sets ?? null, reps ?? null,
       weight ?? null, rest_seconds ?? null, notes ?? null, sort_order ?? 0],
    )
    res.status(201).json(ex)
  } catch (err) { next(err) }
})

// PUT /api/coach-admin/clients/:id/workouts/exercises/:eid — edit exercise
router.put('/clients/:id/workouts/exercises/:eid', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const clientId = parseInt(req.params.id, 10)
    const exId     = parseInt(req.params.eid, 10)
    if (!(await canAccessClient(ctx, clientId))) return res.status(403).json({ error: 'Access denied' })
    // Verify the exercise belongs to a workout owned by this client
    const { rows: [ex] } = await pool.query(
      `SELECT we.* FROM workout_exercises we JOIN workouts w ON w.id=we.workout_id
       WHERE we.id=$1 AND w.user_id=$2`, [exId, clientId])
    if (!ex) return res.status(404).json({ error: 'Exercise not found' })
    const allowed = ['exercise_name', 'exercise_id', 'sets', 'reps', 'weight', 'rest_seconds', 'notes', 'day', 'sort_order']
    const entries = Object.entries(req.body).filter(([k]) => allowed.includes(k))
    if (!entries.length) return res.status(400).json({ error: 'No valid fields' })
    const setClauses = entries.map(([k], i) => `${k}=$${i + 2}`).join(', ')
    const { rows: [updated] } = await pool.query(
      `UPDATE workout_exercises SET ${setClauses} WHERE id=$1
       RETURNING *, COALESCE(
         (SELECT image_url FROM exercises WHERE id = workout_exercises.exercise_id),
         (SELECT image_url FROM exercises
            WHERE lower(trim(name)) = lower(trim(workout_exercises.exercise_name))
              AND image_url IS NOT NULL
            ORDER BY id LIMIT 1)
       ) AS image_url`,
      [exId, ...entries.map(([, v]) => v)],
    )
    res.json(updated)
  } catch (err) { next(err) }
})

// DELETE /api/coach-admin/clients/:id/workouts/exercises/:eid — remove exercise
router.delete('/clients/:id/workouts/exercises/:eid', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const clientId = parseInt(req.params.id, 10)
    const exId     = parseInt(req.params.eid, 10)
    if (!(await canAccessClient(ctx, clientId))) return res.status(403).json({ error: 'Access denied' })
    const { rowCount } = await pool.query(
      `DELETE FROM workout_exercises we USING workouts w
       WHERE we.workout_id=w.id AND we.id=$1 AND w.user_id=$2`, [exId, clientId])
    if (!rowCount) return res.status(404).json({ error: 'Exercise not found' })
    res.json({ ok: true })
  } catch (err) { next(err) }
})

// DELETE /api/coach-admin/clients/:id/workouts/:wid — delete workout program
router.delete('/clients/:id/workouts/:wid', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const clientId  = parseInt(req.params.id, 10)
    const workoutId = parseInt(req.params.wid, 10)
    if (!(await canAccessClient(ctx, clientId))) return res.status(403).json({ error: 'Access denied' })
    const { rowCount } = await pool.query(
      'DELETE FROM workouts WHERE id=$1 AND user_id=$2', [workoutId, clientId])
    if (!rowCount) return res.status(404).json({ error: 'Workout not found' })
    res.json({ ok: true })
  } catch (err) { next(err) }
})

// ─── Workout scheduling ─────────────────────────────────────────────────────────
// Assign a saved workout program's days onto a client's calendar. Mirrors the
// habit-assignment routes. NOTE: edit/list/delete live under /workout-schedules
// (not /workouts/:id) to avoid colliding with the existing GET/PUT/DELETE
// /clients/:id/workouts/:wid program routes — the requested
// DELETE /clients/:id/workouts/:assignmentId would be an identical pattern to the
// program-delete route and could never be reached.

// pg returns DATE as a JS Date in server-local TZ. Use local components — never
// toISOString(), which can shift the day. Shared by the schedule routes below.
function scheduleISODate(v) {
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

const VALID_WORKOUT_FREQ = ['daily', 'weekly', 'specific_days']

// Expand coach_assigned_workouts rows into per-day calendar instances over the
// [startDate, endDate] window, honouring frequency/days_of_week/start/end. Mirrors
// the habit expandCalendar logic. Returns { 'YYYY-MM-DD': [{ assignment, log }] }.
function expandWorkoutCalendar(schedules, logs, startDate, endDate) {
  const logMap = {}  // { assignment_id: { date: log } }
  for (const l of logs) {
    const dateKey = scheduleISODate(l.scheduled_date)
    if (!logMap[l.assignment_id]) logMap[l.assignment_id] = {}
    logMap[l.assignment_id][dateKey] = l
  }

  const calendar = {}
  const winStart = new Date(`${startDate}T00:00:00`)
  const winEnd   = new Date(`${endDate}T00:00:00`)
  for (const s of schedules) {
    const sStartISO = scheduleISODate(s.start_date)
    const sEndISO   = scheduleISODate(s.end_date)
    const sStart = new Date(`${sStartISO}T00:00:00`)
    const sEnd   = sEndISO ? new Date(`${sEndISO}T00:00:00`) : winEnd
    const allowed = s.days_of_week
      ? s.days_of_week.split(',').map(x => parseInt(x, 10)).filter(n => !Number.isNaN(n))
      : null

    const iterStart = new Date(Math.max(winStart.getTime(), sStart.getTime()))
    const iterEnd   = new Date(Math.min(winEnd.getTime(), sEnd.getTime()))
    for (let d = new Date(iterStart); d <= iterEnd; d.setDate(d.getDate() + 1)) {
      if (s.frequency === 'specific_days' && allowed && !allowed.includes(d.getDay())) continue
      if (s.frequency === 'weekly' && d.getDay() !== sStart.getDay()) continue
      const key = scheduleISODate(d)
      if (!calendar[key]) calendar[key] = []
      calendar[key].push({
        assignment: { ...s, start_date: sStartISO, end_date: sEndISO },
        log: logMap[s.id]?.[key] ?? null,
      })
    }
  }
  return calendar
}

// POST /api/coach-admin/clients/:id/workouts/:workoutId/schedule
// body: { assignments: [{ day_label, frequency, start_date, end_date, days_of_week }] }
// Creates one coach_assigned_workouts row per assignment.
router.post('/clients/:id/workouts/:workoutId/schedule', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const clientId  = parseInt(req.params.id, 10)
    const workoutId = parseInt(req.params.workoutId, 10)
    if (!(await canAccessClient(ctx, clientId))) return res.status(403).json({ error: 'Access denied' })

    // Workout must exist and belong to this client
    const { rows: [w] } = await pool.query(
      'SELECT id FROM workouts WHERE id=$1 AND user_id=$2', [workoutId, clientId])
    if (!w) return res.status(404).json({ error: 'Workout not found' })

    const { assignments } = req.body
    if (!Array.isArray(assignments) || !assignments.length) {
      return res.status(400).json({ error: 'assignments array required' })
    }

    // Valid day_labels = the distinct workout_exercises.day values for this workout
    const { rows: dayRows } = await pool.query(
      'SELECT DISTINCT day FROM workout_exercises WHERE workout_id=$1', [workoutId])
    const validDays = new Set(dayRows.map(r => r.day))

    for (const a of assignments) {
      if (!a.day_label || !validDays.has(a.day_label)) {
        return res.status(400).json({ error: `Invalid day_label: ${a.day_label}` })
      }
      if (!a.start_date) return res.status(400).json({ error: 'start_date required for each assignment' })
      if (a.frequency && !VALID_WORKOUT_FREQ.includes(a.frequency)) {
        return res.status(400).json({ error: `Invalid frequency: ${a.frequency}` })
      }
    }

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const created = []
      for (const a of assignments) {
        const { rows } = await client.query(`
          INSERT INTO coach_assigned_workouts
            (user_id, assigned_by_user_id, workout_id, day_label,
             frequency, start_date, end_date, days_of_week)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
          RETURNING *
        `, [
          clientId, ctx.dbUserId, workoutId, a.day_label,
          a.frequency ?? 'weekly', a.start_date, a.end_date ?? null,
          a.days_of_week ?? null,
        ])
        created.push(rows[0])
      }
      await client.query('COMMIT')
      res.status(201).json({ assignments: created })
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  } catch (err) { next(err) }
})

// GET /api/coach-admin/clients/:id/workout-schedules/calendar?start=...&end=...
// Expand scheduled workouts into per-day instances, same shape as the habits
// calendar route: { start, end, calendar: { 'YYYY-MM-DD': [{ assignment, log }] } }
router.get('/clients/:id/workout-schedules/calendar', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const id = parseInt(req.params.id, 10)
    if (!await canAccessClient(ctx, id)) return res.status(403).json({ error: 'Forbidden' })

    const startDate = req.query.start ?? new Date().toISOString().slice(0, 10)
    const endDate   = req.query.end   ?? new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10)

    const { rows: schedules } = await pool.query(`
      SELECT s.*, w.name AS workout_name
      FROM coach_assigned_workouts s
      JOIN workouts w ON w.id = s.workout_id
      WHERE s.user_id = $1 AND s.active = TRUE
        AND s.start_date <= $3::date
        AND (s.end_date IS NULL OR s.end_date >= $2::date)
    `, [id, startDate, endDate])

    const { rows: logs } = await pool.query(`
      SELECT id, assignment_id, scheduled_date, notes, completed_at
      FROM workout_logs
      WHERE user_id = $1 AND assignment_id IS NOT NULL
        AND scheduled_date BETWEEN $2::date AND $3::date
    `, [id, startDate, endDate])

    res.json({ start: startDate, end: endDate, calendar: expandWorkoutCalendar(schedules, logs, startDate, endDate) })
  } catch (err) { next(err) }
})

// PATCH /api/coach-admin/clients/:id/workout-schedules/:assignmentId — edit a schedule
router.patch('/clients/:id/workout-schedules/:assignmentId', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const clientId     = parseInt(req.params.id, 10)
    const assignmentId = parseInt(req.params.assignmentId, 10)
    if (!await canAccessClient(ctx, clientId)) return res.status(403).json({ error: 'Forbidden' })

    const { rows: aRows } = await pool.query(
      'SELECT user_id FROM coach_assigned_workouts WHERE id = $1', [assignmentId])
    if (!aRows.length || aRows[0].user_id !== clientId) {
      return res.status(404).json({ error: 'Schedule not found' })
    }

    const { frequency, start_date, end_date, days_of_week, day_label, active } = req.body
    if (frequency && !VALID_WORKOUT_FREQ.includes(frequency)) {
      return res.status(400).json({ error: `Invalid frequency: ${frequency}` })
    }

    const { rows } = await pool.query(`
      UPDATE coach_assigned_workouts SET
        frequency    = COALESCE($1, frequency),
        start_date   = COALESCE($2, start_date),
        end_date     = $3,
        days_of_week = COALESCE($4, days_of_week),
        day_label    = COALESCE($5, day_label),
        active       = COALESCE($6, active),
        updated_at   = NOW()
      WHERE id = $7 RETURNING *
    `, [
      frequency ?? null, start_date ?? null, end_date ?? null,
      days_of_week ?? null, day_label ?? null, active ?? null,
      assignmentId,
    ])
    res.json(rows[0])
  } catch (err) { next(err) }
})

// DELETE /api/coach-admin/clients/:id/workout-schedules/:assignmentId — remove a schedule
router.delete('/clients/:id/workout-schedules/:assignmentId', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const clientId     = parseInt(req.params.id, 10)
    const assignmentId = parseInt(req.params.assignmentId, 10)
    if (!await canAccessClient(ctx, clientId)) return res.status(403).json({ error: 'Forbidden' })

    const { rowCount } = await pool.query(
      'DELETE FROM coach_assigned_workouts WHERE id = $1 AND user_id = $2', [assignmentId, clientId])
    if (!rowCount) return res.status(404).json({ error: 'Schedule not found' })
    res.json({ ok: true })
  } catch (err) { next(err) }
})

// ─── Katie Corrections ────────────────────────────────────────────────────────
// Admin-only management of katie_corrections — fixes a wrong/hedged Katie answer
// without a code deploy (see server/services/katieCorrections.js, which reads
// this table at chat time). Quality control here stays admin-level, not coach.

// GET /api/coach-admin/katie-corrections — list all, newest first
router.get('/katie-corrections', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireAdmin(req, res); if (!ctx) return

    const { rows } = await pool.query(`
      SELECT c.id, c.trigger_keywords, c.correct_answer, c.active, c.created_at,
             u.first_name AS created_by_name
      FROM katie_corrections c
      LEFT JOIN users u ON u.id = c.created_by
      ORDER BY c.created_at DESC
    `)
    res.json(rows)
  } catch (err) { next(err) }
})

// POST /api/coach-admin/katie-corrections — flag a bad answer / add a correction
router.post('/katie-corrections', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireAdmin(req, res); if (!ctx) return

    const { trigger_keywords, correct_answer } = req.body
    const keywords = (Array.isArray(trigger_keywords) ? trigger_keywords : [])
      .map(k => String(k ?? '').trim())
      .filter(Boolean)
    if (keywords.length === 0) return res.status(400).json({ error: 'At least one trigger keyword is required' })
    if (!correct_answer?.trim()) return res.status(400).json({ error: 'correct_answer is required' })

    const { rows } = await pool.query(`
      INSERT INTO katie_corrections (trigger_keywords, correct_answer, created_by, active)
      VALUES ($1, $2, $3, TRUE)
      RETURNING id, trigger_keywords, correct_answer, active, created_at
    `, [keywords, correct_answer.trim(), ctx.dbUserId])
    res.status(201).json(rows[0])
  } catch (err) { next(err) }
})

// PATCH /api/coach-admin/katie-corrections/:id — toggle active on/off
router.patch('/katie-corrections/:id', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireAdmin(req, res); if (!ctx) return
    const id = parseInt(req.params.id, 10)
    const { active } = req.body
    if (typeof active !== 'boolean') return res.status(400).json({ error: 'active (boolean) is required' })

    const { rows } = await pool.query(
      `UPDATE katie_corrections SET active = $1 WHERE id = $2
       RETURNING id, trigger_keywords, correct_answer, active, created_at`,
      [active, id],
    )
    if (!rows.length) return res.status(404).json({ error: 'Correction not found' })
    res.json(rows[0])
  } catch (err) { next(err) }
})

// DELETE /api/coach-admin/katie-corrections/:id
router.delete('/katie-corrections/:id', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireAdmin(req, res); if (!ctx) return
    const id = parseInt(req.params.id, 10)

    const { rowCount } = await pool.query('DELETE FROM katie_corrections WHERE id = $1', [id])
    if (!rowCount) return res.status(404).json({ error: 'Correction not found' })
    res.json({ ok: true })
  } catch (err) { next(err) }
})

export default router
