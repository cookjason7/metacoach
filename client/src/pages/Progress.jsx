import { useState, useEffect } from 'react'
import { useAuth } from '@clerk/clerk-react'
import { API_URL } from '../config.js'

// ── Ranges ────────────────────────────────────────────────────────────────────

const RANGES = [
  { key: '7d',     label: '7 Day',  summaryLabel: '7-day'  },
  { key: '30d',    label: '30',     summaryLabel: '30-day' },
  { key: '90d',    label: '90',     summaryLabel: '90-day' },
  { key: 'custom', label: 'Custom', summaryLabel: 'custom range' },
]

const MEASUREMENT_FIELDS = [
  { key: 'waist', label: 'Waist' },
  { key: 'hips',  label: 'Hips'  },
  { key: 'chest', label: 'Chest' },
]

// ── Helpers ───────────────────────────────────────────────────────────────────

function localIso(d = new Date()) {
  const y   = d.getFullYear()
  const m   = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}
function todayIso()     { return localIso() }
function daysAgoIso(n)  { const d = new Date(); d.setDate(d.getDate() - n); return localIso(d) }
function fmtSleep(mins) {
  if (mins == null) return null
  const h = Math.floor(mins / 60), m = mins % 60
  return m > 0 ? `${h}h ${m}m` : `${h}h`
}
function fmtNum(v, dec = 0) {
  if (v == null) return null
  return Number(v).toLocaleString('en-US', { maximumFractionDigits: dec })
}
function fmtDate(iso) {
  if (!iso) return ''
  return new Date(`${String(iso).slice(0, 10)}T12:00:00`).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  })
}
function fmtDayLabel(iso) {
  const d = new Date(`${String(iso).slice(0, 10)}T12:00:00`)
  return `${d.toLocaleDateString('en-US', { weekday: 'short' })} ${d.getMonth() + 1}/${d.getDate()}`
}

// Builds one entry per calendar day between startIso/endIso (inclusive), filling
// in `value: null` for days with no logged entry — this is what lets the chart
// gap missing days instead of interpolating through them.
function buildDenseSeries(sparseData, startIso, endIso) {
  const byDate = new Map()
  ;(sparseData ?? []).forEach(d => {
    if (d.value == null) return
    byDate.set(String(d.date).slice(0, 10), Number(d.value))
  })
  const days = []
  if (!startIso || !endIso) return days
  const cur = new Date(`${startIso}T12:00:00`)
  const end = new Date(`${endIso}T12:00:00`)
  while (cur <= end) {
    const iso = localIso(cur)
    days.push({ date: iso, value: byDate.has(iso) ? byDate.get(iso) : null })
    cur.setDate(cur.getDate() + 1)
  }
  return days
}

// ── Sparkline ─────────────────────────────────────────────────────────────────
// `data` is a dense, one-entry-per-day array (see buildDenseSeries) — days with
// no logged value carry value: null, which breaks the line instead of joining
// across the gap.

function Sparkline({ data, goalValue }) {
  if (!data || data.length < 2) return null
  const nonNull = data.filter(d => d.value != null).map(d => Number(d.value))
  if (nonNull.length === 0) return null
  const allVals = goalValue != null ? [...nonNull, Number(goalValue)] : nonNull
  const minV = Math.min(...allVals), maxV = Math.max(...allVals)
  const span = maxV - minV || 1
  const W = 400, H = 72, PX = 6, PY = 6
  const n  = data.length
  const xs = i => PX + (n === 1 ? 0 : (i / (n - 1)) * (W - PX * 2))
  const ys = v => H - PY - ((Number(v) - minV) / span) * (H - PY * 2)

  // Group into runs of consecutive logged days so the line breaks at gaps.
  const runs = []
  let run = []
  data.forEach((d, i) => {
    if (d.value != null) {
      run.push(i)
    } else if (run.length) {
      runs.push(run); run = []
    }
  })
  if (run.length) runs.push(run)
  let lastIdx = null
  for (let i = n - 1; i >= 0; i--) { if (data[i].value != null) { lastIdx = i; break } }

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" preserveAspectRatio="none" aria-hidden="true">
      {goalValue != null && (
        <line x1={PX} y1={ys(goalValue)} x2={W - PX} y2={ys(goalValue)}
          stroke="#d1d5db" strokeWidth="1.5" strokeDasharray="5 3" />
      )}
      {runs.map((idxs, ri) => {
        if (idxs.length === 1) {
          const i = idxs[0]
          return <circle key={ri} cx={xs(i)} cy={ys(data[i].value)} r="3" fill="#E8670A" />
        }
        const pts  = idxs.map(i => `${xs(i)},${ys(data[i].value)}`).join(' ')
        const fill = `M${xs(idxs[0])},${ys(data[idxs[0]].value)} ` +
          idxs.slice(1).map(i => `L${xs(i)},${ys(data[i].value)}`).join(' ') +
          ` L${xs(idxs[idxs.length - 1])},${H} L${xs(idxs[0])},${H} Z`
        return (
          <g key={ri}>
            <path d={fill} fill="#E8670A" fillOpacity="0.08" />
            <polyline fill="none" stroke="#E8670A" strokeWidth="2.5"
              strokeLinejoin="round" strokeLinecap="round" points={pts} />
          </g>
        )
      })}
      {lastIdx != null && (
        <circle cx={xs(lastIdx)} cy={ys(data[lastIdx].value)} r="4" fill="#E8670A" />
      )}
    </svg>
  )
}

