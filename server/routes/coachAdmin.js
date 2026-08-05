import { Router } from 'express'
import { requireAuth, getAuth, clerkClient } from '@clerk/express'
import { v2 as cloudinary } from 'cloudinary'
import Anthropic from '@anthropic-ai/sdk'
import { pool, getOrCreateUser, isAdminEmail, getOrgCoachName } from '../db.js'
import { sendInviteEmail } from '../services/email.js'
import { getAppBaseUrl } from '../services/appUrl.js'
import { notifyNewDirectMessage, notifyNewFormDelivery } from '../services/pushService.js'
import { generateWorkoutPlan, ExerciseLibraryError } from '../services/workoutGenerator.js'
import { getWorkoutDayNotes } from '../services/workoutDayNotes.js'
import { insertWorkoutExercise } from '../services/workoutExerciseInsert.js'
import { trackEvent } from '../services/usageTracker.js'
import {
  pushHabitToCalendar,
  updateHabitCalendarEvent,
  deleteHabitCalendarEvent,
} from '../services/googleCalendarSync.js'

const router = Router()
const anthropic = new Anthropic()

// Coaching types whose support thread is ai_admin rather than coach_thread.
// Must stay in sync with visibleThreadTypesForClient() in routes/messages.js,
// which is the source of truth for what a client actually sees: every non-VIP
// tier gets ai_admin. 'basic' belongs here for that reason — basic clients
// could send into the thread but staff replies were rejected, so their
// messages went unanswered.
// 'ai' was consolidated into 'hybrid' — nothing writes 'ai' anymore, but it
// stays in this list so any legacy row still routes to the right thread
// instead of failing the send gate below.
const AI_ADMIN_THREAD_TYPES = ['hybrid', 'ai', 'basic']

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function getCurrentStaff(req) {
  // orgContext middleware (mounted before this router in server/index.js) already
  // resolved the full user row for this request — reuse it instead of re-querying.
  if (req.internalUser) {
    return {
      dbUserId: req.internalUser.id,
      role:     req.internalUser.role ?? 'client',
      orgId:    req.orgId ?? req.internalUser.org_id ?? 1,
      email:    req.internalUser.email ?? null,
    }
  }
  const { userId } = getAuth(req)
  const dbUserId = await getOrCreateUser(userId)
  const { rows } = await pool.query('SELECT id, role, org_id, email FROM users WHERE id = $1', [dbUserId])
  return {
    dbUserId,
    role:  rows[0]?.role ?? 'client',
    orgId: rows[0]?.org_id ?? 1,
    email: rows[0]?.email ?? null,
  }
}

function isAdminRole(role) {
  return role === 'admin' || role === 'account_owner'
}

// 'va' — client onboarding/transition role. Narrow scope: can invite clients,
// view basic client info, and set coaching_type at invite time. Deliberately
// NOT included in requireStaff/isAdminRole, so every messaging/notes/workouts/
// forms/assessment/health/payment/lifecycle route stays 403 for it by default.
// Only the specific routes gated with requireStaffOrVa (below) are reachable.
function isVaRole(role) {
  return role === 'va'
}

// Kept in sync with the CHECK constraint on message_reactions.reaction_type (server/db.js)
// and messages.js's REACTION_TYPES — same emoji set as community post_reactions.
const REACTION_TYPES = ['like', 'love', 'laugh', 'care']

// Batch-attach a { reactions: [{reaction_type, count, mine}] } summary to each message
// row, for a thread listing. `mine` reflects whether viewerId reacted with that type.
async function attachReactions(rows, viewerId) {
  if (!rows.length) return rows
  const { rows: summary } = await pool.query(
    `SELECT message_id, reaction_type, COUNT(*)::int AS count, BOOL_OR(user_id = $2) AS mine
     FROM message_reactions
     WHERE message_id = ANY($1::int[])
     GROUP BY message_id, reaction_type`,
    [rows.map(r => r.id), viewerId],
  )
  const byMessage = new Map()
  for (const r of summary) {
    const list = byMessage.get(r.message_id) ?? []
    list.push({ reaction_type: r.reaction_type, count: r.count, mine: r.mine })
    byMessage.set(r.message_id, list)
  }
  return rows.map(r => ({ ...r, reactions: byMessage.get(r.id) ?? [] }))
}

async function reactionsForMessage(messageId, viewerId) {
  const { rows } = await pool.query(
    `SELECT reaction_type, COUNT(*)::int AS count, BOOL_OR(user_id = $2) AS mine
     FROM message_reactions WHERE message_id = $1 GROUP BY reaction_type`,
    [messageId, viewerId],
  )
  return rows
}

// Super admin (platform owner accounts in ADMIN_EMAILS, e.g. Jason) bypasses org
// scoping entirely and sees/manages every org. This is deliberately NOT the same
// check as isAdminRole()/'admin' role: under multi-tenancy every org gets its own
// 'admin' user too, so role alone is not enough to grant cross-org access — only
// the hardcoded platform-owner allowlist should.
function isSuperAdmin(ctx) {
  return isAdminEmail(ctx.email)
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

// Like requireStaff, but also admits 'va' — use ONLY on the narrow set of
// onboarding/transition routes VA is allowed to touch (invite clients, list/
// view clients, manage pending invites). Never use this in place of
// requireStaff on messaging/notes/workouts/forms/assessment/health/lifecycle
// routes — those must stay va-exempt.
async function requireStaffOrVa(req, res) {
  const ctx = await getCurrentStaff(req)
  if (!isAdminRole(ctx.role) && ctx.role !== 'coach' && ctx.role !== 'staff' && !isVaRole(ctx.role)) {
    res.status(403).json({ error: 'Staff only' })
    return null
  }
  return ctx
}

// Reduces a full client row down to what a 'va' account may see: identity +
// coaching type/status + onboarding confirmation signals. Excludes payment,
// coach assignment, adherence/engagement, and health-assessment detail.
function basicClientView(row) {
  return {
    id:                   row.id,
    first_name:           row.first_name ?? null,
    display_first_name:   row.display_first_name ?? row.first_name ?? null,
    last_name:            row.last_name ?? row.display_last_name ?? null,
    display_last_name:    row.display_last_name ?? row.last_name ?? null,
    display_phone:        row.display_phone ?? row.phone_number ?? null,
    email:                row.email ?? null,
    coaching_type:        row.coaching_type ?? null,
    client_status:        row.client_status ?? null,
    status_tag:           row.status_tag ?? null,
    onboarding_complete:  row.onboarding_complete ?? false,
    assessment_complete:  row.assessment_complete ?? false,
    assessment_has_data:  row.assessment_has_data ?? false,
    created_at:           row.created_at ?? null,
    effective_start_date: row.effective_start_date ?? null,
  }
}

// Returns true if staff member (admin or coach) can access this client.
// Super admin bypasses org scoping entirely. Everyone else — including org-level
// 'admin' role staff — must be in the same org as the client; coaches additionally
// must be that client's assigned coach.
async function canAccessClient(ctx, clientId) {
  const { rows } = await pool.query(
    'SELECT org_id, assigned_coach_id, client_status FROM users WHERE id = $1',
    [clientId],
  )
  if (!rows.length) return false
  if (isSuperAdmin(ctx)) return true
  // Unclaimed self-signup: a user who signed up with no matching invite has a
  // NULL org_id and sits at pending_access (see getOrCreateUser in server/db.js).
  // They belong to no org yet, so any org's admin/VA may claim them — the
  // activate route below stamps their own org on. This is not a cross-org hole:
  // once org_id is set, the normal equality check applies and no other org can
  // reach them.
  if (rows[0].org_id == null && rows[0].client_status === 'pending_access') {
    return isAdminRole(ctx.role) || isVaRole(ctx.role)
  }
  if (rows[0].org_id !== ctx.orgId) return false
  if (isAdminRole(ctx.role)) return true
  // VA works onboarding across the whole org, not a single coach's roster —
  // this only ever matters on the requireStaffOrVa routes VA can reach at all.
  if (isVaRole(ctx.role)) return true
  return rows[0].assigned_coach_id === ctx.dbUserId
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
      if ('last_sender_id' in row) existing.last_sender_id = row.last_sender_id
    }
  }
  return [...passthrough, ...byClient.values()]
}

