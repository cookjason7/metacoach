import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '@clerk/clerk-react'
import { useNavigate } from 'react-router-dom'
import { API_URL } from '../../config.js'

const STATUS_STYLES = {
  'Consistent':            'bg-emerald-50 text-emerald-700 border-emerald-200',
  'Building Momentum':     'bg-blue-50 text-blue-700 border-blue-200',
  'Rebuilding Momentum':   'bg-amber-50 text-amber-700 border-amber-200',
  'Needs Attention':       'bg-orange-50 text-[#E8670A] border-orange-200',
  'New Client':            'bg-gray-50 text-gray-600 border-gray-200',
}

function StatusBadge({ status }) {
  const style = STATUS_STYLES[status] ?? STATUS_STYLES['New Client']
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-bold whitespace-nowrap ${style}`}>
      {status}
    </span>
  )
}

function daysSince(iso) {
  if (!iso) return null
  return Math.floor((Date.now() - new Date(iso)) / 86400_000)
}

function adherenceColor(v) {
  const n = Number(v) || 0
  if (n >= 80) return 'text-emerald-600'
  if (n >= 50) return 'text-blue-600'
  if (n >= 30) return 'text-amber-600'
  return 'text-gray-400'
}

export default function ClientList() {
  const { getToken } = useAuth()
  const navigate     = useNavigate()
  const [clients, setClients] = useState([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState(null)
  const [search,  setSearch]  = useState('')
  const [filter,  setFilter]  = useState('all')   // 'all' | 'vip' | 'ai'
  const [statusFilter, setStatusFilter] = useState('all')
  const [lifecycleFilter, setLifecycleFilter] = useState('active')  // 'active' | 'archived' | 'all'

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/coach-admin/clients?status=${lifecycleFilter}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (res.status === 403) { navigate('/dashboard', { replace: true }); return }
      if (!res.ok) throw new Error(`Server ${res.status}`)
      setClients(await res.json())
    } catch (err) { setError(err.message) } finally { setLoading(false) }
  }, [getToken, navigate, lifecycleFilter])

  useEffect(() => { load() }, [load])

  async function archiveClient(e, id) {
    e.stopPropagation()
    if (!confirm('Archive this client? They will be hidden from the active list but all their data is preserved.')) return
    const token = await getToken()
    const res = await fetch(`${API_URL}/api/coach-admin/clients/${id}/archive`, {
      method: 'PATCH', headers: { Authorization: `Bearer ${token}` },
    })
    if (res.ok) load()
  }

  async function reactivateClient(e, id) {
    e.stopPropagation()
    const token = await getToken()
    const res = await fetch(`${API_URL}/api/coach-admin/clients/${id}/reactivate`, {
      method: 'PATCH', headers: { Authorization: `Bearer ${token}` },
    })
    if (res.ok) load()
  }

  async function deleteClient(e, id, name) {
    e.stopPropagation()
    if (!confirm(`Soft-delete ${name}? Their data is preserved and the row is hidden. Type DELETE in the next prompt to confirm.`)) return
    const confirmText = prompt('Type DELETE to confirm:')
    if (confirmText !== 'DELETE') return
    const token = await getToken()
    const res = await fetch(`${API_URL}/api/coach-admin/clients/${id}`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
    })
    if (res.ok) load()
    else {
      const err = await res.json().catch(() => ({}))
      alert(err.error ?? 'Could not delete')
    }
  }

  const filtered = clients.filter(c => {
    if (filter === 'vip' && c.coaching_type !== 'vip') return false
    if (filter === 'ai'  && c.coaching_type !== 'ai')  return false
    if (statusFilter !== 'all' && c.status_tag !== statusFilter) return false
    if (search) {
      const q = search.toLowerCase()
      if (!`${c.first_name ?? ''} ${c.email ?? ''}`.toLowerCase().includes(q)) return false
    }
    return true
  })

  return (
    <div className="max-w-7xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 mb-1">Coaching Command Center</h1>
        <p className="text-sm text-gray-500">Your clients — momentum, habits, and engagement at a glance.</p>
      </div>

      {/* ── Filters ── */}
      <div className="bg-white rounded-xl border border-gray-200 p-4 mb-4">
        <div className="flex flex-col sm:flex-row gap-3 items-stretch sm:items-center">
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search by name or email…"
            className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]"
          />
          <select
            value={filter}
            onChange={e => setFilter(e.target.value)}
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#E8670A]"
          >
            <option value="all">All clients</option>
            <option value="vip">VIP coaching</option>
            <option value="ai">AI coaching</option>
          </select>
          <select
            value={statusFilter}
            onChange={e => setStatusFilter(e.target.value)}
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#E8670A]"
          >
            <option value="all">All statuses</option>
            <option value="Consistent">Consistent</option>
            <option value="Building Momentum">Building Momentum</option>
            <option value="Rebuilding Momentum">Rebuilding Momentum</option>
            <option value="Needs Attention">Needs Attention</option>
            <option value="New Client">New Client</option>
          </select>
          <select
            value={lifecycleFilter}
            onChange={e => setLifecycleFilter(e.target.value)}
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#E8670A]"
          >
            <option value="active">Active clients</option>
            <option value="archived">Archived clients</option>
            <option value="all">All (active + archived)</option>
          </select>
        </div>
        <p className="text-xs text-gray-400 mt-2">{filtered.length} of {clients.length} clients</p>
      </div>

      {loading && <p className="text-center text-gray-400 py-12 text-sm">Loading clients…</p>}
      {error   && <p className="text-center text-red-500 py-8 text-sm">{error}</p>}
      {!loading && !error && filtered.length === 0 && (
        <div className="bg-white border border-gray-200 rounded-xl p-12 text-center">
          <p className="text-2xl mb-2">👥</p>
          <p className="text-sm text-gray-500">No clients match your filters yet.</p>
        </div>
      )}

      {/* ── Desktop table ── */}
      <div className="hidden lg:block bg-white rounded-xl border border-gray-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-200 text-xs text-gray-500 uppercase tracking-wider">
            <tr>
              <th className="text-left px-4 py-3 font-semibold">Client</th>
              <th className="text-left px-4 py-3 font-semibold">Type</th>
              <th className="text-left px-4 py-3 font-semibold">Coach</th>
              <th className="text-center px-3 py-3 font-semibold">Onb.</th>
              <th className="text-center px-3 py-3 font-semibold">Assess.</th>
              <th className="text-left px-3 py-3 font-semibold">Last Activity</th>
              <th className="text-center px-3 py-3 font-semibold">7d</th>
              <th className="text-center px-3 py-3 font-semibold">30d</th>
              <th className="text-left px-3 py-3 font-semibold">Status</th>
              <th className="text-right px-3 py-3 font-semibold">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {filtered.map(c => {
              const inactive = daysSince(c.last_meal_at ?? c.last_login_at)
              return (
                <tr key={c.id}
                  onClick={() => navigate(`/admin/clients/${c.id}`)}
                  className="hover:bg-orange-50/50 cursor-pointer transition-colors"
                >
                  <td className="px-4 py-3">
                    <p className="font-semibold text-gray-900">{c.first_name ?? 'Unknown'}</p>
                    <p className="text-xs text-gray-400 truncate max-w-[180px]">{c.email}</p>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold border ${
                      c.coaching_type === 'ai'
                        ? 'bg-purple-50 text-purple-700 border-purple-200'
                        : 'bg-orange-50 text-[#E8670A] border-orange-200'
                    }`}>
                      {c.coaching_type === 'ai' ? 'AI' : 'VIP'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-600">{c.assigned_coach_name ?? '—'}</td>
                  <td className="px-3 py-3 text-center">{c.onboarding_complete ? '✓' : '—'}</td>
                  <td className="px-3 py-3 text-center">{c.assessment_complete ? '✓' : '—'}</td>
                  <td className="px-3 py-3 text-xs text-gray-500">
                    {inactive === null ? '—' : inactive === 0 ? 'Today' : `${inactive}d ago`}
                  </td>
                  <td className={`px-3 py-3 text-center font-bold ${adherenceColor(c.adherence_7d)}`}>
                    {Math.round(Number(c.adherence_7d) || 0)}%
                  </td>
                  <td className={`px-3 py-3 text-center font-bold ${adherenceColor(c.adherence_30d)}`}>
                    {Math.round(Number(c.adherence_30d) || 0)}%
                  </td>
                  <td className="px-3 py-3">
                    <div className="flex flex-col gap-1">
                      <StatusBadge status={c.status_tag} />
                      {c.client_status === 'archived' && (
                        <span className="inline-flex items-center rounded-full border border-gray-300 bg-gray-100 px-2 py-0.5 text-[9px] font-bold text-gray-600 w-fit">
                          📦 Archived
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-3 text-right whitespace-nowrap">
                    {c.client_status === 'archived' ? (
                      <button
                        onClick={e => reactivateClient(e, c.id)}
                        className="text-xs text-emerald-600 hover:text-emerald-700 font-semibold mr-2"
                      >
                        Reactivate
                      </button>
                    ) : (
                      <button
                        onClick={e => archiveClient(e, c.id)}
                        className="text-xs text-gray-500 hover:text-gray-700 font-medium mr-2"
                      >
                        Archive
                      </button>
                    )}
                    <button
                      onClick={e => deleteClient(e, c.id, c.first_name ?? 'this client')}
                      className="text-xs text-red-400 hover:text-red-600 font-medium"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* ── Mobile cards ── */}
      <div className="lg:hidden space-y-3">
        {filtered.map(c => {
          const inactive = daysSince(c.last_meal_at ?? c.last_login_at)
          return (
            <button
              key={c.id}
              onClick={() => navigate(`/admin/clients/${c.id}`)}
              className="w-full text-left bg-white border border-gray-200 rounded-xl p-4 hover:border-[#E8670A] active:scale-[0.99] transition-all"
            >
              <div className="flex items-start justify-between gap-2 mb-2">
                <div className="min-w-0">
                  <p className="font-semibold text-gray-900">{c.first_name ?? 'Unknown'}</p>
                  <p className="text-xs text-gray-400 truncate">{c.email}</p>
                </div>
                <StatusBadge status={c.status_tag} />
              </div>
              <div className="flex items-center gap-2 text-[10px] mb-2 flex-wrap">
                <span className={`rounded-full px-2 py-0.5 font-bold border ${
                  c.coaching_type === 'ai'
                    ? 'bg-purple-50 text-purple-700 border-purple-200'
                    : 'bg-orange-50 text-[#E8670A] border-orange-200'
                }`}>{c.coaching_type === 'ai' ? 'AI' : 'VIP'}</span>
                {c.assigned_coach_name && (
                  <span className="text-gray-500">Coach: {c.assigned_coach_name}</span>
                )}
                <span className="text-gray-400">
                  {inactive === null ? 'No activity' : inactive === 0 ? 'Active today' : `${inactive}d ago`}
                </span>
              </div>
              <div className="flex gap-4 text-xs">
                <div>
                  <span className="text-gray-400">7d </span>
                  <span className={`font-bold ${adherenceColor(c.adherence_7d)}`}>
                    {Math.round(Number(c.adherence_7d) || 0)}%
                  </span>
                </div>
                <div>
                  <span className="text-gray-400">30d </span>
                  <span className={`font-bold ${adherenceColor(c.adherence_30d)}`}>
                    {Math.round(Number(c.adherence_30d) || 0)}%
                  </span>
                </div>
                <div className="ml-auto flex gap-1.5">
                  <span className={c.onboarding_complete ? 'text-emerald-600' : 'text-gray-300'}>{c.onboarding_complete ? '✓' : '○'} Onb</span>
                  <span className={c.assessment_complete ? 'text-emerald-600' : 'text-gray-300'}>{c.assessment_complete ? '✓' : '○'} Assess</span>
                </div>
              </div>
              {/* Lifecycle badge + actions */}
              <div className="mt-3 pt-2 border-t border-gray-100 flex items-center justify-between gap-2">
                {c.client_status === 'archived' ? (
                  <span className="inline-flex items-center rounded-full border border-gray-300 bg-gray-100 px-2 py-0.5 text-[9px] font-bold text-gray-600">
                    📦 Archived
                  </span>
                ) : (
                  <span className="inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[9px] font-bold text-emerald-700">
                    ● Active
                  </span>
                )}
                <div className="flex gap-3">
                  {c.client_status === 'archived' ? (
                    <span onClick={e => reactivateClient(e, c.id)} className="text-[11px] text-emerald-600 hover:text-emerald-700 font-semibold cursor-pointer">
                      Reactivate
                    </span>
                  ) : (
                    <span onClick={e => archiveClient(e, c.id)} className="text-[11px] text-gray-500 hover:text-gray-700 font-medium cursor-pointer">
                      Archive
                    </span>
                  )}
                  <span onClick={e => deleteClient(e, c.id, c.first_name ?? 'this client')} className="text-[11px] text-red-400 hover:text-red-600 font-medium cursor-pointer">
                    Delete
                  </span>
                </div>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
