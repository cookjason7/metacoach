// Regression tests for the invite self-claim 410 bug.
//
// Background: client_invites.accepted_at has three writers (see the
// isClaimedByDifferentEmail doc comment in invites.js). getOrCreateUser()'s
// auto-claim stamps it as a side effect of the invited person's first
// authenticated request — BEFORE the explicit accept route runs. If that request
// was then interrupted, the invite was left marked accepted and its rightful
// owner was locked out of their own link forever with a 410.
//
// These exercise the REAL router mounted in a real express app. GET /:token is
// public (no Clerk auth), so the full request path — including the real DB
// queries and the real guard — is covered without stubbing anything.
//
// Requires a DATABASE_URL pointing at a NON-PRODUCTION database; every row it
// creates is namespaced with a unique token/email and removed in the finally.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { randomUUID } from 'node:crypto'
import { pool } from '../db.js'
import invitesRouter from './invites.js'

const RUN = randomUUID().slice(0, 8)
const seededInviteIds = []
const seededUserIds   = []
let server, baseUrl

/** Creates a users row we can point accepted_by_user_id at. */
async function seedUser(email) {
  const { rows } = await pool.query(
    `INSERT INTO users (clerk_user_id, email, first_name, role)
     VALUES ($1, $2, 'Test', 'client') RETURNING id`,
    [`test_clerk_${RUN}_${randomUUID().slice(0, 8)}`, email],
  )
  seededUserIds.push(rows[0].id)
  return rows[0].id
}

/** Creates a client_invites row in whatever state the scenario needs. */
async function seedInvite({ email, acceptedByUserId = null, acceptedAt = null, expiresAt }) {
  const token = `test-${RUN}-${randomUUID()}`
  const { rows } = await pool.query(
    `INSERT INTO client_invites
       (token, email, first_name, last_name, coaching_type, expires_at, accepted_at, accepted_by_user_id, org_id)
     VALUES ($1, $2, 'Test', 'Invitee', 'vip', $3, $4, $5, 1) RETURNING id, token`,
    [token, email, expiresAt, acceptedAt, acceptedByUserId],
  )
  seededInviteIds.push(rows[0].id)
  return rows[0].token
}

const hourFromNow = () => new Date(Date.now() + 60 * 60 * 1000).toISOString()
const hourAgo     = () => new Date(Date.now() - 60 * 60 * 1000).toISOString()

before(async () => {
  const app = express()
  app.use('/api/client-invites', invitesRouter)
  await new Promise(resolve => { server = app.listen(0, resolve) })
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  if (seededInviteIds.length) {
    await pool.query('DELETE FROM client_invites WHERE id = ANY($1)', [seededInviteIds])
  }
  if (seededUserIds.length) {
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [seededUserIds])
  }
  await new Promise(resolve => server.close(resolve))
  await pool.end()
})

// ── The bug this fix exists for ──────────────────────────────────────────────

test('self-claimed invite is still usable by its owner (the orphaned auto-claim case)', async () => {
  const email = `selfclaim-${RUN}@example.test`
  const userId = await seedUser(email)
  // Exactly the production shape of Julie Sutton's row: accepted_at stamped by
  // getOrCreateUser's auto-claim, accepted_by pointing at the invitee herself,
  // the explicit accept never having completed.
  const token = await seedInvite({
    email, acceptedByUserId: userId, acceptedAt: new Date().toISOString(), expiresAt: hourFromNow(),
  })

  const res = await fetch(`${baseUrl}/api/client-invites/${token}`)
  assert.equal(res.status, 200, 'owner must not be locked out of their own claimed invite')
  const body = await res.json()
  assert.equal(body.email, email)
  assert.equal(body.first_name, 'Test')
})

test('self-claimed invite stays usable even after it expires', async () => {
  const email = `selfclaim-expired-${RUN}@example.test`
  const userId = await seedUser(email)
  const token = await seedInvite({
    email, acceptedByUserId: userId, acceptedAt: hourAgo(), expiresAt: hourAgo(),
  })

  const res = await fetch(`${baseUrl}/api/client-invites/${token}`)
  assert.equal(res.status, 200, 'a claim already applied to the account outlives the expiry window')
})

// ── The case that must STILL be rejected ─────────────────────────────────────

test('invite claimed by a different email still returns 410 already-accepted', async () => {
  const inviteEmail   = `owner-${RUN}@example.test`
  const strangerEmail = `stranger-${RUN}@example.test`
  const strangerId    = await seedUser(strangerEmail)
  const token = await seedInvite({
    email: inviteEmail, acceptedByUserId: strangerId, acceptedAt: new Date().toISOString(), expiresAt: hourFromNow(),
  })

  const res = await fetch(`${baseUrl}/api/client-invites/${token}`)
  assert.equal(res.status, 410, 'a genuine cross-email conflict must still be refused')
  const body = await res.json()
  assert.match(body.error, /already been accepted/)
})

test('claimant email match is case- and whitespace-insensitive', async () => {
  const email  = `MixedCase-${RUN}@Example.Test`
  const userId = await seedUser(email.toLowerCase())
  const token  = await seedInvite({
    email: `  ${email.toUpperCase()}  `, acceptedByUserId: userId,
    acceptedAt: new Date().toISOString(), expiresAt: hourFromNow(),
  })

  const res = await fetch(`${baseUrl}/api/client-invites/${token}`)
  assert.equal(res.status, 200, 'casing/whitespace must not make an owner look like a stranger')
})

// ── Untouched behaviour ──────────────────────────────────────────────────────

test('unclaimed, unexpired invite still returns its details', async () => {
  const email = `pending-${RUN}@example.test`
  const token = await seedInvite({ email, expiresAt: hourFromNow() })

  const res = await fetch(`${baseUrl}/api/client-invites/${token}`)
  assert.equal(res.status, 200)
  assert.equal((await res.json()).email, email)
})

test('unclaimed but expired invite still returns 410 expired', async () => {
  const email = `expired-${RUN}@example.test`
  const token = await seedInvite({ email, expiresAt: hourAgo() })

  const res = await fetch(`${baseUrl}/api/client-invites/${token}`)
  assert.equal(res.status, 410, 'expiry must still bar an invite nobody ever claimed')
  assert.match((await res.json()).error, /expired/)
})

test('unknown token still returns 404', async () => {
  const res = await fetch(`${baseUrl}/api/client-invites/definitely-not-a-real-token-${RUN}`)
  assert.equal(res.status, 404)
})

test('claim orphaned by a deleted claimant is treated as self-claimed, not a conflict', async () => {
  // client_invites.accepted_by_user_id is ON DELETE SET NULL, so deleting the
  // claimant leaves accepted_at set with no attribution at all. That must not
  // become a permanent lockout — with nobody to attribute the claim to we let
  // the owner through and rely on the accept route's own email-match check.
  const email  = `ghost-${RUN}@example.test`
  const userId = await seedUser(`ghost-claimant-${RUN}@example.test`)
  const token  = await seedInvite({
    email, acceptedByUserId: userId, acceptedAt: new Date().toISOString(), expiresAt: hourFromNow(),
  })
  await pool.query('DELETE FROM users WHERE id = $1', [userId])
  seededUserIds.splice(seededUserIds.indexOf(userId), 1)

  const res = await fetch(`${baseUrl}/api/client-invites/${token}`)
  assert.equal(res.status, 200)
})