// Marks, per client, exactly one row as is_preview_thread — the row whose message body/
// sender/timestamp should supply the inbox card's preview text AND the thread the card
// opens into. Recency alone can't decide this: an admin who isn't the client's assigned
// coach has their own separate admin_private conversation, and the coach messaging more
// recently shouldn't make the card preview (or its click target) belong to a different
// conversation than the one that opens (see e28b308, which fixed the click target but
// left the preview text on the old "most recent wins" logic). Falls back to the most
// recently active row when the admin has no admin_private messages with this client yet.
// Coaches only ever have a single coach_thread row per client (enforced upstream), and
// assigned-coach clients are already collapsed to one row by mergeAssignedCoachRows, so
// this is a no-op in both those cases — the single row is always the preview row.
function markPreviewThread(rows, isAdmin) {
  const byClient = new Map()
  for (const row of rows) {
    if (!byClient.has(row.client_id)) byClient.set(row.client_id, [])
    byClient.get(row.client_id).push(row)
  }
  for (const clientRows of byClient.values()) {
    let previewRow = isAdmin ? clientRows.find(r => r.thread_type === 'admin_private') : null
    if (!previewRow) {
      previewRow = clientRows.reduce((best, r) => {
        if (!best) return r
        const bestTime = best.last_message_at ? new Date(best.last_message_at).getTime() : -1
        const rTime = r.last_message_at ? new Date(r.last_message_at).getTime() : -1
        return rTime > bestTime ? r : best
      }, null)
    }
    for (const row of clientRows) row.is_preview_thread = row === previewRow
  }
  return rows
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
  if (client.client_status === 'pending_access') return 'Pending Access'
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

// GET /api/coach-admin/clients?status=active|invited|pending_access|deactivated|all (default active)
router.get('/clients', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaffOrVa(req, res); if (!ctx) return
    const params = []
    let where = `WHERE u.role = 'client' AND COALESCE(u.client_status, 'active') != 'deleted'`

    if (!isSuperAdmin(ctx)) {
      params.push(ctx.orgId)
      where += ` AND u.org_id = $${params.length}`
    }

    const statusFilter = req.query.status ?? 'active'
    if (statusFilter === 'active') {
      where += ` AND COALESCE(u.client_status, 'active') = 'active'`
    } else if (statusFilter === 'deactivated') {
      where += ` AND u.client_status = 'deactivated'`
    } else if (statusFilter === 'invited') {
      where += ` AND u.client_status = 'invited'`
    } else if (statusFilter === 'pending_access') {
      // Self-signups with no matching invite and no paid record — gated at
      // /pending-access until an admin invites or activates them.
      where += ` AND u.client_status = 'pending_access'`
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
        ), 0) AS adherence_30d,
        COALESCE(json_agg(json_build_object('id', ct.id, 'tag_name', ct.tag_name))
          FILTER (WHERE ct.id IS NOT NULL), '[]'::json) AS tags
      FROM users u
      LEFT JOIN health_assessments ha ON ha.user_id = u.id
      LEFT JOIN client_tags ct ON ct.user_id = u.id
      ${where}
      GROUP BY u.id, ha.first_name, ha.last_name, ha.phone
      ORDER BY COALESCE(u.first_name, ha.first_name,
        CASE WHEN u.name IS NOT NULL THEN SPLIT_PART(u.name, ' ', 1) END
      ) ASC NULLS LAST
    `, params)

    const withStatus = rows.map(r => ({ ...r, status_tag: computeStatusTag(r) }))
    res.json(isVaRole(ctx.role) ? withStatus.map(basicClientView) : withStatus)
  } catch (err) { next(err) }
})

// GET /api/coach-admin/coaches — list available coaches for assignment dropdown
router.get('/coaches', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireAdmin(req, res); if (!ctx) return
    const params = []
    let orgClause = ''
    if (!isSuperAdmin(ctx)) {
      params.push(ctx.orgId)
      orgClause = ` AND org_id = $${params.length}`
    }
    const { rows } = await pool.query(`
      SELECT id, first_name, email FROM users
      WHERE role IN ('coach', 'admin')
        AND COALESCE(staff_status, 'active') = 'active'
        ${orgClause}
      ORDER BY first_name ASC NULLS LAST
    `, params)
    res.json(rows)
  } catch (err) { next(err) }
})

// GET /api/coach-admin/dashboard-summary — staff dashboard review queues
router.get('/dashboard-summary', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const params = []
    let clientScope = `u.role = 'client' AND COALESCE(u.client_status, 'active') != 'deleted'`
    if (!isSuperAdmin(ctx)) {
      params.push(ctx.orgId)
      clientScope += ` AND u.org_id = $${params.length}`
    }
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
    const params = [statusFilter]
    let orgClause = ''
    if (!isSuperAdmin(ctx)) {
      params.push(ctx.orgId)
      orgClause = ` AND u.org_id = $${params.length}`
    }
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
      WHERE u.role IN ('coach', 'admin', 'va')
        AND COALESCE(u.staff_status, 'active') = $1
        ${orgClause}
      GROUP BY u.id
      ORDER BY
        CASE WHEN u.role = 'admin' THEN 0 ELSE 1 END,
        name ASC
    `, params)
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
        u.org_id,
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
        AND u.role IN ('coach', 'admin', 'va')
      GROUP BY u.id, ha.street_address, ha.city, ha.state, ha.zip_code, ha.country
    `, [staffId])

    if (!rows.length) return res.status(404).json({ error: 'Staff member not found' })
    if (!isSuperAdmin(ctx) && rows[0].org_id !== ctx.orgId) {
      return res.status(404).json({ error: 'Staff member not found' })
    }
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
      'SELECT id, role, org_id FROM users WHERE id = $1 AND role IN (\'coach\', \'admin\', \'va\')',
      [staffId],
    )
    if (!target.length) return res.status(404).json({ error: 'Staff member not found' })
    if (!isSuperAdmin(ctx) && target[0].org_id !== ctx.orgId) {
      return res.status(404).json({ error: 'Staff member not found' })
    }

    const { first_name, last_name, phone_number, role } = req.body

    // Only admin may change role
    if (role !== undefined && !isAdminRole(ctx.role)) {
      return res.status(403).json({ error: 'Only admins can change roles' })
    }
    // Only allow valid staff roles
    if (role !== undefined && !['coach', 'admin', 'va'].includes(role)) {
      return res.status(400).json({ error: 'Role must be coach, admin, or va' })
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

    if (!isSuperAdmin(ctx)) {
      const { rows: targetOrg } = await pool.query('SELECT org_id FROM users WHERE id = $1', [staffId])
      if (!targetOrg.length || targetOrg[0].org_id !== ctx.orgId) {
        return res.status(404).json({ error: 'Staff member not found' })
      }
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
       WHERE id = $1 AND role IN ('coach', 'admin', 'va')
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

    if (!isSuperAdmin(ctx)) {
      const { rows: targetOrg } = await pool.query('SELECT org_id FROM users WHERE id = $1', [staffId])
      if (!targetOrg.length || targetOrg[0].org_id !== ctx.orgId) {
        return res.status(404).json({ error: 'Staff member not found' })
      }
    }

    const { rows } = await pool.query(
      `UPDATE users SET staff_status = 'active'
       WHERE id = $1 AND role IN ('coach', 'admin', 'va')
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

    const resolvedRole = ['coach', 'admin', 'va'].includes(role) ? role : 'coach'

    const normalizedEmail = email.trim().toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' })
    }

    // Block if a non-deleted user already exists with this email as staff
    const { rows: existing } = await pool.query(
      `SELECT id, role FROM users WHERE LOWER(email) = $1 AND role IN ('coach', 'admin', 'va')`,
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
      `INSERT INTO staff_invites (email, first_name, last_name, role, invited_by, org_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING token, email, first_name, last_name, role, created_at, expires_at`,
      [
        normalizedEmail,
        first_name.trim(),
        last_name?.trim() || null,
        resolvedRole,
        ctx.dbUserId,
        ctx.orgId,
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
    const ctx = await requireStaffOrVa(req, res); if (!ctx) return

    const { first_name, last_name, email, phone, assigned_coach_id, coaching_type, notes } = req.body

    if (!first_name?.trim()) return res.status(400).json({ error: 'First name is required.' })
    if (!email?.trim())      return res.status(400).json({ error: 'Email is required.' })

    // 'ai' stays accepted as input (an old client build could still send it)
    // but is folded to 'hybrid' before it is stored, so no new 'ai' rows appear.
    const validCoachingTypes = ['vip', 'ai', 'hybrid', 'basic']
    const requestedType = validCoachingTypes.includes(coaching_type) ? coaching_type : 'vip'
    const resolvedType = requestedType === 'ai' ? 'hybrid' : requestedType

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

    // VA can invite and set coaching_type, but assigning a coach is out of
    // scope for the role — always leave new clients unassigned when invited by a va.
    const coachId = (isVaRole(ctx.role) || ['ai', 'hybrid', 'basic'].includes(resolvedType) || !assigned_coach_id)
      ? null : parseInt(assigned_coach_id, 10)

    // A client can only be pre-assigned to a coach within the inviting staff member's org.
    if (coachId !== null && !isSuperAdmin(ctx)) {
      const { rows: coachRows } = await pool.query('SELECT org_id FROM users WHERE id = $1', [coachId])
      if (!coachRows.length || coachRows[0].org_id !== ctx.orgId) {
        return res.status(400).json({ error: 'Invalid coach selection.' })
      }
    }

    const { rows: [invite] } = await pool.query(
      // org_id is stamped from the inviting staff member's own context, never the
      // request body — it decides which org the client lands in when they claim
      // this invite (see claimInvite / getOrCreateUser in server/db.js).
      `INSERT INTO client_invites
         (email, first_name, last_name, phone, assigned_coach_id, coaching_type, notes, invited_by, org_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
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
        ctx.orgId,
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
    const ctx = await requireStaffOrVa(req, res); if (!ctx) return
    const appUrl = getAppBaseUrl()

    const params = []
    let extra = ''
    if (ctx.role === 'coach') {
      params.push(ctx.dbUserId)
      extra = `AND ci.assigned_coach_id = $${params.length}`
    }
    // client_invites has no org_id column — scope via the org of whichever staff
    // member the invite is tied to (assigned coach, falling back to whoever sent it).
    if (!isSuperAdmin(ctx)) {
      params.push(ctx.orgId)
      extra += ` AND COALESCE(ci.org_id, invcoach.org_id, invstaff.org_id) = $${params.length}`
    }

    const { rows } = await pool.query(`
      SELECT ci.id, ci.email, ci.first_name, ci.last_name, ci.coaching_type,
             ci.created_at, ci.expires_at, ci.token,
             (SELECT first_name FROM users WHERE id = ci.invited_by)      AS invited_by_name,
             (SELECT first_name FROM users WHERE id = ci.assigned_coach_id) AS assigned_coach_name
      FROM client_invites ci
      LEFT JOIN users invcoach ON invcoach.id = ci.assigned_coach_id
      LEFT JOIN users invstaff ON invstaff.id = ci.invited_by
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
    const ctx = await requireStaffOrVa(req, res); if (!ctx) return
    const id = parseInt(req.params.id, 10)

    const { rows } = await pool.query(
      `SELECT ci.*, COALESCE(ci.org_id, invcoach.org_id, invstaff.org_id) AS invite_org_id
       FROM client_invites ci
       LEFT JOIN users invcoach ON invcoach.id = ci.assigned_coach_id
       LEFT JOIN users invstaff ON invstaff.id = ci.invited_by
       WHERE ci.id = $1 AND ci.accepted_at IS NULL`,
      [id],
    )
    if (!rows.length) return res.status(404).json({ error: 'Invite not found or already accepted.' })
    if (!isSuperAdmin(ctx) && rows[0].invite_org_id !== ctx.orgId) {
      return res.status(404).json({ error: 'Invite not found or already accepted.' })
    }

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
    const ctx = await requireStaffOrVa(req, res); if (!ctx) return
    const id = parseInt(req.params.id, 10)

    // Admins cancel any invite in their org; coaches only ones they created or are assigned to
    const { rows: inviteRows } = await pool.query(
      `SELECT ci.id, ci.assigned_coach_id, ci.invited_by,
              COALESCE(ci.org_id, invcoach.org_id, invstaff.org_id) AS invite_org_id
       FROM client_invites ci
       LEFT JOIN users invcoach ON invcoach.id = ci.assigned_coach_id
       LEFT JOIN users invstaff ON invstaff.id = ci.invited_by
       WHERE ci.id = $1 AND ci.accepted_at IS NULL`,
      [id],
    )
    if (!inviteRows.length) return res.status(404).json({ error: 'Invite not found, already accepted, or you do not have permission.' })
    const invite = inviteRows[0]

    if (!isSuperAdmin(ctx) && invite.invite_org_id !== ctx.orgId) {
      return res.status(404).json({ error: 'Invite not found, already accepted, or you do not have permission.' })
    }
    if (ctx.role === 'coach' && invite.assigned_coach_id !== ctx.dbUserId && invite.invited_by !== ctx.dbUserId) {
      return res.status(404).json({ error: 'Invite not found, already accepted, or you do not have permission.' })
    }

    await pool.query(`DELETE FROM client_invites WHERE id = $1 AND accepted_at IS NULL`, [id])
    res.json({ ok: true })
  } catch (err) { next(err) }
})

