// Organizations.jsx — super admin (Jason only) SaaS tenant management.
// Rendered at /admin/organizations, gated by SuperAdminRoute in App.jsx.
import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '@clerk/clerk-react'
import { API_URL } from '../../config.js'

// ── Constants ─────────────────────────────────────────────────────────────────

const TIERS = ['trial', 'starter', 'pro', 'enterprise']
const STATUSES = ['active', 'trialing', 'past_due', 'cancelled', 'paused']

const STATUS_STYLES = {
  active:    'bg-emerald-50 text-emerald-700 border-emerald-200',
  trialing:  'bg-blue-50 text-blue-700 border-blue-200',
  past_due:  'bg-amber-50 text-amber-700 border-amber-200',
  paused:    'bg-gray-100 text-gray-600 border-gray-300',
  cancelled: 'bg-red-50 text-red-600 border-red-200',
}

const EMPTY_CREATE = { name: '', slug: '', subscription_tier: 'trial', max_clients: '50' }
const EMPTY_INVITE = { first_name: '', last_name: '', email: '' }

function slugify(input) {
  return String(input).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

function fmtDate(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function tierLabel(tier) {
  return tier.charAt(0).toUpperCase() + tier.slice(1)
}

function statusLabel(status) {
  return status.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}

function ownerName(org) {
  const name = [org.owner_first_name, org.owner_last_name].filter(Boolean).join(' ')
  if (name) return name
  if (org.owner_email) return org.owner_email
  return '—'
}

// ── Small shared UI ──────────────────────────────────────────────────────────

function StatusBadge({ status }) {
  const style = STATUS_STYLES[status] ?? STATUS_STYLES.paused
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-bold whitespace-nowrap ${style}`}>
      {statusLabel(status)}
    </span>
  )
}

function StatCard({ label, value }) {
  return (
    <div className="bg-white rounded-2xl border border-gray-200 p-4 flex flex-col gap-0.5">
      <span className="text-xs text-gray-500">{label}</span>
      <span className="text-2xl font-bold text-gray-900">{value}</span>
    </div>
  )
}

function ModalShell({ title, onClose, children, wide }) {
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 px-4 py-5">
      <div className={`w-full ${wide ? 'max-w-lg' : 'max-w-md'} max-h-[90vh] overflow-y-auto rounded-xl bg-white shadow-xl border border-gray-200 p-5`}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold text-gray-900">{title}</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="min-w-11 min-h-11 flex items-center justify-center text-gray-400 hover:text-gray-600 -mr-2 -mt-1"
          >
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

// ── Create Organization modal ────────────────────────────────────────────────

function CreateOrgModal({ onClose, onCreated, getToken }) {
  const [form, setForm]           = useState(EMPTY_CREATE)
  const [slugTouched, setSlugTouched] = useState(false)
  const [saving, setSaving]       = useState(false)
  const [error, setError]         = useState(null)

  function setName(name) {
    setForm(f => ({ ...f, name, slug: slugTouched ? f.slug : slugify(name) }))
  }
  function setSlug(slug) {
    setSlugTouched(true)
    setForm(f => ({ ...f, slug: slugify(slug) }))
  }

  async function submit(e) {
    e.preventDefault()
    if (!form.name.trim()) { setError('Organization name is required.'); return }
    if (!form.slug.trim()) { setError('Slug is required.'); return }
    setSaving(true); setError(null)
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/organizations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          name: form.name.trim(),
          slug: form.slug.trim(),
          subscription_tier: form.subscription_tier,
          max_clients: form.max_clients !== '' ? Number(form.max_clients) : 50,
        }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error || 'Failed to create organization')
      onCreated(body)
    } catch (err) { setError(err.message) } finally { setSaving(false) }
  }

  return (
    <ModalShell title="New Organization" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Organization Name *</label>
          <input
            type="text" value={form.name} onChange={e => setName(e.target.value)} required autoFocus
            placeholder="e.g. Peak Performance Coaching"
            className="w-full min-h-11 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Slug *</label>
          <input
            type="text" value={form.slug} onChange={e => setSlug(e.target.value)} required
            placeholder="peak-performance-coaching"
            className="w-full min-h-11 border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-[#E8670A]"
          />
          <p className="text-[11px] text-gray-400 mt-1 break-all">app.lwcvip.com/{form.slug || '…'}</p>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Subscription Tier</label>
            <select
              value={form.subscription_tier}
              onChange={e => setForm(f => ({ ...f, subscription_tier: e.target.value }))}
              className="w-full min-h-11 border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#E8670A]"
            >
              {TIERS.map(t => <option key={t} value={t}>{tierLabel(t)}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Max Clients</label>
            <input
              type="number" min="1" value={form.max_clients}
              onChange={e => setForm(f => ({ ...f, max_clients: e.target.value }))}
              className="w-full min-h-11 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]"
            />
          </div>
        </div>
        {error && <p className="text-xs text-red-500">{error}</p>}
        <div className="flex gap-2 pt-1">
          <button type="submit" disabled={saving}
            className="min-h-11 flex-1 bg-[#E8670A] text-white px-5 py-2 rounded-lg text-sm font-semibold hover:bg-[#c45e09] disabled:opacity-60 transition-colors">
            {saving ? 'Creating…' : 'Create Organization'}
          </button>
          <button type="button" onClick={onClose}
            className="min-h-11 px-4 text-sm text-gray-500 hover:text-gray-700">Cancel</button>
        </div>
      </form>
    </ModalShell>
  )
}

// ── Edit Organization modal ──────────────────────────────────────────────────

function EditOrgModal({ org, onClose, onSaved, getToken }) {
  const [form, setForm] = useState({
    name: org.name,
    slug: org.slug,
    subscription_tier: org.subscription_tier,
    subscription_status: org.subscription_status,
    max_clients: String(org.max_clients ?? 50),
    trial_ends_at: org.trial_ends_at ? org.trial_ends_at.slice(0, 10) : '',
  })
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState(null)

  async function submit(e) {
    e.preventDefault()
    if (!form.name.trim()) { setError('Organization name is required.'); return }
    if (!form.slug.trim()) { setError('Slug is required.'); return }
    setSaving(true); setError(null)
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/organizations/${org.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          name: form.name.trim(),
          slug: slugify(form.slug),
          subscription_tier: form.subscription_tier,
          subscription_status: form.subscription_status,
          max_clients: form.max_clients !== '' ? Number(form.max_clients) : 50,
          trial_ends_at: form.trial_ends_at || null,
        }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error || 'Failed to save organization')
      onSaved(body)
    } catch (err) { setError(err.message) } finally { setSaving(false) }
  }

  return (
    <ModalShell title={`Edit ${org.name}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Organization Name *</label>
          <input
            type="text" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} required
            className="w-full min-h-11 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Slug *</label>
          <input
            type="text" value={form.slug} onChange={e => setForm(f => ({ ...f, slug: slugify(e.target.value) }))} required
            className="w-full min-h-11 border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-[#E8670A]"
          />
          <p className="text-[11px] text-gray-400 mt-1 break-all">app.lwcvip.com/{form.slug || '…'}</p>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Subscription Tier</label>
            <select
              value={form.subscription_tier}
              onChange={e => setForm(f => ({ ...f, subscription_tier: e.target.value }))}
              className="w-full min-h-11 border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#E8670A]"
            >
              {TIERS.map(t => <option key={t} value={t}>{tierLabel(t)}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Subscription Status</label>
            <select
              value={form.subscription_status}
              onChange={e => setForm(f => ({ ...f, subscription_status: e.target.value }))}
              className="w-full min-h-11 border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#E8670A]"
            >
              {STATUSES.map(s => <option key={s} value={s}>{statusLabel(s)}</option>)}
            </select>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Max Clients</label>
            <input
              type="number" min="1" value={form.max_clients}
              onChange={e => setForm(f => ({ ...f, max_clients: e.target.value }))}
              className="w-full min-h-11 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Trial Ends At</label>
            <input
              type="date" value={form.trial_ends_at}
              onChange={e => setForm(f => ({ ...f, trial_ends_at: e.target.value }))}
              className="w-full min-h-11 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]"
            />
          </div>
        </div>
        {error && <p className="text-xs text-red-500">{error}</p>}
        <div className="flex gap-2 pt-1">
          <button type="submit" disabled={saving}
            className="min-h-11 flex-1 bg-[#E8670A] text-white px-5 py-2 rounded-lg text-sm font-semibold hover:bg-[#c45e09] disabled:opacity-60 transition-colors">
            {saving ? 'Saving…' : 'Save Changes'}
          </button>
          <button type="button" onClick={onClose}
            className="min-h-11 px-4 text-sm text-gray-500 hover:text-gray-700">Cancel</button>
        </div>
      </form>
    </ModalShell>
  )
}

// ── Stats modal ───────────────────────────────────────────────────────────────

function StatsModal({ org, onClose, getToken }) {
  const [stats, setStats]   = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError]   = useState(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const token = await getToken()
        const res = await fetch(`${API_URL}/api/organizations/${org.id}/stats`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (!res.ok) throw new Error('Failed to load stats')
        const data = await res.json()
        if (!cancelled) setStats(data)
      } catch (err) { if (!cancelled) setError(err.message) } finally { if (!cancelled) setLoading(false) }
    }
    load()
    return () => { cancelled = true }
  }, [org.id, getToken])

  return (
    <ModalShell title={`${org.name} — Stats`} onClose={onClose}>
      {loading && <p className="text-sm text-gray-400 text-center py-6">Loading…</p>}
      {error && <p className="text-sm text-red-500 py-2">{error}</p>}
      {stats && (
        <div className="grid grid-cols-2 gap-3">
          <StatCard label="Total Clients" value={stats.client_count} />
          <StatCard label="Total Coaches" value={stats.coach_count} />
          <StatCard label="Active Habits" value={stats.active_habits_count} />
          <StatCard label="Messages (30d)" value={stats.messages_last_30_days} />
        </div>
      )}
    </ModalShell>
  )
}

