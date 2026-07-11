import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '@clerk/clerk-react'
import { API_URL } from '../../config.js'

// Admin-only management list for katie_corrections (server/db.js). Corrections
// themselves are created by flagging a real Katie answer in a client's Katie
// Chat tab (ClientProfile.jsx's KatieHistoryPanel) — this page is for reviewing
// what exists, toggling one off, or removing it. No create-from-scratch form
// here on purpose: a correction should come from an actual bad answer, not a
// guess.

function relDate(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

export default function KatieCorrections() {
  const { getToken } = useAuth()
  const [corrections, setCorrections] = useState(null)
  const [error, setError] = useState(null)
  const [busyId, setBusyId] = useState(null) // id currently being toggled/deleted

  const load = useCallback(async () => {
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/coach-admin/katie-corrections`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Could not load corrections')
      setCorrections(await res.json())
    } catch (err) {
      setError(err.message)
    }
  }, [getToken])

  useEffect(() => { load() }, [load])

  async function toggleActive(c) {
    setBusyId(c.id)
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/coach-admin/katie-corrections/${c.id}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: !c.active }),
      })
      if (res.ok) {
        const updated = await res.json()
        setCorrections(prev => prev.map(x => x.id === c.id ? updated : x))
      }
    } finally {
      setBusyId(null)
    }
  }

  async function remove(c) {
    if (!window.confirm('Delete this correction? This cannot be undone.')) return
    setBusyId(c.id)
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/coach-admin/katie-corrections/${c.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (res.ok) setCorrections(prev => prev.filter(x => x.id !== c.id))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="w-full max-w-3xl mx-auto pb-10">
      <div className="mb-5">
        <h1 className="text-2xl font-bold text-gray-900">Katie Corrections</h1>
        <p className="text-sm text-gray-500 mt-1">
          Admin-entered fixes for wrong or hedged Katie answers, pulled into her context when a client's
          message matches. Add a new one by flagging an answer from a client's Katie Chat tab.
        </p>
      </div>

      {error && (
        <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-4">{error}</p>
      )}

      {corrections === null && !error && (
        <p className="text-center text-sm text-gray-400 py-12">Loading…</p>
      )}

      {corrections?.length === 0 && (
        <div className="bg-white rounded-2xl border border-gray-200 p-8 text-center">
          <p className="text-sm text-gray-500">No corrections yet.</p>
          <p className="text-xs text-gray-400 mt-1">
            Flag a wrong Katie answer from a client's Katie Chat tab to add one.
          </p>
        </div>
      )}

      <div className="space-y-3">
        {corrections?.map(c => (
          <div
            key={c.id}
            className={`bg-white rounded-2xl border p-4 ${c.active ? 'border-gray-200' : 'border-gray-200 opacity-60'}`}
          >
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div className="flex flex-wrap gap-1.5 min-w-0">
                {c.trigger_keywords.map((kw, i) => (
                  <span key={i} className="text-[11px] font-semibold bg-orange-50 text-[#c45e09] border border-orange-100 rounded-full px-2 py-0.5">
                    {kw}
                  </span>
                ))}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={() => toggleActive(c)}
                  disabled={busyId === c.id}
                  className={`text-[11px] font-semibold px-2.5 py-1 rounded-full border transition-colors disabled:opacity-50 ${
                    c.active
                      ? 'bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100'
                      : 'bg-gray-100 text-gray-500 border-gray-200 hover:bg-gray-200'
                  }`}
                >
                  {c.active ? 'Active' : 'Inactive'}
                </button>
                <button
                  onClick={() => remove(c)}
                  disabled={busyId === c.id}
                  className="text-[11px] font-semibold text-red-400 hover:text-red-600 disabled:opacity-50 px-1"
                >
                  Delete
                </button>
              </div>
            </div>

            <p className="text-sm text-gray-800 whitespace-pre-wrap mt-2.5">{c.correct_answer}</p>

            <p className="text-[11px] text-gray-400 mt-2.5">
              Added {relDate(c.created_at)}{c.created_by_name ? ` by ${c.created_by_name}` : ''}
            </p>
          </div>
        ))}
      </div>
    </div>
  )
}