// ─── Single client profile ────────────────────────────────────────────────────

// GET /api/coach-admin/clients/:id
router.get('/clients/:id', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaffOrVa(req, res); if (!ctx) return
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
        ha.injuries_limitations AS assessment_injuries_limitations,
        ha.supplements          AS assessment_supplements,
        ha.goals_6_months       AS assessment_goals_6_months,
        ha.num_kids             AS assessment_num_kids,
        ha.occupation           AS assessment_occupation,
        ha.energy_level         AS assessment_energy_level,
        ha.sleep_hours          AS assessment_sleep_hours,
        ha.sleep_quality        AS assessment_sleep_quality,
        ha.stress_management    AS assessment_stress_management,
        ha.daily_water          AS assessment_daily_water,
        ha.alcohol_weekdays     AS assessment_alcohol_weekdays,
        ha.alcohol_weekends     AS assessment_alcohol_weekends,
        ha.happiness_level      AS assessment_happiness_level,
        ha.confidence_level     AS assessment_confidence_level,
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
    res.json(isVaRole(ctx.role) ? basicClientView(merged) : merged)
  } catch (err) { next(err) }
})

// PATCH /api/coach-admin/clients/:id — admin can update profile/coaching fields
// Dynamic SET so `assigned_coach_id: null` actually unassigns the coach (unlike
// COALESCE, which would preserve the existing value).
router.patch('/clients/:id', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireAdmin(req, res); if (!ctx) return
    const id = parseInt(req.params.id, 10)
    if (!await canAccessClient(ctx, id)) return res.status(403).json({ error: 'Forbidden' })

    const allowed = ['coaching_type', 'assigned_coach_id', 'role', 'start_date',
                     'program_end_date', 'phone_number', 'paid', 'first_name', 'last_name',
                     'starting_weight_lbs']
    const setClauses = []
    const params = []
    for (const key of allowed) {
      if (key in req.body) {
        let value = req.body[key]
        if (key === 'coaching_type') {
          if (!['vip', 'ai', 'hybrid', 'basic'].includes(value)) {
            return res.status(400).json({ error: 'coaching_type must be vip, hybrid, or basic' })
          }
          // Legacy 'ai' is still accepted from older clients but folded to
          // 'hybrid' so it is never written back into the column.
          if (value === 'ai') value = 'hybrid'
        }
        // Normalize empty string → NULL for these fields
        if (key === 'assigned_coach_id') {
          value = (value === '' || value === null) ? null : Number(value)
          // A client can only be assigned to a coach within the same org.
          if (value !== null && !isSuperAdmin(ctx)) {
            const { rows: coachRows } = await pool.query('SELECT org_id FROM users WHERE id = $1', [value])
            if (!coachRows.length || coachRows[0].org_id !== ctx.orgId) {
              return res.status(400).json({ error: 'Invalid coach selection.' })
            }
          }
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
    const ctx = await requireAdmin(req, res); if (!ctx) return
    const id = parseInt(req.params.id, 10)
    if (!await canAccessClient(ctx, id)) return res.status(403).json({ error: 'Forbidden' })
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
    const ctx = await requireAdmin(req, res); if (!ctx) return
    const id = parseInt(req.params.id, 10)
    if (!await canAccessClient(ctx, id)) return res.status(403).json({ error: 'Forbidden' })
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

// PATCH /api/coach-admin/clients/:id/activate — self-signups with no matching
// invite and no paid record sit at client_status = 'pending_access' until an
// admin manually clears them in. Flips paid + client_status together so the
// pending-access gate (server/index.js) lets them straight through.
router.patch('/clients/:id/activate', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireAdmin(req, res); if (!ctx) return
    const id = parseInt(req.params.id, 10)
    if (!await canAccessClient(ctx, id)) return res.status(403).json({ error: 'Forbidden' })

    const { rows: targetRows } = await pool.query('SELECT client_status FROM users WHERE id = $1', [id])
    if (!targetRows.length) return res.status(404).json({ error: 'Client not found' })
    if (targetRows[0].client_status !== 'pending_access') {
      return res.status(400).json({ error: 'Only clients pending access can be activated.' })
    }

    // Adopt an unclaimed signup into the activating admin's org. A self-signup
    // with no invite has org_id NULL (getOrCreateUser can't know their org), and
    // activating them here is the moment that gets decided. COALESCE so an
    // already-assigned client keeps their org — this never moves someone between
    // orgs, it only fills in a blank.
    const { rows } = await pool.query(`
      UPDATE users
      SET paid          = TRUE,
          paid_at        = COALESCE(paid_at, NOW()),
          client_status  = 'active',
          org_id         = COALESCE(org_id, $2)
      WHERE id = $1
      RETURNING id, client_status, paid, paid_at, org_id
    `, [id, ctx.orgId])
    if (!rows.length) return res.status(404).json({ error: 'Client not found' })
    res.json({ ok: true, ...rows[0] })
  } catch (err) { next(err) }
})

// DELETE /api/coach-admin/clients/:id — SOFT delete (preserves all data)
// Pass ?hard=true to permanently remove (admin only, requires confirmation
// at the API level by sending {confirm: 'PERMANENT_DELETE'} in the body).
router.delete('/clients/:id', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireAdmin(req, res); if (!ctx) return
    const id = parseInt(req.params.id, 10)
    if (!await canAccessClient(ctx, id)) return res.status(403).json({ error: 'Forbidden' })
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
            : d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })
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
               step_series: stpR.rows, sleep_series: slpR.rows, movement_series: movR.rows, water_series: watR.rows,
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
      INSERT INTO daily_logs (user_id, logged_date, weight_lbs, org_id)
      VALUES ($1, $2::date, $3, $4)
      ON CONFLICT (user_id, logged_date)
      DO UPDATE SET weight_lbs = EXCLUDED.weight_lbs
      RETURNING logged_date, weight_lbs
    `, [id, date, w, ctx.orgId])

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

// POST /api/coach-admin/clients/:id/meal-comments — coach leaves a comment on a meal
router.post('/clients/:id/meal-comments', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const id = parseInt(req.params.id, 10)
    if (!await canAccessClient(ctx, id)) return res.status(403).json({ error: 'Forbidden' })

    const { meal_id, comment_text } = req.body
    if (!meal_id || !comment_text?.trim()) {
      return res.status(400).json({ error: 'meal_id and comment_text are required' })
    }

    const { rows } = await pool.query(
      `INSERT INTO meal_comments (meal_id, coach_id, comment_text)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [meal_id, ctx.dbUserId, comment_text.trim()],
    )

    await pool.query(
      `INSERT INTO notifications (user_id, type, title, message, org_id)
       VALUES ($1, 'meal_comment', 'Comment from Coach', $2, $3)`,
      [id, comment_text.trim().slice(0, 80), ctx.orgId],
    ).catch(() => {})

    res.status(201).json(rows[0])
  } catch (err) { next(err) }
})

