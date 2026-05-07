import { useState, useEffect } from 'react'
import { useAuth } from '@clerk/clerk-react'
import { useNavigate } from 'react-router-dom'

function daysSince(isoString) {
  if (!isoString) return null
  return Math.floor((Date.now() - new Date(isoString)) / (1000 * 60 * 60 * 24))
}

function MacroForm({ client, getToken, onSaved }) {
  const [form, setForm] = useState({
    goal_calories: client.goal_calories ?? '',
    goal_protein:  client.goal_protein  ?? '',
    goal_carbs:    client.goal_carbs    ?? '',
    goal_fat:      client.goal_fat      ?? '',
  })
  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState(null)

  function set(field, value) {
    setForm(f => ({ ...f, [field]: value }))
  }

  async function save() {
    setSaving(true)
    setError(null)
    try {
      const token = await getToken()
      const res = await fetch(`/api/admin/users/${client.id}/macros`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          goal_calories: form.goal_calories !== '' ? Number(form.goal_calories) : null,
          goal_protein:  form.goal_protein  !== '' ? Number(form.goal_protein)  : null,
          goal_carbs:    form.goal_carbs    !== '' ? Number(form.goal_carbs)    : null,
          goal_fat:      form.goal_fat      !== '' ? Number(form.goal_fat)      : null,
        }),
      })
      if (!res.ok) throw new Error('Save failed')
      const updated = await res.json()
      onSaved(updated)
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="mt-3 pt-3 border-t border-gray-100">
      <div className="grid grid-cols-4 gap-2 mb-2">
        {[
          { field: 'goal_calories', label: 'Cal',     placeholder: '2000' },
          { field: 'goal_protein',  label: 'Protein', placeholder: '150'  },
          { field: 'goal_carbs',    label: 'Carbs',   placeholder: '150'  },
          { field: 'goal_fat',      label: 'Fat',     placeholder: '65'   },
        ].map(({ field, label, placeholder }) => (
          <div key={field}>
            <label className="block text-xs text-gray-500 mb-1">{label}</label>
            <input
              type="number"
              value={form[field]}
              onChange={e => set(field, e.target.value)}
              placeholder={placeholder}
              className="w-full border border-gray-300 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]"
            />
          </div>
        ))}
      </div>
      {error && <p className="text-xs text-red-500 mb-2">{error}</p>}
      <div className="flex gap-2">
        <button
          onClick={save}
          disabled={saving}
          className="bg-[#E8670A] text-white px-4 py-1.5 rounded-lg text-xs font-semibold hover:bg-[#c45e09] disabled:opacity-40 transition-colors"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button
          onClick={() => onSaved(null)}
          className="text-xs text-gray-500 hover:text-gray-700 transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

function ClientRow({ client, getToken, onUpdate }) {
  const [editing, setEditing] = useState(false)
  const inactive = daysSince(client.last_meal_at)

  function handleSaved(updated) {
    if (updated) onUpdate(updated)
    setEditing(false)
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-gray-900">
            {client.first_name ?? 'Unknown'}
          </p>
          <p className="text-xs text-gray-400 mt-0.5">
            {inactive === null
              ? 'No meals logged'
              : inactive === 0
              ? 'Logged today'
              : `Last log: ${inactive}d ago`}
          </p>
        </div>

        <div className="flex items-center gap-4 text-xs text-gray-500 shrink-0">
          <span title="Calories">{client.goal_calories ? `${client.goal_calories} cal` : '—'}</span>
          <span title="Protein">{client.goal_protein  ? `${client.goal_protein}g P`  : '—'}</span>
          <span title="Carbs">{client.goal_carbs    ? `${client.goal_carbs}g C`    : '—'}</span>
          <span title="Fat">{client.goal_fat      ? `${client.goal_fat}g F`      : '—'}</span>
          <button
            onClick={() => setEditing(e => !e)}
            className="text-[#E8670A] hover:text-[#c45e09] font-medium transition-colors"
          >
            {editing ? 'Close' : 'Edit'}
          </button>
        </div>
      </div>

      {editing && (
        <MacroForm client={client} getToken={getToken} onSaved={handleSaved} />
      )}
    </div>
  )
}

export default function Admin() {
  const { getToken } = useAuth()
  const navigate     = useNavigate()
  const [clients, setClients] = useState([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState(null)

  useEffect(() => {
    async function load() {
      try {
        const token = await getToken()
        const res = await fetch('/api/admin/users', { headers: { Authorization: `Bearer ${token}` } })
        if (res.status === 403) {
          navigate('/dashboard', { replace: true })
          return
        }
        if (!res.ok) throw new Error(`Server error ${res.status}`)
        setClients(await res.json())
      } catch (err) {
        setError(err.message)
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [getToken, navigate])

  function handleUpdate(updated) {
    setClients(prev => prev.map(c => c.id === updated.id ? { ...c, ...updated } : c))
  }

  return (
    <div className="max-w-3xl">
      <h1 className="text-2xl font-bold text-gray-900 mb-1">Admin</h1>
      <p className="text-sm text-gray-500 mb-6">Manage client macro targets</p>

      {loading && <p className="text-sm text-gray-400 py-8 text-center">Loading…</p>}
      {error   && <p className="text-sm text-red-500 py-4">{error}</p>}

      {!loading && !error && clients.length === 0 && (
        <p className="text-sm text-gray-400 py-8 text-center">No onboarded clients yet.</p>
      )}

      <div className="space-y-3">
        {clients.map(client => (
          <ClientRow
            key={client.id}
            client={client}
            getToken={getToken}
            onUpdate={handleUpdate}
          />
        ))}
      </div>
    </div>
  )
}