// ── X-axis date labels ────────────────────────────────────────────────────────
// Shows a capped number of evenly-spaced date labels beneath the chart so
// density stays readable on mobile even at 30/90-day ranges.

function AxisLabels({ data }) {
  const n = data?.length ?? 0
  if (n < 2) return null
  const desired = Math.min(n, 6)
  const step    = Math.max(1, Math.round((n - 1) / (desired - 1)))
  const idxs    = []
  for (let i = 0; i < n; i += step) idxs.push(i)
  if (idxs[idxs.length - 1] !== n - 1) idxs.push(n - 1)
  return (
    <div className="relative h-3.5 mt-1 text-[9px] text-gray-400 select-none">
      {idxs.map(i => {
        const align = i === 0 ? 'left' : i === n - 1 ? 'right' : 'center'
        const left  = n === 1 ? 50 : (i / (n - 1)) * 100
        return (
          <span key={i} className="absolute whitespace-nowrap"
            style={{
              left: `${left}%`,
              transform: align === 'left' ? 'translateX(0)' : align === 'right' ? 'translateX(-100%)' : 'translateX(-50%)',
            }}>
            {fmtDayLabel(data[i].date)}
          </span>
        )
      })}
    </div>
  )
}

// ── Missing entries strip ─────────────────────────────────────────────────────

function MissingEntriesStrip({ missingDates, onLogDate }) {
  if (!missingDates.length) return null
  const CAP   = 6
  const shown = missingDates.slice(0, CAP)
  const extra = missingDates.length - shown.length
  return (
    <div className="bg-amber-50 border border-amber-100 rounded-2xl p-3 mb-4">
      <p className="text-[11px] font-semibold text-amber-700 uppercase tracking-wide mb-2">
        Missing {missingDates.length} {missingDates.length === 1 ? 'day' : 'days'}
      </p>
      <div className="flex flex-wrap gap-2">
        {shown.map(iso => (
          <button key={iso} type="button" onClick={() => onLogDate(iso)}
            className="min-h-[44px] px-3 rounded-full bg-white border border-amber-200 text-xs font-medium text-amber-800 hover:bg-amber-100 active:bg-amber-200 transition-colors">
            {fmtDayLabel(iso)}
          </button>
        ))}
        {extra > 0 && (
          <span className="min-h-[44px] px-3 inline-flex items-center text-xs font-medium text-amber-600">
            +{extra} more
          </span>
        )}
      </div>
    </div>
  )
}

// ── ChartCard — used in detail views ─────────────────────────────────────────