// GET /api/coach-admin/clients/:id/meal-comments?date=YYYY-MM-DD
router.get('/clients/:id/meal-comments', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const id = parseInt(req.params.id, 10)
    if (!await canAccessClient(ctx, id)) return res.status(403).json({ error: 'Forbidden' })

    const date = req.query.date ?? new Date().toISOString().slice(0, 10)
    const { rows } = await pool.query(`
      SELECT
        mc.id, mc.meal_id, mc.comment_text, mc.created_at,
        u.first_name, u.last_name
      FROM meal_comments mc
      JOIN meals m ON m.id = mc.meal_id
      JOIN users u ON u.id = mc.coach_id
      WHERE m.user_id = $1 AND COALESCE(m.log_date, m.logged_at::date) = $2::date
      ORDER BY mc.created_at
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

    // 5 most recent published in-app videos with progress if it exists
    const { rows: videoRows } = await pool.query(`
      SELECT
        mv.id, mv.title,
        COALESCE(vwp.highest_pct, 0)    AS highest_pct,
        COALESCE(vwp.completed, FALSE)  AS completed,
        COALESCE(vwp.started, FALSE)    AS started,
        vwp.last_watched_at
      FROM mindset_videos mv
      LEFT JOIN video_watch_progress vwp
        ON vwp.video_id = mv.id AND vwp.user_id = $1
      WHERE mv.published = TRUE AND mv.deleted_at IS NULL
      ORDER BY mv.created_at DESC
      LIMIT 5
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
        highest_pct:    parseFloat(r.highest_pct),
        completed:      r.completed,
        started:        r.started,
        last_watched_at: r.last_watched_at ?? null,
      })),
    })
  } catch (err) { next(err) }
})

// GET /api/coach-admin/mindset-videos/:id/watch-stats
// Aggregated watch stats for ONE video across ALL clients. Looked up by id
// regardless of deleted_at — staff archiving a video (soft-delete, see
// DELETE /api/mindset-videos/:id) still want to see its stats afterward.
router.get('/mindset-videos/:id/watch-stats', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const videoId = parseInt(req.params.id, 10)
    if (!videoId || Number.isNaN(videoId)) return res.status(400).json({ error: 'Invalid video id' })

    // Same super-admin org bypass as mindsetVideos.js — everyone else is scoped
    // to their own org's video.
    const bypassOrg = isAdminEmail(ctx.email)
    const { rows: videoRows } = await pool.query(
      bypassOrg
        ? 'SELECT id FROM mindset_videos WHERE id = $1'
        : 'SELECT id FROM mindset_videos WHERE id = $1 AND org_id = $2',
      bypassOrg ? [videoId] : [videoId, ctx.orgId],
    )
    if (!videoRows.length) return res.status(404).json({ error: 'Video not found' })

    const { rows } = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE vwp.started = TRUE)::int    AS started_count,
        COUNT(*) FILTER (WHERE vwp.highest_pct >= 50)::int AS watched50_count,
        COUNT(*) FILTER (WHERE vwp.completed = TRUE)::int  AS completed_count
      FROM video_watch_progress vwp
      WHERE vwp.video_id = $1
    `, [videoId])
    const r = rows[0]

    res.json({
      videoId,
      startedCount:   r.started_count ?? 0,
      watched50Count: r.watched50_count ?? 0,
      completedCount: r.completed_count ?? 0,
    })
  } catch (err) { next(err) }
})

// GET /api/coach-admin/clients/:id/videos-watched-total
// Aggregated watch totals for ONE client across ALL videos (not just the recent-5
// shown on mindset-progress above).
router.get('/clients/:id/videos-watched-total', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const clientId = parseInt(req.params.id, 10)
    if (!await canAccessClient(ctx, clientId)) return res.status(403).json({ error: 'Forbidden' })

    const { rows } = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE vwp.started = TRUE)::int    AS started_count,
        COUNT(*) FILTER (WHERE vwp.highest_pct >= 50)::int AS watched50_count,
        COUNT(*) FILTER (WHERE vwp.completed = TRUE)::int  AS completed_count
      FROM video_watch_progress vwp
      WHERE vwp.user_id = $1
    `, [clientId])
    const r = rows[0]

    res.json({
      clientId,
      startedCount:   r.started_count ?? 0,
      watched50Count: r.watched50_count ?? 0,
      completedCount: r.completed_count ?? 0,
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
         frequency, start_date, end_date, days_of_week, notes, identity_category, org_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
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
      ctx.orgId,
    ])

    // Opt-in Google Calendar push. Silently skipped when the client hasn't
    // connected Calendar. A Calendar failure must never fail the assignment —
    // the habit is already committed above and is the thing that matters.
    try {
      const eventId = await pushHabitToCalendar(id, rows[0])
      if (eventId) rows[0].google_calendar_event_id = eventId
    } catch (calErr) {
      console.error('[coachAdmin] calendar push failed for new habit', rows[0].id, calErr.message)
    }

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

    // Mirror the edit onto the client's calendar. rows[0] carries the stored
    // google_calendar_event_id (RETURNING *); the helper no-ops when it's NULL
    // or the client isn't connected, and never throws into this handler.
    try {
      await updateHabitCalendarEvent(hRows[0].user_id, rows[0])
    } catch (calErr) {
      console.error('[coachAdmin] calendar update failed for habit', habitId, calErr.message)
    }

    res.json(rows[0])
  } catch (err) { next(err) }
})

