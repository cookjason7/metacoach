import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '@clerk/clerk-react'
import { useNavigate } from 'react-router-dom'
import { API_URL } from '../../config.js'

// ── Constants ─────────────────────────────────────────────────────────────────

const DAY_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

// ── Send / Schedule Modal ─────────────────────────────────────────────────────

function SendModal({ form, getToken, onClose, onScheduled }) {
  const [sendMode, setSendMode] = useState('now')      // 'now' | 'scheduled' | 'recurring'
  const [clients,  setClients]  = useState([])
  const [loading,  setLoading]  = useState(true)
  const [selected, setSelected] = useState(new Set())
  const [sending,  setSending]  = useState(false)
  const [result,   setResult]   = useState(null)
  const [err,      setErr]      = useState(null)

  // scheduled mode
  const [schedDate, setSchedDate] = useState('')
  const [schedTime, setSchedTime] = useState('09:00')

  // recurring mode
  const [recurDay,  setRecurDay]  = useState(1)
  const [recurTime, setRecurTime] = useState('09:00')

  useEffect(() => {
    async function load() {
      try {
        const token = await getToken()
        const res = await fetch(`${API_URL}/api/coach-admin/clients?status=active`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (res.ok) setClients(await res.json())
      } catch {}
      finally { setLoading(false) }
    }
    load()
  }, [getToken])

  function toggleClient(id) {
    setSelected(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }
  function selectAll()  { setSelected(new Set(clients.map(c => c.id))) }
  function selectNone() { setSelected(new Set()) }

  async function handleAction() {
    if (selected.size === 0) return
    setSending(true); setErr(null)
    try {
      const token = await getToken()

      if (sendMode === 'now') {
        const res = await fetch(`${API_URL}/api/coach-admin/forms/${form.id}/send`, {
          method:  'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body:    JSON.stringify({ client_ids: [...selected] }),
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error ?? 'Send failed')
        setResult({ mode: 'now', ...data })
      } else if (sendMode === 'scheduled') {
        if (!schedDate || !schedTime) throw new Error('Please pick a date and time.')
        const send_at = new Date(`${schedDate}T${schedTime}:00`).toISOString()
        const res = await fetch(`${API_URL}/api/coach-admin/forms/${form.id}/schedule`, {
          method:  'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body:    JSON.stringify({ client_ids: [...selected], send_mode: 'scheduled', send_at }),
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error ?? 'Schedule failed')
        setResult({ mode: 'scheduled', ...data })
        onScheduled?.()
      } else {
        const res = await fetch(`${API_URL}/api/coach-admin/forms/${form.id}/schedule`, {
          method:  'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body:    JSON.stringify({
            client_ids:     [...selected],
            send_mode:      'recurring',
            recurring_rule: {
              day_of_week: recurDay,
              hour:        parseInt(recurTime.split(':')[0], 10),
              minute:      parseInt(recurTime.split(':')[1], 10),
            },
          }),
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error ?? 'Schedule failed')
        setResult({ mode: 'recurring', ...data })
        onScheduled?.()
      }
    } catch (e) { setErr(e.message) }
    finally { setSending(false) }
  }

  const modeTab = (value, label) => (
    <button
      key={value}
      onClick={() => { setSendMode(value); setResult(null); setErr(null) }}
      className={`flex-1 py-2 text-xs font-semibold rounded-lg transition-colors ${
        sendMode === value ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
      }`}
    >
      {label}
    </button>
  )

  const actionLabel = () => {
    if (sending) return sendMode === 'now' ? 'Sending…' : 'Scheduling…'
    const n = selected.size
    if (sendMode === 'now')       return `Send to ${n || ''} Client${n !== 1 ? 's' : ''}`
    if (sendMode === 'scheduled') return `Schedule for ${n || ''} Client${n !== 1 ? 's' : ''}`
    return `Set Recurring for ${n || ''} Client${n !== 1 ? 's' : ''}`
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold text-gray-900">Send Form</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <p className="text-sm text-gray-600 mb-3">
          Sending: <span className="font-semibold text-gray-900">{form.title}</span>
        </p>

        {/* Mode tabs */}
        <div className="flex gap-1 mb-4 bg-gray-100 rounded-xl p-1">
          {modeTab('now',       'Send Now')}
          {modeTab('scheduled', 'Schedule')}
          {modeTab('recurring', 'Recurring')}
        </div>

        {err && <p className="mb-3 text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{err}</p>}

        {result ? (
          <div className="space-y-3">
            <div className="bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3">
              {result.mode === 'now' ? (
                <>
                  <p className="text-sm font-bold text-emerald-700">✓ Sent to {result.sent} client{result.sent !== 1 ? 's' : ''}</p>
                  {result.skipped > 0 && (
                    <div className="mt-1">
                      <p className="text-xs text-amber-600 font-medium">{result.skipped} skipped:</p>
                      <ul className="text-xs text-amber-600 list-disc list-inside mt-0.5">
                        {result.skipped_list.map((s, i) => <li key={i}>Client {s.client_id}: {s.reason}</li>)}
                      </ul>
                    </div>
                  )}
                </>
              ) : (
                <>
                  <p className="text-sm font-bold text-emerald-700">
                    ✓ {result.mode === 'recurring' ? 'Recurring schedule set' : 'Scheduled'} for {result.scheduled} client{result.scheduled !== 1 ? 's' : ''}
                  </p>
                  {result.skipped > 0 && (
                    <div className="mt-1">
                      <p className="text-xs text-amber-600 font-medium">{result.skipped} skipped:</p>
                      <ul className="text-xs text-amber-600 list-disc list-inside mt-0.5">
                        {result.skipped_list.map((s, i) => <li key={i}>Client {s.client_id}: {s.reason}</li>)}
                      </ul>
                    </div>
                  )}
                  <p className="text-xs text-emerald-600 mt-1">Visible in Scheduled Sends below.</p>
                </>
              )}
            </div>
            <button onClick={onClose}
              className="w-full bg-[#E8670A] text-white font-bold py-2.5 rounded-xl text-sm hover:bg-[#c45e09]">
              Done
            </button>
          </div>
        ) : (
          <>
            {loading ? (
              <p className="text-sm text-gray-400 py-4 text-center">Loading clients…</p>
            ) : clients.length === 0 ? (
              <p className="text-sm text-gray-400 py-4 text-center">No active clients found.</p>
            ) : (
              <>
                <div className="flex items-center gap-3 mb-2">
                  <span className="text-xs font-semibold text-gray-500">{selected.size} of {clients.length} selected</span>
                  <button onClick={selectAll}  className="text-xs text-[#E8670A] font-semibold hover:underline">All</button>
                  <button onClick={selectNone} className="text-xs text-gray-400 hover:underline">None</button>
                </div>
                <div className="max-h-40 overflow-y-auto border border-gray-200 rounded-xl divide-y divide-gray-100 mb-4">
                  {clients.map(c => (
                    <label key={c.id} className="flex items-center gap-3 px-3 py-2.5 cursor-pointer hover:bg-gray-50">
                      <input
                        type="checkbox"
                        checked={selected.has(c.id)}
                        onChange={() => toggleClient(c.id)}
                        className="accent-[#E8670A] w-4 h-4"
                      />
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-gray-900 truncate">{c.first_name} {c.last_name}</p>
                        <p className="text-xs text-gray-400 truncate">{c.email}</p>
                      </div>
                    </label>
                  ))}
                </div>
              </>
            )}

            {/* Timing inputs */}
            {sendMode === 'scheduled' && (
              <div className="mb-4 grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-gray-500 mb-1">Date</label>
                  <input
                    type="date"
                    value={schedDate}
                    min={new Date().toISOString().slice(0, 10)}
                    onChange={e => setSchedDate(e.target.value)}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-gray-500 mb-1">Time</label>
                  <input
                    type="time"
                    value={schedTime}
                    onChange={e => setSchedTime(e.target.value)}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]"
                  />
                </div>
              </div>
            )}

            {sendMode === 'recurring' && (
              <div className="mb-4 grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-gray-500 mb-1">Day of Week</label>
                  <select
                    value={recurDay}
                    onChange={e => setRecurDay(parseInt(e.target.value, 10))}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#E8670A]"
                  >
                    {DAY_LABELS.map((d, i) => <option key={i} value={i}>{d}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-gray-500 mb-1">Time</label>
                  <input
                    type="time"
                    value={recurTime}
                    onChange={e => setRecurTime(e.target.value)}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]"
                  />
                </div>
              </div>
            )}

            {sendMode === 'now' && (
              <p className="text-xs text-gray-400 mb-4">An in-app message with a form link will be sent to each selected client.</p>
            )}
            {sendMode === 'scheduled' && (
              <p className="text-xs text-gray-400 mb-4">Form will be delivered as an in-app message at the selected date and time.</p>
            )}
            {sendMode === 'recurring' && (
              <p className="text-xs text-gray-400 mb-4">Form will be sent every week on {DAY_LABELS[recurDay]} at {recurTime}. You can pause or cancel below.</p>
            )}

            <div className="flex gap-3">
              <button onClick={onClose}
                className="flex-1 border border-gray-200 text-gray-600 font-semibold py-2.5 rounded-xl text-sm hover:bg-gray-50">
                Cancel
              </button>
              <button
                onClick={handleAction}
                disabled={sending || selected.size === 0 || loading}
                className="flex-1 bg-[#E8670A] text-white font-bold py-2.5 rounded-xl text-sm hover:bg-[#c45e09] disabled:opacity-50"
              >
                {actionLabel()}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ── Edit Schedule Modal ───────────────────────────────────────────────────────

function EditScheduleModal({ schedule, getToken, onClose, onSaved }) {
  const isRecurring = schedule.assignment_type === 'recurring'

  // scheduled fields — prefill from next_send_at
  const prefillDt = schedule.next_send_at ? new Date(schedule.next_send_at) : new Date()
  const [schedDate, setSchedDate] = useState(prefillDt.toISOString().slice(0, 10))
  const [schedTime, setSchedTime] = useState(
    String(prefillDt.getHours()).padStart(2, '0') + ':' + String(prefillDt.getMinutes()).padStart(2, '0')
  )

  // recurring fields — prefill from recurring_rule
  const rule = schedule.recurring_rule ?? {}
  const [recurDay,  setRecurDay]  = useState(rule.day_of_week ?? 1)
  const [recurTime, setRecurTime] = useState(
    String(rule.hour ?? 9).padStart(2, '0') + ':' + String(rule.minute ?? 0).padStart(2, '0')
  )

  const [saving, setSaving] = useState(false)
  const [err,    setErr]    = useState(null)

  async function handleSave() {
    setSaving(true); setErr(null)
    try {
      const token = await getToken()
      let body
      if (isRecurring) {
        body = {
          recurring_rule: {
            day_of_week: recurDay,
            hour:        parseInt(recurTime.split(':')[0], 10),
            minute:      parseInt(recurTime.split(':')[1], 10),
          },
        }
      } else {
        if (!schedDate || !schedTime) throw new Error('Please pick a date and time.')
        body = { send_at: new Date(`${schedDate}T${schedTime}:00`).toISOString() }
      }
      const res = await fetch(`${API_URL}/api/coach-admin/form-schedules/${schedule.id}`, {
        method:  'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Save failed')
      onSaved()
    } catch (e) { setErr(e.message) }
    finally { setSaving(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold text-gray-900">Edit Schedule</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <p className="text-sm text-gray-600 mb-1 truncate">
          <span className="font-semibold text-gray-900">{schedule.form_title}</span>
        </p>
        <p className="text-xs text-gray-400 mb-4">
          {[schedule.client_first_name, schedule.client_last_name].filter(Boolean).join(' ')} · {isRecurring ? 'Recurring' : 'One-time'}
        </p>

        {err && <p className="mb-3 text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{err}</p>}

        {isRecurring ? (
          <div className="grid grid-cols-2 gap-3 mb-5">
            <div>
              <label className="block text-xs font-semibold text-gray-500 mb-1">Day of Week</label>
              <select
                value={recurDay}
                onChange={e => setRecurDay(parseInt(e.target.value, 10))}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#E8670A]"
              >
                {DAY_LABELS.map((d, i) => <option key={i} value={i}>{d}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-500 mb-1">Time</label>
              <input
                type="time"
                value={recurTime}
                onChange={e => setRecurTime(e.target.value)}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]"
              />
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 mb-5">
            <div>
              <label className="block text-xs font-semibold text-gray-500 mb-1">Date</label>
              <input
                type="date"
                value={schedDate}
                min={new Date().toISOString().slice(0, 10)}
                onChange={e => setSchedDate(e.target.value)}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-500 mb-1">Time</label>
              <input
                type="time"
                value={schedTime}
                onChange={e => setSchedTime(e.target.value)}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]"
              />
            </div>
          </div>
        )}

        {isRecurring && (
          <p className="text-xs text-gray-400 mb-4">Changes apply to future sends only. Past sends and submissions are preserved.</p>
        )}

        <div className="flex gap-3">
          <button onClick={onClose}
            className="flex-1 border border-gray-200 text-gray-600 font-semibold py-2.5 rounded-xl text-sm hover:bg-gray-50">
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex-1 bg-[#E8670A] text-white font-bold py-2.5 rounded-xl text-sm hover:bg-[#c45e09] disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Scheduled Sends Panel ─────────────────────────────────────────────────────

function fmtDt(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

function scheduleTypeLabel(type) {
  if (type === 'scheduled') return 'Scheduled'
  if (type === 'recurring') return 'Recurring'
  return type ?? 'Schedule'
}

function clientName(row) {
  return [row.client_first_name, row.client_last_name].filter(Boolean).join(' ') || 'Client'
}

function ScheduledSends({ getToken, refreshKey }) {
  const [rows,            setRows]            = useState([])
  const [loading,         setLoading]         = useState(true)
  const [actioning,       setActioning]       = useState(null)
  const [editingSchedule, setEditingSchedule] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/coach-admin/form-schedules`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (res.ok) setRows(await res.json())
    } catch {}
    finally { setLoading(false) }
  }, [getToken])

  useEffect(() => { load() }, [load, refreshKey])

  async function cancel(id) {
    if (!confirm('Cancel this scheduled send?')) return
    setActioning(id + '_cancel')
    try {
      const token = await getToken()
      await fetch(`${API_URL}/api/coach-admin/form-schedules/${id}/cancel`, {
        method: 'PATCH', headers: { Authorization: `Bearer ${token}` },
      })
      await load()
    } finally { setActioning(null) }
  }

  async function pause(id) {
    setActioning(id + '_pause')
    try {
      const token = await getToken()
      await fetch(`${API_URL}/api/coach-admin/form-schedules/${id}/pause`, {
        method: 'PATCH', headers: { Authorization: `Bearer ${token}` },
      })
      await load()
    } finally { setActioning(null) }
  }

  async function resume(id) {
    setActioning(id + '_resume')
    try {
      const token = await getToken()
      await fetch(`${API_URL}/api/coach-admin/form-schedules/${id}/resume`, {
        method: 'PATCH', headers: { Authorization: `Bearer ${token}` },
      })
      await load()
    } finally { setActioning(null) }
  }

  const STATUS_COLORS = {
    pending:   'bg-blue-50 text-blue-700 border-blue-200',
    active:    'bg-emerald-50 text-emerald-700 border-emerald-200',
    sent:      'bg-gray-100 text-gray-500 border-gray-200',
    paused:    'bg-amber-50 text-amber-700 border-amber-200',
    cancelled: 'bg-red-50 text-red-500 border-red-200',
  }

  const active = rows.filter(r => ['pending', 'active', 'paused'].includes(r.status))
  const past   = rows.filter(r => ['sent', 'cancelled'].includes(r.status))

  return (
    <section className="mt-10">
      <div className="flex items-center justify-between gap-3 mb-4">
        <div>
          <h2 className="text-lg font-bold text-gray-900">Scheduled Forms</h2>
          <p className="text-xs text-gray-500 mt-0.5">Pending one-time and recurring form deliveries</p>
        </div>
      </div>

      {loading ? (
        <p className="text-sm text-gray-400 py-6 text-center">Loading…</p>
      ) : rows.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-2xl p-8 text-center">
          <p className="text-sm text-gray-400">No scheduled forms yet. Use Send on a published form to schedule one.</p>
        </div>
      ) : (
        <>
          {active.length > 0 && (
            <div className="bg-white border border-gray-200 rounded-2xl overflow-hidden mb-4">
              <div className="px-5 py-3 bg-gray-50 border-b border-gray-200">
                <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Active</span>
              </div>
              {/* Desktop */}
              <table className="w-full hidden md:table">
                <thead className="text-xs text-gray-400 uppercase tracking-wider border-b border-gray-100">
                  <tr>
                    <th className="text-left px-5 py-2.5 font-semibold">Form</th>
                    <th className="text-left px-4 py-2.5 font-semibold">Client</th>
                    <th className="text-left px-4 py-2.5 font-semibold">Type</th>
                    <th className="text-left px-4 py-2.5 font-semibold">Status</th>
                    <th className="text-left px-4 py-2.5 font-semibold">Next Send</th>
                    <th className="text-left px-4 py-2.5 font-semibold">Last Sent</th>
                    <th className="text-right px-4 py-2.5 font-semibold">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {active.map(r => (
                    <tr key={r.id} className="text-sm">
                      <td className="px-5 py-3 font-medium text-gray-900 truncate max-w-[180px]">{r.form_title}</td>
                      <td className="px-4 py-3 text-gray-600">{clientName(r)}</td>
                      <td className="px-4 py-3">
                        <span className="text-xs font-semibold text-gray-500">{scheduleTypeLabel(r.assignment_type)}</span>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${STATUS_COLORS[r.status] ?? STATUS_COLORS.active}`}>
                          {r.status}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-500">{fmtDt(r.next_send_at)}</td>
                      <td className="px-4 py-3 text-xs text-gray-500">{fmtDt(r.last_sent_at || r.sent_at)}</td>
                      <td className="px-4 py-3 text-right whitespace-nowrap">
                        {r.assignment_type === 'recurring' && r.status === 'active' && (
                          <button
                            onClick={() => pause(r.id)}
                            disabled={actioning === r.id + '_pause'}
                            className="text-xs text-amber-600 hover:text-amber-700 font-semibold mr-3 disabled:opacity-50"
                          >
                            {actioning === r.id + '_pause' ? '…' : 'Pause'}
                          </button>
                        )}
                        {r.assignment_type === 'recurring' && r.status === 'paused' && (
                          <button
                            onClick={() => resume(r.id)}
                            disabled={actioning === r.id + '_resume'}
                            className="text-xs text-emerald-600 hover:text-emerald-700 font-semibold mr-3 disabled:opacity-50"
                          >
                            {actioning === r.id + '_resume' ? '…' : 'Resume'}
                          </button>
                        )}
                        {((r.assignment_type === 'scheduled' && r.status === 'pending') ||
                          (r.assignment_type === 'recurring' && ['active', 'paused'].includes(r.status))) && (
                          <button
                            onClick={() => setEditingSchedule(r)}
                            className="text-xs text-blue-600 hover:text-blue-700 font-semibold mr-3"
                          >
                            Edit
                          </button>
                        )}
                        <button
                          onClick={() => cancel(r.id)}
                          disabled={actioning === r.id + '_cancel'}
                          className="text-xs text-red-400 hover:text-red-600 font-medium disabled:opacity-50"
                        >
                          {actioning === r.id + '_cancel' ? '…' : 'Cancel'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {/* Mobile */}
              <div className="md:hidden divide-y divide-gray-100">
                {active.map(r => (
                  <div key={r.id} className="px-4 py-3">
                    <div className="flex items-start justify-between gap-2 mb-1">
                      <p className="text-sm font-semibold text-gray-900 truncate">{r.form_title}</p>
                      <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide shrink-0 ${STATUS_COLORS[r.status] ?? STATUS_COLORS.active}`}>
                        {r.status}
                      </span>
                    </div>
                    <p className="text-xs text-gray-500 mb-1">{clientName(r)} · {scheduleTypeLabel(r.assignment_type)}</p>
                    <p className="text-xs text-gray-400 mb-2">Next: {fmtDt(r.next_send_at)}</p>
                    <p className="text-xs text-gray-400 mb-2">Last sent: {fmtDt(r.last_sent_at || r.sent_at)}</p>
                    <div className="flex gap-3">
                      {r.assignment_type === 'recurring' && r.status === 'active' && (
                        <button
                          onClick={() => pause(r.id)}
                          disabled={actioning === r.id + '_pause'}
                          className="text-xs text-amber-600 font-semibold disabled:opacity-50"
                        >
                          {actioning === r.id + '_pause' ? '…' : 'Pause'}
                        </button>
                      )}
                      {r.assignment_type === 'recurring' && r.status === 'paused' && (
                        <button
                          onClick={() => resume(r.id)}
                          disabled={actioning === r.id + '_resume'}
                          className="text-xs text-emerald-600 font-semibold disabled:opacity-50"
                        >
                          {actioning === r.id + '_resume' ? '…' : 'Resume'}
                        </button>
                      )}
                      {((r.assignment_type === 'scheduled' && r.status === 'pending') ||
                        (r.assignment_type === 'recurring' && ['active', 'paused'].includes(r.status))) && (
                        <button
                          onClick={() => setEditingSchedule(r)}
                          className="text-xs text-blue-600 font-semibold"
                        >
                          Edit
                        </button>
                      )}
                      <button
                        onClick={() => cancel(r.id)}
                        disabled={actioning === r.id + '_cancel'}
                        className="text-xs text-red-400 font-medium ml-auto disabled:opacity-50"
                      >
                        {actioning === r.id + '_cancel' ? '…' : 'Cancel'}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {past.length > 0 && (
            <div className="bg-white border border-gray-200 rounded-2xl overflow-hidden">
              <div className="px-5 py-3 bg-gray-50 border-b border-gray-200">
                <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">History</span>
              </div>
              <div className="divide-y divide-gray-100">
                {past.slice(0, 20).map(r => (
                  <div key={r.id} className="px-5 py-3 flex items-center justify-between gap-4">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-gray-700 truncate">{r.form_title}</p>
                      <p className="text-xs text-gray-500">{clientName(r)} · {scheduleTypeLabel(r.assignment_type)}</p>
                      <p className="text-xs text-gray-400">{r.client_first_name} {r.client_last_name} · {fmtDt(r.sent_at || r.last_sent_at)}</p>
                    </div>
                    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide shrink-0 ${STATUS_COLORS[r.status] ?? STATUS_COLORS.sent}`}>
                      {r.status}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {editingSchedule && (
        <EditScheduleModal
          schedule={editingSchedule}
          getToken={getToken}
          onClose={() => setEditingSchedule(null)}
          onSaved={() => { setEditingSchedule(null); load() }}
        />
      )}
    </section>
  )
}

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

// ── AI Import modal ───────────────────────────────────────────────────────────

function AiImportModal({ getToken, onClose, onCreated }) {
  const [rawText, setRawText] = useState('')
  const [loading, setLoading] = useState(false)
  const [err,     setErr]     = useState(null)

  async function handleGenerate() {
    if (!rawText.trim()) { setErr('Paste your form text above.'); return }
    setLoading(true); setErr(null)
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/forms/ai-import`, {
        method:  'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ raw_text: rawText }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Import failed')
      onCreated(data.id)
    } catch (e) { setErr(e.message) }
    finally { setLoading(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg p-6">
        <div className="flex items-start justify-between mb-4">
          <div>
            <h2 className="text-lg font-bold text-gray-900">Import With AI</h2>
            <p className="text-xs text-gray-500 mt-0.5">AI will create a draft. Review and edit before publishing.</p>
          </div>
          <button onClick={onClose} disabled={loading} className="text-gray-400 hover:text-gray-600 mt-0.5">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {err && (
          <div className="mb-4 text-sm text-red-600 bg-red-50 border border-red-100 rounded-xl px-4 py-3">
            {err}
          </div>
        )}

        <textarea
          value={rawText}
          onChange={e => setRawText(e.target.value)}
          disabled={loading}
          placeholder="Paste your form text here — questions, answer choices, instructions, everything…"
          rows={10}
          className="w-full border border-gray-200 rounded-xl px-4 py-3 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-[#E8670A] disabled:opacity-50 mb-4"
        />

        <p className="text-xs text-gray-400 mb-4">
          AI will detect field types, answer choices, required fields, and character limits. Identity fields (name, email) are skipped automatically.
        </p>

        <div className="flex gap-3">
          <button
            onClick={onClose}
            disabled={loading}
            className="flex-1 border border-gray-200 text-gray-600 font-semibold py-2.5 rounded-xl text-sm hover:bg-gray-50 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleGenerate}
            disabled={loading || !rawText.trim()}
            className="flex-1 bg-[#E8670A] text-white font-bold py-2.5 rounded-xl text-sm hover:bg-[#c45e09] disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {loading ? (
              <>
                <svg className="animate-spin w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                </svg>
                AI is building your form…
              </>
            ) : 'Generate Draft'}
          </button>
        </div>
      </div>
    </div>
  )
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
  const [creating,      setCreating]      = useState(false)
  const [importing,     setImporting]     = useState(false)
  const [filter,        setFilter]        = useState('published')
  const [actionLoading, setActionLoading] = useState(null)
  const [sendingForm,   setSendingForm]   = useState(null)
  const [scheduleKey,   setScheduleKey]   = useState(0)   // bump to refresh ScheduledSends

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
        method: 'POST', headers: { Authorization: `Bearer ${token}` },
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
        method: 'PATCH', headers: { Authorization: `Bearer ${token}` },
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
        method: 'POST', headers: { Authorization: `Bearer ${token}` },
      })
      if (res.ok) { await load() }
    } finally { setActionLoading(null) }
  }

  const displayed = filter === 'all' ? forms : forms.filter(f => f.status === filter)

  return (
    <div className="max-w-4xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Forms</h1>
          <p className="text-sm text-gray-500 mt-0.5">Create and manage client forms</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setImporting(true)}
            className="flex items-center gap-2 border border-gray-200 bg-white text-gray-700 font-semibold px-4 py-2.5 rounded-xl text-sm hover:bg-gray-50 transition-colors"
          >
            <svg className="w-4 h-4 text-[#E8670A]" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
            </svg>
            Import With AI
          </button>
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
                        <>
                          <button
                            onClick={e => { e.stopPropagation(); navigate(`/forms/${f.id}/fill?preview=1`) }}
                            className="text-xs text-blue-600 hover:text-blue-700 font-semibold mr-3"
                          >
                            Preview
                          </button>
                          <button
                            onClick={e => { e.stopPropagation(); setSendingForm(f) }}
                            className="text-xs text-[#E8670A] hover:text-[#c45e09] font-semibold mr-3"
                          >
                            Send
                          </button>
                        </>
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
                    <>
                      <button onClick={e => { e.stopPropagation(); navigate(`/forms/${f.id}/fill?preview=1`) }}
                        className="text-xs text-blue-600 font-semibold">Preview</button>
                      <button onClick={e => { e.stopPropagation(); setSendingForm(f) }}
                        className="text-xs text-[#E8670A] font-semibold">Send</button>
                    </>
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

      {/* Scheduled Sends section */}
      <ScheduledSends getToken={getToken} refreshKey={scheduleKey} />

      {importing && (
        <AiImportModal
          getToken={getToken}
          onClose={() => setImporting(false)}
          onCreated={id => { setImporting(false); navigate(`/admin/forms/${id}/edit`) }}
        />
      )}

      {creating && (
        <CreateModal onClose={() => setCreating(false)} onCreate={handleCreate} />
      )}

      {sendingForm && (
        <SendModal
          form={sendingForm}
          getToken={getToken}
          onClose={() => setSendingForm(null)}
          onScheduled={() => setScheduleKey(k => k + 1)}
        />
      )}
    </div>
  )
}