function ChartCard({ title, data, goalValue, goalLabel, fmtVal, rangeStart, rangeEnd, quickLogMetric }) {
  const cleanData = (data ?? [])
    .filter(d => d.value != null && Number.isFinite(Number(d.value)))
    // Use timestamp arithmetic — pg returns date columns as JS Date objects,
    // not plain strings, so String().localeCompare() gives wrong ordering.
    .sort((a, b) => new Date(a.date ?? 0).getTime() - new Date(b.date ?? 0).getTime())
  const values    = cleanData.map(d => Number(d.value))
  const hasData   = values.length >= 2
  const denseData = buildDenseSeries(data, rangeStart, rangeEnd)
  const missingDates = quickLogMetric
    ? denseData.filter(d => d.value == null).map(d => d.date)
    : []

  function onLogDate(iso) {
    window.dispatchEvent(new CustomEvent('open-quick-log', { detail: { action: quickLogMetric, date: iso } }))
  }

  return (
    <div className="bg-white rounded-2xl border border-gray-200 p-4 mb-4">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold text-gray-800">{title}</h3>
        {goalValue != null && (
          <span className="text-xs text-gray-400">Goal: {goalLabel ?? fmtNum(goalValue)}</span>
        )}
      </div>
      {hasData ? (
        <>
          <div className="flex justify-between text-[10px] text-gray-400 mb-0.5">
            <span>{fmtVal ? fmtVal(Math.min(...values)) : fmtNum(Math.min(...values))}</span>
            <span>{fmtVal ? fmtVal(Math.max(...values)) : fmtNum(Math.max(...values))}</span>
          </div>
          <Sparkline data={denseData} goalValue={goalValue} />
          <AxisLabels data={denseData} />
        </>
      ) : (
        <p className="text-xs text-gray-400 text-center py-5">Not enough data to chart yet.</p>
      )}
      {quickLogMetric && (
        <div className="mt-3">
          <MissingEntriesStrip missingDates={missingDates} onLogDate={onLogDate} />
        </div>
      )}
    </div>
  )
}

// ── Hub metric card ───────────────────────────────────────────────────────────

function MetricCard({ label, value, sub, chip, chipGreen, onClick }) {
  const hasValue = value != null
  return (
    <button
      onClick={onClick}
      className="bg-white rounded-2xl border border-gray-200 p-4 text-left w-full transition-colors hover:border-orange-200 active:bg-orange-50/40 flex flex-col min-h-[96px]"
    >
      <div className="flex items-start justify-between gap-1 mb-1.5">
        <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-widest leading-none">{label}</p>
        <svg className="w-3.5 h-3.5 text-gray-300 shrink-0 mt-px" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
      </div>
      {hasValue ? (
        <>
          <p className="text-xl font-bold text-gray-900 leading-tight">{value}</p>
          {sub  && <p className="text-xs text-gray-400 mt-0.5 leading-snug">{sub}</p>}
          {chip != null && (
            <span className={`mt-1.5 inline-flex text-[11px] font-semibold px-1.5 py-0.5 rounded-full ${
              chipGreen ? 'bg-green-50 text-green-700' : 'bg-amber-50 text-amber-700'
            }`}>{chip}</span>
          )}
        </>
      ) : (
        <p className="text-sm text-gray-300 mt-auto">No data yet</p>
      )}
    </button>
  )
}

// ── Full-width hub card (Measurements / Photos) ───────────────────────────────

function HubRowCard({ label, summary, onClick }) {
  return (
    <button
      onClick={onClick}
      className="bg-white rounded-2xl border border-gray-200 px-4 py-3.5 w-full flex items-center justify-between gap-3 transition-colors hover:border-orange-200 active:bg-orange-50/40"
    >
      <p className="text-sm font-semibold text-gray-800">{label}</p>
      <div className="flex items-center gap-2 shrink-0">
        {summary && <span className="text-xs text-gray-400">{summary}</span>}
        <svg className="w-4 h-4 text-gray-300" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
      </div>
    </button>
  )
}

// ── Measurement detail components (unchanged logic) ───────────────────────────

function MeasurementCard({ field, measurements }) {
  const withValue = measurements
    .filter(m => m[field.key] != null && m[field.key] !== '')
    .sort((a, b) => new Date(a.measurement_date ?? 0).getTime() - new Date(b.measurement_date ?? 0).getTime())
  const first  = withValue[0]
  const latest = withValue[withValue.length - 1]
  const delta  = first && latest && first.id !== latest.id
    ? +(Number(latest[field.key]) - Number(first[field.key])).toFixed(1)
    : null
  const trend  = withValue.map(m => ({ date: m.measurement_date, value: Number(m[field.key]) }))
  return (
    <div className="bg-white rounded-2xl border border-gray-200 p-4 mb-3">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <h3 className="text-sm font-semibold text-gray-800">{field.label}</h3>
          <p className="text-xs text-gray-400">
            {latest ? `Latest: ${fmtDate(latest.measurement_date)}` : 'No entry yet'}
          </p>
        </div>
        <div className="text-right">
          <p className="text-xl font-bold text-gray-900">
            {latest ? `${Number(latest[field.key]).toFixed(1)}"` : '-'}
          </p>
          {delta != null && (
            <p className={`text-xs font-semibold ${delta < 0 ? 'text-green-600' : delta > 0 ? 'text-amber-600' : 'text-gray-400'}`}>
              {delta > 0 ? '+' : ''}{delta}"
            </p>
          )}
        </div>
      </div>
      {trend.length >= 2
        ? <Sparkline data={trend} />
        : <p className="text-xs text-gray-400 text-center py-4">Need 2+ entries to chart.</p>
      }
    </div>
  )
}