// DELETE /api/coach-admin/habits/:habitId
router.delete('/habits/:habitId', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const habitId = parseInt(req.params.habitId, 10)

    // Read the calendar event id BEFORE the row is gone — it's the only place
    // the link between habit and Google event is stored.
    const { rows: hRows } = await pool.query(
      'SELECT user_id, google_calendar_event_id FROM coach_assigned_habits WHERE id = $1',
      [habitId],
    )
    if (!hRows.length) return res.status(404).json({ error: 'Habit not found' })
    if (!await canAccessClient(ctx, hRows[0].user_id)) return res.status(403).json({ error: 'Forbidden' })

    await pool.query('DELETE FROM coach_assigned_habits WHERE id = $1', [habitId])

    // Remove the matching calendar event. Best-effort and after the fact: the
    // habit deletion is already committed and must stand regardless of Google.
    try {
      await deleteHabitCalendarEvent(hRows[0].user_id, hRows[0].google_calendar_event_id)
    } catch (calErr) {
      console.error('[coachAdmin] calendar delete failed for habit', habitId, calErr.message)
    }

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
      INSERT INTO client_notes (client_id, author_id, note_body, visibility, org_id)
      VALUES ($1, $2, $3, $4, $5) RETURNING *
    `, [id, ctx.dbUserId, note_body.trim(), finalVisibility, ctx.orgId])
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
    if (!await canAccessClient(ctx, nRows[0].client_id)) return res.status(404).json({ error: 'Note not found' })

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
    if (!await canAccessClient(ctx, nRows[0].client_id)) return res.status(404).json({ error: 'Note not found' })

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
    if (!isSuperAdmin(ctx)) {
      params.push(ctx.orgId)
      extraWhere += ` AND u.org_id = $${params.length}`
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
          ORDER BY created_at DESC LIMIT 1) AS last_sender_role,
        (SELECT sender_id FROM client_messages
          WHERE client_id = u.id AND thread_type = m.thread_type AND deleted_at IS NULL
          ORDER BY created_at DESC LIMIT 1) AS last_sender_id
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
    markPreviewThread(merged, isAdmin)
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
    if (!isSuperAdmin(ctx)) {
      params.push(ctx.orgId)
      extraWhere += ` AND u.org_id = $${params.length}`
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
    let orgFilter = ''
    if (!isSuperAdmin(ctx)) {
      params.push(ctx.orgId)
      orgFilter = ` AND u.org_id = $${params.length}`
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
        ${coachFilter}${orgFilter}
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

    const messagesWithReactions = await attachReactions(rows, ctx.dbUserId)

    res.json({
      messages: messagesWithReactions,
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

    // If sending to ai_admin, verify this client's support thread is ai_admin
    if (canonicalThreadType === 'ai_admin') {
      const { rows } = await pool.query('SELECT coaching_type FROM users WHERE id = $1', [id])
      if (!AI_ADMIN_THREAD_TYPES.includes(rows[0]?.coaching_type)) {
        return res.status(400).json({ error: 'ai_admin thread is not available for this client' })
      }
    }

    const { rows } = await pool.query(`
      INSERT INTO client_messages
        (client_id, sender_id, sender_role, message_body, thread_type, visibility, image_url, audio_url, org_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *
    `, [id, ctx.dbUserId, ctx.role, message_body.trim(), canonicalThreadType, visibility, image_url ?? null, audio_url ?? null, ctx.orgId])

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
            (client_id, sender_id, sender_role, message_body, thread_type, visibility, org_id)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, [clientId, ctx.dbUserId, ctx.role, trimmedBody, canonicalThreadType, visibility, ctx.orgId])

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

// POST /api/coach-admin/clients/:id/messages/:messageId/reactions  body: { reaction_type }
router.post('/clients/:id/messages/:messageId/reactions', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const clientId  = parseInt(req.params.id, 10)
    const messageId = parseInt(req.params.messageId, 10)
    if (!Number.isInteger(messageId)) return res.status(400).json({ error: 'Invalid message id' })
    if (!await canAccessClient(ctx, clientId)) return res.status(403).json({ error: 'Forbidden' })

    const { reaction_type } = req.body
    if (!REACTION_TYPES.includes(reaction_type)) return res.status(400).json({ error: 'Invalid reaction_type' })

    const { rows } = await pool.query(
      'SELECT client_id, sender_id, thread_type FROM client_messages WHERE id = $1 AND deleted_at IS NULL',
      [messageId],
    )
    const msg = rows[0]
    if (!msg || msg.client_id !== clientId) return res.status(404).json({ error: 'Message not found' })
    if (msg.sender_id === ctx.dbUserId) {
      return res.status(400).json({ error: 'You cannot react to your own message' })
    }
    // Same thread-visibility gate as GET /clients/:id/messages: coaches can't react in
    // admin-only threads they aren't allowed to view.
    if ((msg.thread_type === 'admin_private' || msg.thread_type === 'ai_admin') && !isAdminRole(ctx.role)) {
      return res.status(403).json({ error: 'Admin only thread' })
    }

    await pool.query(
      `INSERT INTO message_reactions (message_id, user_id, reaction_type)
       VALUES ($1, $2, $3)
       ON CONFLICT (message_id, user_id, reaction_type) DO NOTHING`,
      [messageId, ctx.dbUserId, reaction_type],
    )

    res.status(201).json({ reactions: await reactionsForMessage(messageId, ctx.dbUserId) })
  } catch (err) { next(err) }
})

// DELETE /api/coach-admin/clients/:id/messages/:messageId/reactions/:reactionType
router.delete('/clients/:id/messages/:messageId/reactions/:reactionType', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const clientId  = parseInt(req.params.id, 10)
    const messageId = parseInt(req.params.messageId, 10)
    if (!Number.isInteger(messageId)) return res.status(400).json({ error: 'Invalid message id' })
    if (!await canAccessClient(ctx, clientId)) return res.status(403).json({ error: 'Forbidden' })

    const { rows } = await pool.query(
      'SELECT client_id, sender_id FROM client_messages WHERE id = $1',
      [messageId],
    )
    if (!rows.length || rows[0].client_id !== clientId) return res.status(404).json({ error: 'Message not found' })
    if (rows[0].sender_id === ctx.dbUserId) {
      return res.status(400).json({ error: 'You cannot react to your own message' })
    }

    await pool.query(
      'DELETE FROM message_reactions WHERE message_id = $1 AND user_id = $2 AND reaction_type = $3',
      [messageId, ctx.dbUserId, req.params.reactionType],
    )

    res.json({ reactions: await reactionsForMessage(messageId, ctx.dbUserId) })
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

// PATCH /api/coach-admin/messaging/states/:clientId
// Client-level archive/unarchive: the inbox UI shows one card per client, but
// staff_inbox_states is keyed per (staff_id, client_id, thread_type) — a client with
// both a coach_thread and an admin_private row only got one archived when the toggle
// acted on just the open conversation, leaving the client visible in Active via the
// other thread. This upserts `archived` across every thread_type this staff member can
// see for this client (role-gated the same way as GET /clients/:id/thread-types), so
// "archive this client" and "restore this client" move all of their threads together.
// Body: { archived: boolean }
router.patch('/messaging/states/:clientId', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const clientId = parseInt(req.params.clientId, 10)
    if (!await canAccessClient(ctx, clientId)) return res.status(403).json({ error: 'Forbidden' })

    const { archived } = req.body
    if (typeof archived !== 'boolean') return res.status(400).json({ error: 'archived (boolean) required' })

    // Coaches only ever see coach_thread; admins see all three. Mirrors GET /clients/:id/thread-types.
    const allowedTypes = isAdminRole(ctx.role)
      ? ['admin_private', 'coach_thread', 'ai_admin']
      : ['coach_thread']

    // Only thread types that actually have messages — archiving one with no messages
    // yet would create an orphan staff_inbox_states row with nothing behind it.
    const { rows } = await pool.query(
      `SELECT DISTINCT thread_type FROM client_messages
       WHERE client_id = $1 AND thread_type = ANY($2::text[]) AND deleted_at IS NULL`,
      [clientId, allowedTypes],
    )
    const threadTypes = rows.map(r => r.thread_type)
    if (threadTypes.length === 0) return res.json({ ok: true, thread_types: [] })

    await pool.query(`
      INSERT INTO staff_inbox_states (staff_id, client_id, thread_type, archived, archived_at)
      SELECT $1, $2, t, $3, ${archived ? 'NOW()' : 'NULL'}
      FROM UNNEST($4::text[]) AS t
      ON CONFLICT (staff_id, client_id, thread_type) DO UPDATE SET
        archived = EXCLUDED.archived,
        archived_at = EXCLUDED.archived_at
    `, [ctx.dbUserId, clientId, archived, threadTypes])

    res.json({ ok: true, thread_types: threadTypes })
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
      INSERT INTO comeback_events (user_id, gap_start_date, gap_end_date, comeback_date, comeback_type, org_id)
      VALUES ($1, $2, $3, $4, $5, $6) RETURNING *
    `, [id, gap_start_date ?? null, gap_end_date ?? null, comeback_date, comeback_type, ctx.orgId])
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
        fs.ai_feedback, fs.ai_feedback_generated_at, fs.ai_feedback_generated_by,
        ft.title  AS form_title,
        ft.status AS form_status,
        fv.version_num,
        fv.schema AS version_schema,
        reviewer.first_name    AS reviewed_by_name,
        completer.first_name   AS completed_by_name,
        ai_generator.first_name AS ai_feedback_generated_by_name
      FROM form_submissions fs
      JOIN form_templates ft ON ft.id = fs.template_id
      JOIN form_versions  fv ON fv.id = fs.version_id
      LEFT JOIN users reviewer     ON reviewer.id     = fs.reviewed_by
      LEFT JOIN users completer    ON completer.id    = fs.completed_by
      LEFT JOIN users ai_generator ON ai_generator.id = fs.ai_feedback_generated_by
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
        fs.ai_feedback, fs.ai_feedback_generated_at, fs.ai_feedback_generated_by,
        ft.title  AS form_title,
        ft.status AS form_status,
        fv.version_num,
        fv.schema AS version_schema,
        reviewer.first_name    AS reviewed_by_name,
        completer.first_name   AS completed_by_name,
        ai_generator.first_name AS ai_feedback_generated_by_name
      FROM form_submissions fs
      JOIN form_templates ft ON ft.id = fs.template_id
      JOIN form_versions  fv ON fv.id = fs.version_id
      LEFT JOIN users reviewer     ON reviewer.id     = fs.reviewed_by
      LEFT JOIN users completer    ON completer.id    = fs.completed_by
      LEFT JOIN users ai_generator ON ai_generator.id = fs.ai_feedback_generated_by
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

// POST /api/coach-admin/form-submissions/:submissionId/ai-feedback
// Generates coaching feedback for a submission via Claude from its Q&A, saves
// it on the submission, and returns it. Regenerating overwrites the previous
// value — no history is kept.
router.post('/form-submissions/:submissionId/ai-feedback', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const subId = parseInt(req.params.submissionId, 10)

    const { rows: [sub] } = await pool.query(`
      SELECT fs.id, fs.user_id, fs.answers, fv.schema AS version_schema, u.first_name
      FROM form_submissions fs
      JOIN form_versions fv ON fv.id = fs.version_id
      JOIN users u          ON u.id  = fs.user_id
      WHERE fs.id = $1
    `, [subId])
    if (!sub) return res.status(404).json({ error: 'Submission not found' })
    if (!await canAccessClient(ctx, sub.user_id)) return res.status(403).json({ error: 'Forbidden' })

    const schema  = Array.isArray(sub.version_schema) ? sub.version_schema : []
    const answers = sub.answers ?? {}
    const qaText = schema
      .filter(f => f.type !== 'text_block')
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      .map(f => {
        const val = answers[f.id]
        const empty = val === undefined || val === null || val === '' ||
                      (Array.isArray(val) && val.length === 0)
        const formatted = empty ? 'No response' : Array.isArray(val) ? val.join(', ') : String(val)
        return `Q: ${f.label}\nA: ${formatted}\n`
      })
      .join('\n')

    if (!qaText.trim()) {
      return res.status(400).json({ error: 'This submission has no answered questions to generate feedback from.' })
    }

    const firstName = sub.first_name || 'there'

    const t0 = Date.now()
    const claudeMsg = await anthropic.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 1024,
      system: `You are a fitness coach reviewing a client's weekly check-in submission. Generate concise, direct coaching feedback in the voice of a supportive but no-nonsense coach. Address the client by first name. Lead with what they're doing well, then give one or two specific, actionable pieces of guidance based on their actual answers. Keep it to three to five short paragraphs. Write as natural prose, the way a coach would speak directly to their client — no markdown headers, no bullet lists.`,
      messages: [{ role: 'user', content: `Client name: ${firstName}\n\n${qaText}` }],
    })

    trackEvent({
      actorUserId:  ctx.dbUserId,
      targetUserId: sub.user_id,
      feature:      'checkin_ai_feedback',
      action:       'ai_call',
      provider:     'anthropic',
      providerOp:   'messages.create',
      model:        'claude-sonnet-4-6',
      inputTokens:  claudeMsg.usage?.input_tokens,
      outputTokens: claudeMsg.usage?.output_tokens,
      durationMs:   Date.now() - t0,
    })

    const feedback = claudeMsg.content.find(b => b.type === 'text')?.text?.trim()
    if (!feedback) return res.status(502).json({ error: 'AI did not return feedback. Try again.' })

    const { rows: [updated] } = await pool.query(
      `UPDATE form_submissions
       SET ai_feedback = $1, ai_feedback_generated_at = NOW(), ai_feedback_generated_by = $2
       WHERE id = $3
       RETURNING ai_feedback, ai_feedback_generated_at, ai_feedback_generated_by`,
      [feedback, ctx.dbUserId, subId],
    )
    const { rows: [generator] } = await pool.query('SELECT first_name FROM users WHERE id = $1', [ctx.dbUserId])

    res.json({
      ai_feedback:                   updated.ai_feedback,
      ai_feedback_generated_at:      updated.ai_feedback_generated_at,
      ai_feedback_generated_by:      updated.ai_feedback_generated_by,
      ai_feedback_generated_by_name: generator?.first_name ?? null,
    })
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

    // Verify form exists, is published, and belongs to the caller's org — same
    // isSuperAdmin(ctx)/org_id-filter pattern as forms.js. Without this, staff
    // could enumerate template ids and send another org's form: its title
    // leaked into the client-facing message body and created a cross-org
    // form_assignments row.
    const bypassOrgTpl = isSuperAdmin(ctx)
    const orgFilterTpl = bypassOrgTpl ? '' : ` AND org_id = $2`
    const { rows: [tpl] } = await pool.query(
      `SELECT id, title, status, current_version_id FROM form_templates WHERE id = $1${orgFilterTpl}`,
      bypassOrgTpl ? [templateId] : [templateId, ctx.orgId],
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
      // Coaches are limited to coach_thread; admin uses ai_admin for every
      // non-VIP tier (hybrid, basic, plus legacy 'ai'), coach_thread for VIP.
      // Routing a non-VIP client to coach_thread would drop the form into a
      // thread they can't see — visibleThreadTypesForClient() hides it.
      let thread_type = 'coach_thread'
      if (isAdminRole(ctx.role) && AI_ADMIN_THREAD_TYPES.includes(client.coaching_type)) thread_type = 'ai_admin'

      const visibility = (thread_type === 'admin_private' || thread_type === 'ai_admin')
        ? 'client_and_admin_only'
        : 'client_and_staff'

      const firstName = client.first_name ?? 'there'
      const messageBody = formMessageBody(firstName, tpl.title)
      const metadata = { form_id: templateId, assignment_id: assignment.id, form_title: tpl.title }

      const { rows: [message] } = await pool.query(`
        INSERT INTO client_messages
          (client_id, sender_id, sender_role, message_body, thread_type, visibility, metadata, org_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
        RETURNING id, metadata
      `, [clientId, ctx.dbUserId, ctx.role, messageBody, thread_type, visibility, JSON.stringify(metadata), ctx.orgId])

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

    // Same org gate as /forms/:id/send above — without it staff could schedule
    // another org's form for their own clients.
    const bypassOrgTpl = isSuperAdmin(ctx)
    const orgFilterTpl = bypassOrgTpl ? '' : ` AND org_id = $2`
    const { rows: [tpl] } = await pool.query(
      `SELECT id, title, status, current_version_id FROM form_templates WHERE id = $1${orgFilterTpl}`,
      bypassOrgTpl ? [templateId] : [templateId, ctx.orgId],
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
      const params = []
      let clause = ''
      if (!isSuperAdmin(ctx)) {
        params.push(ctx.orgId)
        clause += ` AND u.org_id = $${params.length}`
      }
      if (clientId) {
        params.push(clientId)
        clause += ` AND fa.client_id = $${params.length}`
      }
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
    // day_notes bundled here (rather than requiring a second request) so opening a
    // program in the builder renders its notes in the same paint as its exercises.
    // The dedicated GET .../day-notes route below still exists for refetching alone.
    const day_notes = await getWorkoutDayNotes(workoutId)
    res.json({ ...workout, exercises, logs, day_notes })
  } catch (err) { next(err) }
})

