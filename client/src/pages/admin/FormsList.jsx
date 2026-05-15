import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '@clerk/clerk-react'
import { useNavigate } from 'react-router-dom'
import { API_URL } from '../../config.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

const STATUS_STYLES = {
  draft:     'bg-gray-100 text-gray-600 border-gray-200',
  published: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  archived:  'bg-amber-50 text-amber-700 border-amber-200',
}

function StatusBadge({ status }) {
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${STATUS_STYLES[status] ?? STATUS_STYLES.draft}`}>
      {status}
    </span>
  )
}

function fmtDate(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

// ── Create Form modal ─────────────────────────────────────────────────────────

function CreateModal({ onClose, onCreate }) {
  const [title, setTitle]   = useState('')
  const [desc,  setDesc]    = useState('')
  const [saving, setSaving] = useState(false)
  const [err,    setErr]    = useState(null)

  async function submit(e) {
    e.preventDefault()
    if (!title.trim()) { setErr('Title is required.'); return }
    setSaving(true); setErr(null)
    try { await onCreate(title.trim(), desc.trim() || null) }
    catch (e) { setErr(e.message); setSaving(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6">
        <h2 className="text-lg font-bold text-gray-900 mb-4">New Form</h2>
        {err && <p className="mb-3 text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{err}</p>}
        <form onSubmit={submit} className="space-y-4">
          <div>
            <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider mb-1">Form Title *</label>
            <input
              autoFocus
              type="text"
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="e.g. Weekly Check-In"
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]"
            />
          </div>
          <div>
            <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider mb-1">Description <span className="text-gray-300 font-normal normal-case">(optional)</span></label>
            <textarea
              value={desc}
              onChange={e => setDesc(e.target.value)}
              placeholder="What is this form for?"
              rows={2}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A] resize-none"
            />
          </div>
          <div className="flex gap-3 pt-1">
            <button type="button" onClick={onClose}
              className="flex-1 border border-gray-200 text-gray-600 font-semibold py-2.5 rounded-xl text-sm hover:bg-gray-50">
              Cancel
            </button>
            <button type="submit" disabled={saving}
              className="flex-1 bg-[#E8670A] text-white font-bold py-2.5 rounded-xl text-sm hover:bg-[#c45e09] disabled:opacity-60">
              {saving ? 'Creating…' : 'Create Form'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ── Main Component ────────────────────────────────────────────────────────────

export default function FormsList() {
  const { getToken } = useAuth()
  const navigate = useNavigate()

  const [forms,   setForms]   = useState([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState(null)
  const [creating, setCreating] = useState(false)
  const [filter,  setFilter]  = useState('all')   // all | draft | published | archived
  const [actionLoading, setActionLoading] = useState(null)

  const load = useCallback(async () => {
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/forms`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error(`Server ${res.status}`)
      setForms(await res.json())
    } catch (e) { setError(e.message) }
    finally { setLoading(false) }
  }, [getToken])

  useEffect(() => { load() }, [load])

  async function handleCreate(title, description) {
    const token = await getToken()
    const res = await fetch(`${API_URL}/api/forms`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, description }),
    })
    if (!res.ok) {
      const d = await res.json().catch(() => ({}))
      throw new Error(d.error ?? 'Create failed')
    }
    const created = await res.json()
    setCreating(false)
    navigate(`/admin/forms/${created.id}/edit`)
  }

  async function handlePublish(e, id) {
    e.stopPropagation()
    setActionLoading(id + '_pub')
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/forms/${id}/publish`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        alert(d.error ?? 'Publish failed')
      } else { await load() }
    } finally { setActionLoading(null) }
  }

  async function handleArchive(e, id) {
    e.stopPropagation()
    if (!confirm('Archive this form? Clients can no longer submit new responses.')) return
    setActionLoading(id + '_arc')
    try {
      const token = await getToken()
      await fetch(`${API_URL}/api/forms/${id}/archive`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}` },
      })
      await load()
    } finally { setActionLoading(null) }
  }

  async function handleDuplicate(e, id) {
    e.stopPropagation()
    setActionLoading(id + '_dup')
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/forms/${id}/duplicate`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (res.ok) { await load() }
    } finally { setActionLoading(null) }
  }

  const displayed = filter === 'all'
    ? forms
    : forms.filter(f => f.status === filter)

  return (
    <div className="max-w-4xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Forms</h1>
          <p className="text-sm text-gray-500 mt-0.5">Create and manage client forms</p>
        </div>
        <button
          onClick={() => setCreating(true)}
          className="flex items-center gap-2 bg-[#E8670A] text-white font-bold px-4 py-2.5 rounded-xl text-sm hover:bg-[#c45e09] transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
          </svg>
          New Form
        </button>
      </div>

      {/* Filter tabs */}
      <div className="flex gap-1 mb-4 bg-gray-100 rounded-xl p-1 w-fit">
        {['all', 'draft', 'published', 'archived'].map(f => (
          <button key={f}
            onClick={() => setFilter(f)}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors capitalize ${
              filter === f ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {f}
          </button>
        ))}
      </div>

      {/* List */}
      {loading ? (
        <p className="text-center text-gray-400 py-12 text-sm">Loading forms…</p>
      ) : error ? (
        <p className="text-center text-red-500 py-12 text-sm">{error}</p>
      ) : displayed.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-2xl p-12 text-center">
          <p className="text-3xl mb-3">📋</p>
          <p className="text-sm font-medium text-gray-700 mb-1">No forms yet</p>
          <p className="text-xs text-gray-400 mb-5">Create your first form to get started.</p>
          <button onClick={() => setCreating(true)}
            className="bg-[#E8670A] text-white font-bold px-5 py-2.5 rounded-xl text-sm hover:bg-[#c45e09]">
            Create Form
          </button>
        </div>
      ) : (
        <>
          {/* Desktop table */}
          <div className="hidden md:block bg-white border border-gray-200 rounded-2xl overflow-hidden">
            <table className="w-full">
              <thead className="bg-gray-50 border-b border-gray-200 text-xs text-gray-500 uppercase tracking-wider">
                <tr>
                  <th className="text-left px-5 py-3 font-semibold">Form</th>
                  <th className="text-left px-4 py-3 font-semibold">Status</th>
                  <th className="text-center px-4 py-3 font-semibold">Submissions</th>
                  <th className="text-left px-4 py-3 font-semibold">Updated</th>
                  <th className="text-right px-4 py-3 font-semibold">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {displayed.map(f => (
                  <tr key={f.id}
                    onClick={() => navigate(`/admin/forms/${f.id}/edit`)}
                    className="hover:bg-orange-50/40 cursor-pointer transition-colors"
                  >
                    <td className="px-5 py-3.5">
                      <p className="font-semibold text-gray-900 text-sm">{f.title}</p>
                      {f.description && <p className="text-xs text-gray-400 truncate max-w-[280px] mt-0.5">{f.description}</p>}
                    </td>
                    <td className="px-4 py-3.5"><StatusBadge status={f.status} /></td>
                    <td className="px-4 py-3.5 text-center text-sm font-semibold text-gray-700">{f.submission_count ?? 0}</td>
                    <td className="px-4 py-3.5 text-xs text-gray-500">{fmtDate(f.updated_at)}</td>
                    <td className="px-4 py-3.5 text-right whitespace-nowrap" onClick={e => e.stopPropagation()}>
                      {f.status === 'draft' && (
                        <button
                          onClick={e => handlePublish(e, f.id)}
                          disabled={actionLoading === f.id + '_pub'}
                          className="text-xs text-emerald-600 hover:text-emerald-700 font-semibold mr-3 disabled:opacity-50"
                        >
                          {actionLoading === f.id + '_pub' ? '…' : 'Publish'}
                        </button>
                      )}
                      {f.status === 'published' && (
                        <button
                          onClick={() => navigate(`/forms/${f.id}/fill`)}
                          className="text-xs text-blue-600 hover:text-blue-700 font-semibold mr-3"
                        >
                          Preview
                        </button>
                      )}
                      <button
                        onClick={e => handleDuplicate(e, f.id)}
                        disabled={actionLoading === f.id + '_dup'}
                        className="text-xs text-gray-500 hover:text-gray-700 font-medium mr-3 disabled:opacity-50"
                      >
                        Duplicate
                      </button>
                      {f.status !== 'archived' && (
                        <button
                          onClick={e => handleArchive(e, f.id)}
                          disabled={actionLoading === f.id + '_arc'}
                          className="text-xs text-red-400 hover:text-red-600 font-medium disabled:opacity-50"
                        >
                          Archive
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile cards */}
          <div className="md:hidden space-y-3">
            {displayed.map(f => (
              <div key={f.id}
                onClick={() => navigate(`/admin/forms/${f.id}/edit`)}
                className="bg-white border border-gray-200 rounded-xl p-4 cursor-pointer hover:border-[#E8670A] transition-colors"
              >
                <div className="flex items-start justify-between gap-2 mb-2">
                  <p className="font-semibold text-gray-900 text-sm">{f.title}</p>
                  <StatusBadge status={f.status} />
                </div>
                {f.description && <p className="text-xs text-gray-400 mb-2">{f.description}</p>}
                <div className="flex items-center justify-between text-xs text-gray-400">
                  <span>{f.submission_count ?? 0} submissions</span>
                  <span>{fmtDate(f.updated_at)}</span>
                </div>
                <div className="flex gap-3 mt-3 pt-2 border-t border-gray-100" onClick={e => e.stopPropagation()}>
                  {f.status === 'draft' && (
                    <button onClick={e => handlePublish(e, f.id)}
                      className="text-xs text-emerald-600 font-semibold">Publish</button>
                  )}
                  {f.status === 'published' && (
                    <button onClick={() => navigate(`/forms/${f.id}/fill`)}
                      className="text-xs text-blue-600 font-semibold">Preview</button>
                  )}
                  <button onClick={e => handleDuplicate(e, f.id)}
                    className="text-xs text-gray-500 font-medium">Duplicate</button>
                  {f.status !== 'archived' && (
                    <button onClick={e => handleArchive(e, f.id)}
                      className="text-xs text-red-400 font-medium ml-auto">Archive</button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {creating && (
        <CreateModal onClose={() => setCreating(false)} onCreate={handleCreate} />
      )}
    </div>
  )
}