// ── Invite Owner modal ───────────────────────────────────────────────────────

function InviteOwnerModal({ org, onClose, getToken }) {
  const [form, setForm]     = useState(EMPTY_INVITE)
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState(null)
  const [result, setResult] = useState(null)

  async function submit(e) {
    e.preventDefault()
    if (!form.first_name.trim()) { setError('First name is required.'); return }
    if (!form.email.trim())      { setError('Email is required.'); return }
    setSaving(true); setError(null)
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/organizations/${org.id}/invite-owner`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(form),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error || 'Failed to send invite')
      setResult(body)
    } catch (err) { setError(err.message) } finally { setSaving(false) }
  }

  return (
    <ModalShell title={`Invite Owner — ${org.name}`} onClose={onClose}>
      {result ? (
        <div className="space-y-3">
          <p className="text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
            Invite created for {result.first_name} ({result.email}).
            {result.email_sent ? ' Email sent.' : ` Email not sent (${result.email_note}) — share the link below.`}
          </p>
          <div className="border border-gray-200 rounded-lg px-3 py-2 bg-gray-50 text-xs font-mono break-all">
            {result.invite_url}
          </div>
          <button onClick={onClose}
            className="min-h-11 w-full bg-[#E8670A] text-white rounded-lg text-sm font-semibold hover:bg-[#c45e09] transition-colors">
            Done
          </button>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <p className="text-xs text-gray-500">
            Sends an admin invite for this org. Once accepted, the invitee becomes the org's admin account.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">First Name *</label>
              <input type="text" value={form.first_name} onChange={e => setForm(f => ({ ...f, first_name: e.target.value }))} required autoFocus
                className="w-full min-h-11 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Last Name</label>
              <input type="text" value={form.last_name} onChange={e => setForm(f => ({ ...f, last_name: e.target.value }))}
                className="w-full min-h-11 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]" />
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Email *</label>
            <input type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} required
              className="w-full min-h-11 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]" />
          </div>
          {error && <p className="text-xs text-red-500">{error}</p>}
          <div className="flex gap-2 pt-1">
            <button type="submit" disabled={saving}
              className="min-h-11 flex-1 bg-[#E8670A] text-white px-5 py-2 rounded-lg text-sm font-semibold hover:bg-[#c45e09] disabled:opacity-60 transition-colors">
              {saving ? 'Sending…' : 'Send Invite'}
            </button>
            <button type="button" onClick={onClose}
              className="min-h-11 px-4 text-sm text-gray-500 hover:text-gray-700">Cancel</button>
          </div>
        </form>
      )}
    </ModalShell>
  )
}

// ── Row actions (shared desktop/mobile) ─────────────────────────────────────

function RowActions({ org, busy, onActivate, onDeactivate, onEdit, onStats, onInvite }) {
  const isLwc = org.id === 1
  return (
    <div className="flex flex-wrap items-center gap-2">
      {org.is_active ? (
        <button
          onClick={() => onDeactivate(org)}
          disabled={busy || isLwc}
          title={isLwc ? 'Life Warrior Coaching cannot be deactivated' : undefined}
          className="min-h-11 px-3 rounded-lg border border-gray-200 text-xs font-semibold text-gray-600 hover:bg-gray-50 disabled:opacity-40 transition-colors"
        >
          Deactivate
        </button>
      ) : (
        <button
          onClick={() => onActivate(org)}
          disabled={busy}
          className="min-h-11 px-3 rounded-lg border border-emerald-200 text-xs font-semibold text-emerald-700 hover:bg-emerald-50 disabled:opacity-40 transition-colors"
        >
          Activate
        </button>
      )}
      <button
        onClick={() => onStats(org)}
        className="min-h-11 px-3 rounded-lg border border-gray-200 text-xs font-semibold text-gray-600 hover:bg-gray-50 transition-colors"
      >
        View Stats
      </button>
      <button
        onClick={() => onEdit(org)}
        className="min-h-11 px-3 rounded-lg border border-orange-200 text-xs font-semibold text-[#E8670A] hover:bg-orange-50 transition-colors"
      >
        Edit
      </button>
      <button
        onClick={() => onInvite(org)}
        className="min-h-11 px-3 rounded-lg border border-blue-200 text-xs font-semibold text-blue-700 hover:bg-blue-50 transition-colors"
      >
        Invite Owner
      </button>
    </div>
  )
}

// ── Main page ────────────────────────────────────────────────────────────────

export default function Organizations() {
  const { getToken } = useAuth()

  const [orgs, setOrgs]       = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState(null)
  const [busyId, setBusyId]   = useState(null)
  const [toast, setToast]     = useState(null)

  const [showCreate, setShowCreate] = useState(false)
  const [editOrg, setEditOrg]       = useState(null)
  const [statsOrg, setStatsOrg]     = useState(null)
  const [inviteOrg, setInviteOrg]   = useState(null)

  const loadOrgs = useCallback(async () => {
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/organizations`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error(`Server error ${res.status}`)
      setOrgs(await res.json())
    } catch (err) { setError(err.message) } finally { setLoading(false) }
  }, [getToken])

  useEffect(() => { loadOrgs() }, [loadOrgs])

  function flashToast(msg) {
    setToast(msg)
    setTimeout(() => setToast(null), 2500)
  }

  async function handleActivate(org) {
    setBusyId(org.id)
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/organizations/${org.id}/activate`, {
        method: 'PATCH', headers: { Authorization: `Bearer ${token}` },
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error || 'Failed to activate')
      setOrgs(prev => prev.map(o => o.id === org.id ? { ...o, ...body } : o))
      flashToast(`${org.name} activated`)
    } catch (err) { alert(err.message) } finally { setBusyId(null) }
  }

  async function handleDeactivate(org) {
    setBusyId(org.id)
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/organizations/${org.id}/deactivate`, {
        method: 'PATCH', headers: { Authorization: `Bearer ${token}` },
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error || 'Failed to deactivate')
      setOrgs(prev => prev.map(o => o.id === org.id ? { ...o, ...body } : o))
      flashToast(`${org.name} deactivated`)
    } catch (err) { alert(err.message) } finally { setBusyId(null) }
  }

  function handleCreated(newOrg) {
    setOrgs(prev => [{ ...newOrg, client_count: 0, owner_first_name: null, owner_last_name: null, owner_email: null }, ...prev])
    setShowCreate(false)
    flashToast(`${newOrg.name} created`)
  }

  function handleSaved(updated) {
    setOrgs(prev => prev.map(o => o.id === updated.id ? { ...o, ...updated } : o))
    setEditOrg(null)
    flashToast(`${updated.name} saved`)
  }

  const totalOrgs   = orgs.length
  const activeOrgs  = orgs.filter(o => o.is_active).length
  const totalClients = orgs.reduce((sum, o) => sum + (Number(o.client_count) || 0), 0)

  const actionProps = {
    onActivate: handleActivate,
    onDeactivate: handleDeactivate,
    onEdit: setEditOrg,
    onStats: setStatsOrg,
    onInvite: setInviteOrg,
  }

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3 mb-6">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Organizations</h1>
          <p className="text-sm text-gray-500 mt-0.5">SaaS tenant management</p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="min-h-11 bg-[#E8670A] text-white px-4 rounded-lg text-sm font-semibold hover:bg-[#c45e09] transition-colors"
        >
          + New Organization
        </button>
      </div>

      {toast && (
        <div className="mb-4 text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
          {toast}
        </div>
      )}

      {/* Stats bar */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6">
        <StatCard label="Total Orgs" value={totalOrgs} />
        <StatCard label="Active Orgs" value={activeOrgs} />
        <StatCard label="Total Clients Across All Orgs" value={totalClients} />
      </div>

      {loading && <p className="text-sm text-gray-400 text-center py-8">Loading organizations…</p>}
      {error && <p className="text-sm text-red-500 py-4">{error}</p>}

      {!loading && !error && (
        <>
          {/* Desktop table */}
          <div className="hidden lg:block bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-200 text-xs text-gray-500 uppercase tracking-wider">
                  <tr>
                    <th className="text-left px-3 py-2 font-semibold">Name</th>
                    <th className="text-left px-3 py-2 font-semibold">Slug</th>
                    <th className="text-left px-3 py-2 font-semibold">Tier</th>
                    <th className="text-left px-3 py-2 font-semibold">Status</th>
                    <th className="text-left px-3 py-2 font-semibold">Clients</th>
                    <th className="text-left px-3 py-2 font-semibold">Owner</th>
                    <th className="text-left px-3 py-2 font-semibold">Created</th>
                    <th className="text-left px-3 py-2 font-semibold">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {orgs.map(org => (
                    <tr key={org.id} className={!org.is_active ? 'opacity-60' : ''}>
                      <td className="px-3 py-2">
                        <p className="font-semibold text-gray-900">{org.name}</p>
                        {org.id === 1 && <p className="text-[10px] text-gray-400">Platform default</p>}
                      </td>
                      <td className="px-3 py-2 text-xs text-gray-500 font-mono">{org.slug}</td>
                      <td className="px-3 py-2 text-xs text-gray-600">{tierLabel(org.subscription_tier)}</td>
                      <td className="px-3 py-2"><StatusBadge status={org.subscription_status} /></td>
                      <td className="px-3 py-2 text-xs text-gray-600">{org.client_count} / {org.max_clients}</td>
                      <td className="px-3 py-2 text-xs text-gray-600">{ownerName(org)}</td>
                      <td className="px-3 py-2 text-xs text-gray-500">{fmtDate(org.created_at)}</td>
                      <td className="px-3 py-2">
                        <RowActions org={org} busy={busyId === org.id} {...actionProps} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!orgs.length && <p className="text-sm text-gray-400 text-center py-8">No organizations yet.</p>}
          </div>

          {/* Mobile cards */}
          <div className="lg:hidden space-y-3">
            {orgs.map(org => (
              <div key={org.id} className={`bg-white rounded-xl border border-gray-200 p-4 ${!org.is_active ? 'opacity-60' : ''}`}>
                <div className="flex items-start justify-between gap-3 mb-2">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-gray-900 truncate">{org.name}</p>
                    <p className="text-xs text-gray-400 font-mono truncate">{org.slug}</p>
                  </div>
                  <StatusBadge status={org.subscription_status} />
                </div>
                <div className="flex items-center gap-3 text-xs text-gray-500 mb-3">
                  <span>{tierLabel(org.subscription_tier)}</span>
                  <span>·</span>
                  <span>{org.client_count} / {org.max_clients} clients</span>
                </div>
                <RowActions org={org} busy={busyId === org.id} {...actionProps} />
              </div>
            ))}
            {!orgs.length && <p className="text-sm text-gray-400 text-center py-8">No organizations yet.</p>}
          </div>
        </>
      )}

      {showCreate && (
        <CreateOrgModal onClose={() => setShowCreate(false)} onCreated={handleCreated} getToken={getToken} />
      )}
      {editOrg && (
        <EditOrgModal org={editOrg} onClose={() => setEditOrg(null)} onSaved={handleSaved} getToken={getToken} />
      )}
      {statsOrg && (
        <StatsModal org={statsOrg} onClose={() => setStatsOrg(null)} getToken={getToken} />
      )}
      {inviteOrg && (
        <InviteOwnerModal org={inviteOrg} onClose={() => setInviteOrg(null)} getToken={getToken} />
      )}
    </div>
  )
}