// ── Saved workout-builder settings (client_workout_profile) ──────────────────
// The coach's last-saved answers to the "Generate with Katie" questionnaire for
// this client, so the form pre-fills instead of starting blank. Purely a
// convenience store: the generate route below still takes its answers from the
// request body and never reads this table, so a coach can tweak the form for a
// one-off session without overwriting the client's saved default.

const WORKOUT_PROFILE_COLUMNS = `id, user_id, goals, secondary_goal, days_per_week, session_length,
                                 equipment, fitness_level, strength_history, floor_transfer,
                                 supersets, circuits, injuries, updated_at, updated_by`

// Values are persisted exactly as the form's own option strings — no lowercasing
// or normalizing — so a saved row can be spread straight back into the form:
// equipment stays ['Kettlebell', 'Body Weight', …], session_length stays
// '30 minutes'. days_per_week is the one coerced field (integer, or NULL when
// blank/unparseable).
function normalizeWorkoutProfileBody(body = {}) {
  const text = v => (typeof v === 'string' && v.trim() ? v : v === 0 ? String(v) : (v ?? null))
  const days = parseInt(body.days_per_week, 10)
  return {
    goals:            text(body.goals),
    secondary_goal:   text(body.secondary_goal),
    days_per_week:    Number.isFinite(days) ? days : null,
    session_length:   text(body.session_length),
    equipment:        Array.isArray(body.equipment) ? body.equipment.filter(e => typeof e === 'string' && e.trim()) : [],
    fitness_level:    text(body.fitness_level),
    strength_history: text(body.strength_history),
    floor_transfer:   text(body.floor_transfer),
    supersets:        text(body.supersets),
    circuits:         text(body.circuits),
    injuries:         text(body.injuries),
  }
}

// GET /api/coach-admin/clients/:id/workout-profile — saved builder settings, or null
router.get('/clients/:id/workout-profile', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const clientId = parseInt(req.params.id, 10)
    if (!(await canAccessClient(ctx, clientId))) return res.status(403).json({ error: 'Access denied' })
    const { rows } = await pool.query(
      `SELECT ${WORKOUT_PROFILE_COLUMNS} FROM client_workout_profile WHERE user_id = $1`,
      [clientId],
    )
    // First-time use is the common case — respond 200 with null rather than 404
    // so the client can treat "no saved profile" as "leave the form blank".
    res.json(rows[0] ?? null)
  } catch (err) { next(err) }
})