function MeasurementsSection({ measurements, rangeLabel, onUpdate, onDelete }) {
  const [editing, setEditing] = useState(null)
  const [form,    setForm]    = useState({ measurement_date: '', chest: '', waist: '', hips: '' })
  const [saving,  setSaving]  = useState(false)
  const [error,   setError]   = useState('')

  function startEdit(m) {
    setEditing(m.id); setError('')
    setForm({
      measurement_date: String(m.measurement_date).slice(0, 10),
      chest: m.chest ?? '', waist: m.waist ?? '', hips: m.hips ?? '',
    })
  }
  async function saveEdit(e) {
    e.preventDefault(); setSaving(true); setError('')
    try {
      await onUpdate(editing, {
        measurement_date: form.measurement_date,
        chest: form.chest !== '' ? Number(form.chest) : null,
        waist: form.waist !== '' ? Number(form.waist) : null,
        hips:  form.hips  !== '' ? Number(form.hips)  : null,
      })
      setEditing(null)
    } catch { setError('Could not save measurement.') }
    finally  { setSaving(false) }
  }

  if (!measurements.length) {
    return (
      <div className="bg-white rounded-2xl border border-gray-200 p-6 text-center mb-4">
        <p className="text-sm font-semibold text-gray-700 mb-1">No measurements in this range</p>
        <p className="text-xs text-gray-400">Add waist, hips, and chest measurements in Settings.</p>
      </div>
    )
  }

  return (
    <>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-base font-semibold text-gray-800">Measurements</h2>
        <span className="text-xs text-gray-400">{rangeLabel}</span>
      </div>
      {MEASUREMENT_FIELDS.map(field => (
        <MeasurementCard key={field.key} field={field} measurements={measurements} />
      ))}
      <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden mb-4">
        <div className="px-4 py-3 border-b border-gray-100">
          <p className="text-sm font-semibold text-gray-800">History</p>
        </div>
        <div className="divide-y divide-gray-100">
          {measurements
            .slice()
            .sort((a, b) => String(b.measurement_date).localeCompare(String(a.measurement_date)))
            .map(m => (
              <div key={m.id} className="p-4">
                {editing === m.id ? (
                  <form onSubmit={saveEdit} className="space-y-3">
                    <input type="date" value={form.measurement_date}
                      onChange={e => setForm(f => ({ ...f, measurement_date: e.target.value }))}
                      className="min-h-10 rounded-lg border border-gray-200 px-3 text-sm" />
                    <div className="grid grid-cols-3 gap-2">
                      {MEASUREMENT_FIELDS.map(field => (
                        <label key={field.key} className="text-xs text-gray-500">
                          {field.label}
                          <input type="number" step="0.1" min="0" value={form[field.key]}
                            onChange={e => setForm(f => ({ ...f, [field.key]: e.target.value }))}
                            className="mt-1 w-full min-h-10 rounded-lg border border-gray-200 px-2 text-sm text-gray-800" />
                        </label>
                      ))}
                    </div>
                    {error && <p className="text-xs text-red-500">{error}</p>}
                    <div className="flex gap-2">
                      <button type="submit" disabled={saving}
                        className="min-h-10 px-4 rounded-lg bg-[#E8670A] text-white text-xs font-semibold disabled:opacity-60">
                        {saving ? 'Saving...' : 'Save'}
                      </button>
                      <button type="button" onClick={() => setEditing(null)}
                        className="min-h-10 px-4 rounded-lg border border-gray-200 text-xs font-semibold text-gray-600">
                        Cancel
                      </button>
                    </div>
                  </form>
                ) : (
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-gray-800">{fmtDate(m.measurement_date)}</p>
                      <p className="text-xs text-gray-500">
                        Chest {m.chest ? `${Number(m.chest).toFixed(1)}"` : '-'} ·{' '}
                        Waist {m.waist ? `${Number(m.waist).toFixed(1)}"` : '-'} ·{' '}
                        Hips  {m.hips  ? `${Number(m.hips ).toFixed(1)}"` : '-'}
                      </p>
                    </div>
                    <div className="flex gap-2 shrink-0">
                      <button type="button" onClick={() => startEdit(m)}
                        className="min-h-9 px-3 rounded-lg border border-gray-200 text-xs font-semibold text-gray-600">
                        Edit
                      </button>
                      <button type="button" onClick={() => onDelete(m.id)}
                        className="min-h-9 px-3 rounded-lg border border-red-100 text-xs font-semibold text-red-600">
                        Delete
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
        </div>
      </div>
    </>
  )
}

// ── Progress Photos detail ────────────────────────────────────────────────────

const PHOTO_ANGLES = [
  { key: 'front', label: 'Front' },
  { key: 'side',  label: 'Side'  },
  { key: 'back',  label: 'Back'  },
]

function ProgressPhotosSection({ photos }) {
  if (!photos?.length) {
    return (
      <div className="bg-white rounded-2xl border border-gray-200 p-8 text-center">
        <p className="text-sm font-semibold text-gray-700 mb-1">No photos in this range</p>
        <p className="text-xs text-gray-400">Use the + Log button to upload a progress photo.</p>
      </div>
    )
  }
  return (
    <div className="space-y-5">
      {photos.map((session, si) => {
        const photoCount = PHOTO_ANGLES.filter(({ key }) => session.photos[key]).length
        return (
          <div key={session.session_id ?? si}>
            {/* Session date header */}
            <div className="flex items-center gap-2 mb-2">
              <span className="text-xs font-semibold text-gray-700">{fmtDate(session.session_date)}</span>
              <span className="text-[10px] text-gray-400 ml-auto">{photoCount}/3</span>
            </div>
            {/* 3-across grid — Front | Side | Back */}
            <div className="grid grid-cols-3 gap-2">
              {PHOTO_ANGLES.map(({ key, label }) => {
                const p = session.photos[key]
                return (
                  <div key={key} className="text-center">
                    <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-1">{label}</p>
                    {p ? (
                      <div className="rounded-xl overflow-hidden bg-gray-50 border border-gray-200">
                        <img
                          src={p.photo_url}
                          alt={`${label} progress photo`}
                          className="w-full aspect-[3/4] object-contain"
                          loading="lazy"
                        />
                      </div>
                    ) : (
                      <div className="rounded-xl bg-gray-50 border border-dashed border-gray-200 aspect-[3/4] flex items-center justify-center">
                        <span className="text-[10px] text-gray-300">—</span>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
            {si < photos.length - 1 && <div className="mt-5 border-t border-gray-100" />}
          </div>
        )
      })}
    </div>
  )
}

// ── Back button ───────────────────────────────────────────────────────────────

function BackButton({ onClick }) {
  return (
    <button onClick={onClick}
      className="flex items-center gap-1.5 text-sm font-medium text-gray-500 hover:text-gray-800 transition-colors mb-5 -ml-0.5">
      <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
      </svg>
      Progress
    </button>
  )
}

// ── Main Progress component ───────────────────────────────────────────────────

export default function Progress() {
  const { getToken } = useAuth()
  const [range,         setRange]         = useState('7d')
  const [startDate,     setStartDate]     = useState(daysAgoIso(7))
  const [endDate,       setEndDate]       = useState(todayIso())
  const [data,          setData]          = useState(null)
  const [measurements,  setMeasurements]  = useState([])
  const [loading,       setLoading]       = useState(true)
  const [error,         setError]         = useState(false)
  const [selectedMetric, setSelectedMetric] = useState(null)  // null = hub view
  const [syncTick,      setSyncTick]      = useState(0)       // incremented by daily-log-updated

  // Sync startDate when a preset range is picked
  function pickRange(key) {
    setRange(key)
    if (key === '7d')  setStartDate(daysAgoIso(7))
    if (key === '30d') setStartDate(daysAgoIso(30))
    if (key === '90d') setStartDate(daysAgoIso(90))
    setEndDate(todayIso())
  }

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true); setError(false)
      try {
        const token   = await getToken()
        const params  = new URLSearchParams({ range })
        if (range === 'custom') {
          params.set('start_date', startDate)
          params.set('end_date',   endDate)
        }
        const headers = { Authorization: `Bearer ${token}` }
        const [progressRes, measurementsRes] = await Promise.all([
          fetch(`${API_URL}/api/daily-logs/progress?${params.toString()}`, { headers }),
          fetch(`${API_URL}/api/measurements`, { headers }),
        ])
        if (!progressRes.ok) throw new Error()
        const progressJson     = await progressRes.json()
        const measurementsJson = measurementsRes.ok ? await measurementsRes.json() : []
        if (!cancelled) {
          setData(progressJson)
          setMeasurements(Array.isArray(measurementsJson) ? measurementsJson : [])
        }
      } catch { if (!cancelled) setError(true) }
      finally  { if (!cancelled) setLoading(false) }
    }
    load()
    return () => { cancelled = true }
  }, [range, startDate, endDate, getToken, syncTick])

  // Refresh when daily logs change (e.g. after a health/activity sync).
  useEffect(() => {
    function onDailyLogUpdated() { setSyncTick(t => t + 1) }
    window.addEventListener('daily-log-updated', onDailyLogUpdated)
    return () => window.removeEventListener('daily-log-updated', onDailyLogUpdated)
  }, [])

  const s               = data?.summary ?? {}
  const effectiveStart  = data?.start_date ?? startDate
  const effectiveEnd    = data?.end_date   ?? endDate
  const rangeMeta       = RANGES.find(r => r.key === range) ?? RANGES[0]
  const rangeLabel      = range === 'custom'
    ? `${fmtDate(effectiveStart)} – ${fmtDate(effectiveEnd)}`
    : rangeMeta.summaryLabel
  const selectedMeasurements = measurements.filter(m => {
    const d = String(m.measurement_date).slice(0, 10)
    return d >= effectiveStart && d <= effectiveEnd
  })

  async function updateMeasurement(id, payload) {
    const token = await getToken()
    const res   = await fetch(`${API_URL}/api/measurements/${id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!res.ok) throw new Error()
    const updated = await res.json()
    setMeasurements(prev => prev
      .map(m => m.id === id ? updated : m)
      .sort((a, b) => String(b.measurement_date).localeCompare(String(a.measurement_date))))
  }

  async function deleteMeasurement(id) {
    if (!window.confirm('Delete this measurement entry? This cannot be undone.')) return
    const token = await getToken()
    const res   = await fetch(`${API_URL}/api/measurements/${id}`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
    })
    if (res.ok) setMeasurements(prev => prev.filter(m => m.id !== id))
  }

  // ── Range selector (shared between hub + detail) ──────────────────────────

  const RangeBar = (
    <div className="flex flex-col items-end gap-2">
      <div className="flex gap-1 bg-gray-100 rounded-xl p-1 shrink-0">
        {RANGES.map(r => (
          <button key={r.key} onClick={() => pickRange(r.key)}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors min-h-[36px] whitespace-nowrap ${
              range === r.key ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
            }`}>
            {r.label}
          </button>
        ))}
      </div>
      {range === 'custom' && (
        <div className="flex items-center gap-2 text-xs">
          <label className="flex items-center gap-1 text-gray-500">
            <input type="date" aria-label="Start date" value={startDate}
              onChange={e => setStartDate(e.target.value)} max={endDate}
              className="min-h-10 rounded-lg border border-gray-200 px-2 text-xs text-gray-700 focus:outline-none focus:ring-2 focus:ring-[#E8670A]" />
          </label>
          <span className="text-gray-400">–</span>
          <label className="flex items-center gap-1 text-gray-500">
            <input type="date" aria-label="End date" value={endDate}
              onChange={e => setEndDate(e.target.value)} min={startDate} max={todayIso()}
              className="min-h-10 rounded-lg border border-gray-200 px-2 text-xs text-gray-700 focus:outline-none focus:ring-2 focus:ring-[#E8670A]" />
          </label>
        </div>
      )}
    </div>
  )

  // ── Detail view content ───────────────────────────────────────────────────

  function renderDetail() {
    const caloriesSeries = data?.macro_series?.map(d => ({ date: d.date, value: d.calories }))
    const proteinSeries  = data?.macro_series?.map(d => ({ date: d.date, value: d.protein  }))

    switch (selectedMetric) {
      case 'weight':
        return (
          <>
            <div className="grid grid-cols-3 gap-3 mb-4">
              <div className="bg-white rounded-2xl border border-gray-200 p-4">
                <p className="text-xs text-gray-500 mb-1">Start</p>
                <p className="text-lg font-bold text-gray-900">{s.weight_start ? `${s.weight_start} lbs` : '—'}</p>
              </div>
              <div className="bg-white rounded-2xl border border-gray-200 p-4">
                <p className="text-xs text-gray-500 mb-1">Current</p>
                <p className="text-lg font-bold text-gray-900">{s.weight_current ? `${s.weight_current} lbs` : '—'}</p>
              </div>
              <div className="bg-white rounded-2xl border border-gray-200 p-4">
                <p className="text-xs text-gray-500 mb-1">Change</p>
                <p className={`text-lg font-bold ${
                  s.weight_change == null ? 'text-gray-900'
                  : s.weight_change < 0 ? 'text-green-600' : 'text-amber-600'
                }`}>
                  {s.weight_change != null ? `${s.weight_change > 0 ? '+' : ''}${s.weight_change} lbs` : '—'}
                </p>
              </div>
            </div>
            <ChartCard title="Weight (lbs)" data={data?.weight_series} fmtVal={v => `${v} lbs`}
              rangeStart={effectiveStart} rangeEnd={effectiveEnd} quickLogMetric="weight" />
          </>
        )
      case 'steps':
        return <ChartCard title="Daily Steps" data={data?.step_series} fmtVal={v => fmtNum(v)}
          rangeStart={effectiveStart} rangeEnd={effectiveEnd} quickLogMetric="steps" />
      case 'calories_burned':
        return <ChartCard title="Calories Burned" data={data?.calories_burned_series} fmtVal={v => `${fmtNum(v)} cal`}
          rangeStart={effectiveStart} rangeEnd={effectiveEnd} />
      case 'sleep':
        return <ChartCard title="Sleep" data={data?.sleep_series} fmtVal={v => fmtSleep(v)}
          rangeStart={effectiveStart} rangeEnd={effectiveEnd} quickLogMetric="sleep" />
      case 'calories':
        return (
          <ChartCard title="Calories" data={caloriesSeries}
            goalValue={s.goal_calories || null}
            goalLabel={s.goal_calories ? `${fmtNum(s.goal_calories)} kcal` : null}
            fmtVal={v => fmtNum(v)}
            rangeStart={effectiveStart} rangeEnd={effectiveEnd} />
        )
      case 'protein':
        return (
          <ChartCard title="Protein (g)" data={proteinSeries}
            goalValue={s.goal_protein || null}
            goalLabel={s.goal_protein ? `${s.goal_protein}g` : null}
            fmtVal={v => `${v}g`}
            rangeStart={effectiveStart} rangeEnd={effectiveEnd} />
        )
      case 'water':
        return <ChartCard title="Water (oz)" data={data?.water_series} fmtVal={v => `${v} oz`}
          rangeStart={effectiveStart} rangeEnd={effectiveEnd} quickLogMetric="water" />
      case 'activity':
        return (
          <div className="bg-white rounded-2xl border border-gray-200 p-6 text-center">
            <p className="text-4xl font-bold text-gray-900 mb-1">{s.total_activity ?? '—'}</p>
            <p className="text-sm text-gray-500">workouts &amp; activities over {rangeLabel}</p>
            <div className="flex justify-center gap-6 mt-4 text-sm text-gray-500">
              <div>
                <span className="block text-xl font-bold text-gray-800">{s.workouts_completed ?? 0}</span>
                <span className="text-xs">Workouts</span>
              </div>
              <div>
                <span className="block text-xl font-bold text-gray-800">{s.activities_completed ?? 0}</span>
                <span className="text-xs">Activities</span>
              </div>
            </div>
          </div>
        )
      case 'measurements':
        return (
          <MeasurementsSection
            measurements={selectedMeasurements}
            rangeLabel={rangeLabel}
            onUpdate={updateMeasurement}
            onDelete={deleteMeasurement}
          />
        )
      case 'photos':
        return (
          <ProgressPhotosSection
            photos={data?.progress_photos}
          />
        )
      default:
        return null
    }
  }

  const DETAIL_LABELS = {
    weight: 'Weight', steps: 'Steps', calories_burned: 'Calories Burned', sleep: 'Sleep',
    calories: 'Calories', protein: 'Protein', water: 'Water',
    activity: 'Activity', measurements: 'Measurements', photos: 'Progress Photos',
  }

  // ── Hub cards data ────────────────────────────────────────────────────────

  function weightChip() {
    const c = s.weight_change
    if (c == null) return null
    return { label: `${c > 0 ? '+' : ''}${c} lbs`, green: c <= 0 }
  }

  const photoCount  = data?.progress_photos?.length ?? 0
  const measCount   = selectedMeasurements.length

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="w-full max-w-2xl mx-auto pb-8">

      {/* Header + range bar */}
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">My Progress</h1>
          {selectedMetric && (
            <p className="text-sm text-gray-400 mt-0.5">{DETAIL_LABELS[selectedMetric]}</p>
          )}
        </div>
        {RangeBar}
      </div>

      {loading && (
        <div className="grid grid-cols-2 gap-3 mb-4">
          {[...Array(7)].map((_, i) => (
            <div key={i} className="bg-white rounded-2xl border border-gray-200 p-4 h-24 animate-pulse">
              <div className="h-2.5 bg-gray-100 rounded w-14 mb-3" />
              <div className="h-6 bg-gray-100 rounded w-20" />
            </div>
          ))}
        </div>
      )}

      {error && !loading && (
        <p className="text-sm text-red-500 text-center py-8">
          Could not load progress data. Please try again.
        </p>
      )}

      {!loading && !error && data && (
        <>
          {/* ── Detail view ── */}
          {selectedMetric ? (
            <>
              <BackButton onClick={() => setSelectedMetric(null)} />
              {renderDetail()}
            </>
          ) : (
            /* ── Hub view ── */
            <>
              {/* 2-col metric cards */}
              <div className="grid grid-cols-2 gap-3 mb-3">
                <MetricCard
                  label="Weight"
                  value={s.weight_current ? `${s.weight_current} lbs` : null}
                  sub={s.weight_change != null ? null : 'no entries yet'}
                  chip={weightChip()?.label}
                  chipGreen={weightChip()?.green}
                  onClick={() => setSelectedMetric('weight')}
                />
                <MetricCard
                  label="Steps"
                  value={fmtNum(s.avg_steps)}
                  sub="avg / day"
                  onClick={() => setSelectedMetric('steps')}
                />
                <MetricCard
                  label="Cal Burned"
                  value={fmtNum(s.avg_calories_burned)}
                  sub="avg / day"
                  onClick={() => setSelectedMetric('calories_burned')}
                />
                <MetricCard
                  label="Sleep"
                  value={fmtSleep(s.avg_sleep_minutes ? Number(s.avg_sleep_minutes) : null)}
                  sub="avg / night"
                  onClick={() => setSelectedMetric('sleep')}
                />
                <MetricCard
                  label="Calories"
                  value={fmtNum(s.avg_calories)}
                  sub={s.goal_calories ? `Goal: ${fmtNum(s.goal_calories)}` : 'avg / day'}
                  onClick={() => setSelectedMetric('calories')}
                />
                <MetricCard
                  label="Protein"
                  value={s.avg_protein != null ? `${s.avg_protein}g` : null}
                  sub={s.goal_protein ? `Goal: ${s.goal_protein}g` : 'avg / day'}
                  onClick={() => setSelectedMetric('protein')}
                />
                <MetricCard
                  label="Water"
                  value={s.avg_water_oz != null ? `${s.avg_water_oz} oz` : null}
                  sub="avg / day"
                  onClick={() => setSelectedMetric('water')}
                />
              </div>

              {/* Activity card (single, if there's data) */}
              <div className="mb-3">
                <MetricCard
                  label="Activity"
                  value={s.total_activity != null ? String(s.total_activity) : null}
                  sub={`workouts & activities over ${rangeLabel}`}
                  onClick={() => setSelectedMetric('activity')}
                />
              </div>

              {/* Full-width section links */}
              <div className="space-y-2 mb-2">
                <HubRowCard
                  label="Measurements"
                  summary={measCount > 0 ? `${measCount} entr${measCount === 1 ? 'y' : 'ies'}` : 'No data in range'}
                  onClick={() => setSelectedMetric('measurements')}
                />
                <HubRowCard
                  label="Progress Photos"
                  summary={photoCount > 0 ? `${photoCount} session${photoCount === 1 ? '' : 's'}` : 'No photos in range'}
                  onClick={() => setSelectedMetric('photos')}
                />
              </div>
            </>
          )}
        </>
      )}
    </div>
  )
}
