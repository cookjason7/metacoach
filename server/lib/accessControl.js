import { pool, isAdminEmail } from '../db.js'

// Shared staff/access-control primitives. Originally lived in routes/coachAdmin.js;
// extracted so other client-facing routers (view-as-client) can reuse the exact same
// authorization logic instead of re-deriving it.

export function isAdminRole(role) {
  return role === 'admin' || role === 'account_owner'
}

// 'va' — client onboarding/transition role. Narrow scope: can invite clients,
// view basic client info, and set coaching_type at invite time. Deliberately
// NOT included in requireStaff/isAdminRole, so every messaging/notes/workouts/
// forms/assessment/health/payment/lifecycle route stays 403 for it by default.
export function isVaRole(role) {
  return role === 'va'
}

// Super admin (platform owner accounts in ADMIN_EMAILS, e.g. Jason) bypasses org
// scoping entirely and sees/manages every org. This is deliberately NOT the same
// check as isAdminRole()/'admin' role: under multi-tenancy every org gets its own
// 'admin' user too, so role alone is not enough to grant cross-org access — only
// the hardcoded platform-owner allowlist should.
export function isSuperAdmin(ctx) {
  return isAdminEmail(ctx.email)
}

// Returns true if staff member (admin or coach) can access this client.
// Super admin bypasses org scoping entirely. Everyone else — including org-level
// 'admin' role staff — must be in the same org as the client; coaches additionally
// must be that client's assigned coach.
export async function canAccessClient(ctx, clientId) {
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