// PUT /api/coach-admin/clients/:id/workout-profile — upsert the saved builder settings
router.put('/clients/:id/workout-profile', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const clientId = parseInt(req.params.id, 10)
    if (!(await canAccessClient(ctx, clientId))) return res.status(403).json({ error: 'Access denied' })
    const p = normalizeWorkoutProfileBody(req.body)
    // ON CONFLICT (user_id) is what keeps this one row per client — the UNIQUE
    // constraint in db.js's client_workout_profile migration backs it.
    const { rows } = await pool.query(
      `INSERT INTO client_workout_profile
         (user_id, goals, secondary_goal, days_per_week, session_length, equipment,
          fitness_level, strength_history, floor_transfer, supersets, circuits, injuries,
          updated_at, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW(), $13)
       ON CONFLICT (user_id) DO UPDATE SET
         goals            = EXCLUDED.goals,
         secondary_goal   = EXCLUDED.secondary_goal,
         days_per_week    = EXCLUDED.days_per_week,
         session_length   = EXCLUDED.session_length,
         equipment        = EXCLUDED.equipment,
         fitness_level    = EXCLUDED.fitness_level,
         strength_history = EXCLUDED.strength_history,
         floor_transfer   = EXCLUDED.floor_transfer,
         supersets        = EXCLUDED.supersets,
         circuits         = EXCLUDED.circuits,
         injuries         = EXCLUDED.injuries,
         updated_at       = NOW(),
         updated_by       = EXCLUDED.updated_by
       RETURNING ${WORKOUT_PROFILE_COLUMNS}`,
      [clientId, p.goals, p.secondary_goal, p.days_per_week, p.session_length, p.equipment,
       p.fitness_level, p.strength_history, p.floor_transfer, p.supersets, p.circuits,
       p.injuries, ctx.dbUserId],
    )
    res.json(rows[0])
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
    if (!answers.goals?.length || !answers.days_per_week || !answers.fitness_level || !answers.supersets || !answers.circuits) {
      return res.status(400).json({ error: 'Missing required fields: goals, days_per_week, fitness_level, supersets, circuits' })
    }
    if (!answers.strength_history) {
      return res.status(400).json({ error: 'Missing required field: strength_history' })
    }
    if (!answers.floor_transfer) {
      return res.status(400).json({ error: 'Missing required field: floor_transfer' })
    }

    // Get client first name for Katie prompt
    const { rows: [client] } = await pool.query(
      'SELECT first_name FROM users WHERE id = $1', [clientId]
    )
    const firstName = client?.first_name || 'your client'

    // Get health assessment injuries to supplement the questionnaire injuries field
    const { rows: [assessment] } = await pool.query(
      'SELECT injuries_limitations FROM health_assessments WHERE user_id = $1', [clientId]
    )
    const healthAssessmentInjuries = assessment?.injuries_limitations || null

    const plan = await generateWorkoutPlan(pool, firstName, answers, {
      healthAssessmentInjuries,
      forceBilateral: false,
      coachName: await getOrgCoachName(req.orgId),
      // TEMPORARY — see workout_circuit_diagnostics in db.js
      userId: clientId,
      orgId: req.orgId,
    })

    res.json(plan)
  } catch (err) {
    if (err instanceof ExerciseLibraryError) {
      return res.status(503).json({ error: err.message })
    }
    next(err)
  }
})

// POST /api/coach-admin/clients/:id/workouts — create a workout program for a client
// Accepts optional `days` (AI-generated plan structure) to save full program at once.
router.post('/clients/:id/workouts', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const clientId = parseInt(req.params.id, 10)
    if (!(await canAccessClient(ctx, clientId))) return res.status(403).json({ error: 'Access denied' })
    const { name, description, days, status, requested_circuits } = req.body
    if (!name?.trim()) return res.status(400).json({ error: 'name required' })
    if (status && !['draft', 'assigned'].includes(status)) {
      return res.status(400).json({ error: 'status must be draft or assigned' })
    }
    // org_id is derived from the CLIENT's row, not ctx.orgId: a super admin
    // building a program for another org's client would otherwise stamp their
    // own org (1) onto it. canAccessClient() above already guarantees the
    // client is in ctx's org for everyone except super admin.
    // requested_circuits: passed through from the /generate response by the
    // client (see ClientProfile.jsx savePlan) — undefined/null for a manually-
    // built program that never went through AI generation.
    const { rows: [workout] } = await pool.query(
      `INSERT INTO workouts (user_id, name, description, status, org_id, requested_circuits)
       VALUES ($1,$2,$3,$4,(SELECT org_id FROM users WHERE id = $1),$5::jsonb) RETURNING *`,
      [clientId, name.trim(), description ?? null, status === 'draft' ? 'draft' : 'assigned', requested_circuits != null ? JSON.stringify(requested_circuits) : null],
    )
    // If a full plan with days was provided (e.g. from Katie generation), save exercises too
    if (Array.isArray(days) && days.length > 0) {
      for (const day of days) {
        let dayOrder = 0
        for (const ex of (day.exercises || [])) {
          // image_url / instructions carried through as-is from the request
          // body. The live "Generate with Katie" flow (generateWorkoutPlan()
          // in workoutGenerator.js, called from the /generate route above)
          // never sets these on its returned exercises, so today they save as
          // null here; image_url is instead resolved at read time from the
          // legacy exercises table (see the GET /:wid route above). Columns
          // are still accepted as-is for any future caller that does supply them.
          await insertWorkoutExercise({
            workout_id: workout.id, day: day.day_name, exercise_name: ex.name,
            exercise_id: ex.exercise_id ?? null, day_focus: day.focus ?? null,
            sets: ex.sets ?? null, reps: ex.reps ?? null, rest_seconds: ex.rest_seconds ?? null,
            notes: ex.notes ?? null, sort_order: dayOrder++,
            image_url: ex.image_url ?? null, instructions: ex.instructions ?? null,
            section_name: ex.section_name ?? null,
            group_id: ex.group_id ?? null, group_type: ex.group_type ?? 'exercise',
            group_label: ex.group_label ?? null, org_id: workout.org_id,
          })
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
       WHERE id=$1 AND user_id=$2
         AND org_id = (SELECT org_id FROM users WHERE id = $2) RETURNING *`,
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
      'SELECT id, org_id FROM workouts WHERE id=$1 AND user_id=$2', [workoutId, clientId])
    if (!w) return res.status(404).json({ error: 'Workout not found' })
    const {
      day, exercise_name, exercise_id, sets, reps, weight, rest_seconds, notes, sort_order,
      section_name, group_id, group_type, group_label,
    } = req.body
    if (!exercise_name?.trim()) return res.status(400).json({ error: 'exercise_name required' })
    if (group_type && !['exercise', 'superset', 'circuit'].includes(group_type)) {
      return res.status(400).json({ error: 'group_type must be exercise, superset, or circuit' })
    }
    const ex = await insertWorkoutExercise({
      workout_id: workoutId, day: day ?? 'Day 1', exercise_name: exercise_name.trim(),
      exercise_id: exercise_id ?? null, sets: sets ?? null, reps: reps ?? null,
      weight: weight ?? null, rest_seconds: rest_seconds ?? null, notes: notes ?? null,
      sort_order: sort_order ?? 0, section_name: section_name ?? null, group_id: group_id ?? null,
      group_type: group_type ?? 'exercise', group_label: group_label ?? null, org_id: w.org_id,
    }, { resolveImageUrl: true })
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
    const allowed = [
      'exercise_name', 'exercise_id', 'sets', 'reps', 'weight', 'rest_seconds', 'notes', 'day', 'sort_order',
      'section_name', 'group_id', 'group_type', 'group_label',
    ]
    const entries = Object.entries(req.body).filter(([k]) => allowed.includes(k))
    if (!entries.length) return res.status(400).json({ error: 'No valid fields' })
    if (entries.some(([k, v]) => k === 'group_type' && !['exercise', 'superset', 'circuit'].includes(v))) {
      return res.status(400).json({ error: 'group_type must be exercise, superset, or circuit' })
    }
    const setClauses = entries.map(([k], i) => `${k}=$${i + 2}`).join(', ')
    // org_id predicate is defence in depth on top of the ownership check above.
    // Compared against the CLIENT's org rather than ctx.orgId so the super-admin
    // console still works cross-org; for everyone else canAccessClient() has
    // already proven client.org_id === ctx.orgId.
    const { rows: [updated] } = await pool.query(
      `UPDATE workout_exercises SET ${setClauses}
       WHERE id=$1 AND org_id = (SELECT org_id FROM users WHERE id = $${entries.length + 2})
       RETURNING *, COALESCE(
         (SELECT image_url FROM exercises WHERE id = workout_exercises.exercise_id),
         (SELECT image_url FROM exercises
            WHERE lower(trim(name)) = lower(trim(workout_exercises.exercise_name))
              AND image_url IS NOT NULL
            ORDER BY id LIMIT 1)
       ) AS image_url`,
      [exId, ...entries.map(([, v]) => v), clientId],
    )
    if (!updated) return res.status(404).json({ error: 'Exercise not found' })
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
       WHERE we.workout_id=w.id AND we.id=$1 AND w.user_id=$2
         AND we.org_id = (SELECT org_id FROM users WHERE id = $2)`, [exId, clientId])
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
      `DELETE FROM workouts WHERE id=$1 AND user_id=$2
         AND org_id = (SELECT org_id FROM users WHERE id = $2)`, [workoutId, clientId])
    if (!rowCount) return res.status(404).json({ error: 'Workout not found' })
    res.json({ ok: true })
  } catch (err) { next(err) }
})

// ─── Workout day notes ──────────────────────────────────────────────────────────
// Coach-authored note rendered above the Warm-Up section of a single day. Keyed by
// (workout_id, day) since a day has no row of its own — see workout_day_notes in
// db.js. Both routes verify the workout actually belongs to this client (on top of
// canAccessClient) so a workoutId from another client's program can't be written.
// These are 3-segment paths under /workouts/, so they never shadow the 1-segment
// /clients/:id/workouts/:wid program routes above.

// GET /api/coach-admin/clients/:id/workouts/:workoutId/day-notes
// -> { "Day 1": "note text", … } — days with no note are simply absent.
router.get('/clients/:id/workouts/:workoutId/day-notes', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const clientId  = parseInt(req.params.id, 10)
    const workoutId = parseInt(req.params.workoutId, 10)
    if (!(await canAccessClient(ctx, clientId))) return res.status(403).json({ error: 'Access denied' })
    const { rows: [w] } = await pool.query(
      'SELECT id FROM workouts WHERE id=$1 AND user_id=$2', [workoutId, clientId])
    if (!w) return res.status(404).json({ error: 'Workout not found' })
    res.json(await getWorkoutDayNotes(workoutId))
  } catch (err) { next(err) }
})

// PUT /api/coach-admin/clients/:id/workouts/:workoutId/day-notes/:day
// body: { note_text }. An empty/whitespace-only note DELETEs the row rather than
// storing a blank one, so GET never has to tell "cleared" apart from "never set".
router.put('/clients/:id/workouts/:workoutId/day-notes/:day', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const clientId  = parseInt(req.params.id, 10)
    const workoutId = parseInt(req.params.workoutId, 10)
    const day       = String(req.params.day ?? '').trim()
    if (!(await canAccessClient(ctx, clientId))) return res.status(403).json({ error: 'Access denied' })
    if (!day) return res.status(400).json({ error: 'day required' })
    const { rows: [w] } = await pool.query(
      'SELECT id FROM workouts WHERE id=$1 AND user_id=$2', [workoutId, clientId])
    if (!w) return res.status(404).json({ error: 'Workout not found' })

    const noteText = typeof req.body?.note_text === 'string' ? req.body.note_text.trim() : ''
    if (!noteText) {
      await pool.query('DELETE FROM workout_day_notes WHERE workout_id=$1 AND day=$2', [workoutId, day])
      return res.json({ day, note_text: null })
    }
    const { rows: [note] } = await pool.query(
      `INSERT INTO workout_day_notes (workout_id, day, note_text, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (workout_id, day)
         DO UPDATE SET note_text = EXCLUDED.note_text, updated_at = NOW()
       RETURNING day, note_text`,
      [workoutId, day, noteText],
    )
    res.json(note)
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

// ─── Client Tags ──────────────────────────────────────────────────────────────
// CRM-style tagging for clients (inline chips on the dashboard).
// Staff+ can view tags; admin+ can add/remove.

// GET /api/coach-admin/clients/:id/tags — list tags for a client
router.get('/clients/:id/tags', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const id = parseInt(req.params.id, 10)
    if (!await canAccessClient(ctx, id)) return res.status(403).json({ error: 'Forbidden' })

    const { rows } = await pool.query(
      `SELECT id, tag_name, created_at FROM client_tags
       WHERE user_id = $1 ORDER BY tag_name ASC`,
      [id],
    )
    res.json(rows)
  } catch (err) { next(err) }
})

// POST /api/coach-admin/clients/:id/tags — add a tag (admin+ only)
router.post('/clients/:id/tags', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireAdmin(req, res); if (!ctx) return
    const id = parseInt(req.params.id, 10)
    if (!await canAccessClient(ctx, id)) return res.status(403).json({ error: 'Forbidden' })

    const { tag_name } = req.body
    if (!tag_name?.trim()) return res.status(400).json({ error: 'tag_name is required' })

    const normalized = tag_name.trim().toLowerCase().slice(0, 50)
    if (normalized.length === 0) return res.status(400).json({ error: 'tag_name cannot be empty' })

    // Check if we would exceed max 10 tags
    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*)::int AS count FROM client_tags WHERE user_id = $1`,
      [id],
    )
    if (countRows[0].count >= 10) {
      return res.status(400).json({ error: 'Maximum 10 tags per client' })
    }

    try {
      const { rows } = await pool.query(
        `INSERT INTO client_tags (user_id, tag_name, created_by)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, tag_name) DO NOTHING
         RETURNING id, tag_name, created_at`,
        [id, normalized, ctx.dbUserId],
      )
      if (!rows.length) {
        return res.status(409).json({ ok: true, message: 'Tag already exists' })
      }
      res.status(201).json(rows[0])
    } catch (dbErr) {
      if (dbErr.code === '23503') return res.status(404).json({ error: 'Client not found' })
      throw dbErr
    }
  } catch (err) { next(err) }
})

// DELETE /api/coach-admin/clients/:id/tags/:tagName — remove a tag (admin+ only)
router.delete('/clients/:id/tags/:tagName', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireAdmin(req, res); if (!ctx) return
    const id = parseInt(req.params.id, 10)
    if (!await canAccessClient(ctx, id)) return res.status(403).json({ error: 'Forbidden' })
    const tagName = req.params.tagName.toLowerCase()

    const { rowCount } = await pool.query(
      `DELETE FROM client_tags
       WHERE user_id = $1 AND tag_name = $2`,
      [id, tagName],
    )
    if (!rowCount) return res.status(404).json({ error: 'Tag not found' })
    res.json({ ok: true })
  } catch (err) { next(err) }
})

// ─── Katie Corrections ────────────────────────────────────────────────────────
// Admin-only management of katie_corrections — fixes a wrong/hedged Katie answer
// without a code deploy (see server/services/katieCorrections.js, which reads
// this table at chat time). Quality control here stays admin-level, not coach.

// GET /api/coach-admin/katie-corrections — list this org's, newest first.
// Scoped by org_id, not just by role: under multi-tenancy every org has its own
// 'admin' user, so requireAdmin alone would let Org B read Org A's corrections.
// Super admin (the platform-owner email allowlist) still sees all orgs, matching
// how the rest of this file treats cross-org support access.
router.get('/katie-corrections', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireAdmin(req, res); if (!ctx) return

    const params = []
    let orgWhere = ''
    if (!isSuperAdmin(ctx)) {
      params.push(ctx.orgId)
      orgWhere = `WHERE c.org_id = $${params.length}`
    }
    const { rows } = await pool.query(`
      SELECT c.id, c.trigger_keywords, c.correct_answer, c.active, c.created_at,
             u.first_name AS created_by_name
      FROM katie_corrections c
      LEFT JOIN users u ON u.id = c.created_by
      ${orgWhere}
      ORDER BY c.created_at DESC
    `, params)
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

    // org_id comes from the authenticated caller's context, never the request
    // body. Leaving it NULL is not a safe default here: 001_multi_tenancy's
    // backfill re-runs `UPDATE ... SET org_id = 1 WHERE org_id IS NULL` on every
    // boot, so an unscoped insert would silently become org 1's correction and
    // be served into that org's Katie answers.
    const { rows } = await pool.query(`
      INSERT INTO katie_corrections (org_id, trigger_keywords, correct_answer, created_by, active)
      VALUES ($1, $2, $3, $4, TRUE)
      RETURNING id, trigger_keywords, correct_answer, active, created_at
    `, [ctx.orgId, keywords, correct_answer.trim(), ctx.dbUserId])
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

    // The org guard lives in the WHERE clause so a cross-org id simply matches
    // no row and falls through to the same 404 a nonexistent id gets — callers
    // can't probe which ids exist in another org.
    const params = [active, id]
    let orgWhere = ''
    if (!isSuperAdmin(ctx)) {
      params.push(ctx.orgId)
      orgWhere = ` AND org_id = $${params.length}`
    }
    const { rows } = await pool.query(
      `UPDATE katie_corrections SET active = $1 WHERE id = $2${orgWhere}
       RETURNING id, trigger_keywords, correct_answer, active, created_at`,
      params,
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

    // Same WHERE-clause org guard as PATCH above — a cross-org id deletes
    // nothing and 404s identically to a nonexistent one.
    const params = [id]
    let orgWhere = ''
    if (!isSuperAdmin(ctx)) {
      params.push(ctx.orgId)
      orgWhere = ` AND org_id = $${params.length}`
    }
    const { rowCount } = await pool.query(
      `DELETE FROM katie_corrections WHERE id = $1${orgWhere}`,
      params,
    )
    if (!rowCount) return res.status(404).json({ error: 'Correction not found' })
    res.json({ ok: true })
  } catch (err) { next(err) }
})

export default router
