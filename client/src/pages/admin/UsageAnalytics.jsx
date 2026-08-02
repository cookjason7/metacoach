import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '@clerk/clerk-react'
import { API_URL } from '../../config.js'
import { useOrgBranding } from '../../context/OrgBrandingContext.jsx'

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtCost(n) {
  if (n == null) return '—'
  if (n === 0)   return '$0.00'
  if (n < 0.001) return `$${(n * 100).toFixed(4)}¢`
  if (n < 1)     return `$${n.toFixed(4)}`
  return `$${n.toFixed(2)}`
}

function fmtNum(n) {
  if (n == null) return '—'
  return Number(n).toLocaleString('en-US')
}

function relDate(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function engagementBadge(status) {
  const map = {
    high_usage:     { label: 'High',         bg: 'bg-emerald-100 text-emerald-700' },
    moderate:       { label: 'Moderate',     bg: 'bg-blue-100   text-blue-700'     },
    at_risk:        { label: 'At Risk',      bg: 'bg-amber-100  text-amber-700'    },
    inactive:       { label: 'Inactive',     bg: 'bg-red-100    text-red-700'      },
    never_logged_in:{ label: 'Never Logged', bg: 'bg-gray-100   text-gray-600'     },
  }
  const { label, bg } = map[status] ?? { label: status, bg: 'bg-gray-100 text-gray-600' }
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold ${bg}`}>
      {label}
    </span>
  )
}

function StatCard({ label, value, sub, accent }) {
  return (
    <div className="bg-white rounded-2xl border border-gray-200 p-4 flex flex-col gap-0.5">
      <span className="text-xs text-gray-500">{label}</span>
      <span className={`text-xl font-bold truncate ${accent ?? 'text-gray-900'}`}>{value ?? '—'}</span>
      {sub && <span className="text-xs text-gray-400">{sub}</span>}
    </div>
  )
}

// Simple bar chart using inline divs
function BarChart({ rows, labelKey, valueKey, fmtValue, maxRows = 8 }) {
  const visible = rows.slice(0, maxRows)
  const maxVal  = Math.max(...visible.map(r => Number(r[valueKey]) || 0), 0.0001)
  return (
    <div className="space-y-2">
      {visible.map((r, i) => {
        const val = Number(r[valueKey]) || 0
        const pct = (val / maxVal) * 100
        return (
          <div key={i} className="flex items-center gap-2">
            <span className="text-xs text-gray-600 w-36 truncate shrink-0">{r[labelKey]}</span>
            <div className="flex-1 bg-gray-100 rounded-full h-2">
              <div
                className="h-2 rounded-full bg-[#E8670A] transition-all"
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className="text-xs text-gray-700 font-medium w-16 text-right shrink-0">
              {fmtValue ? fmtValue(val) : fmtNum(val)}
            </span>
          </div>
        )
      })}
    </div>
  )
}

// Tiny spark-line style daily trend chart
function TrendChart({ rows }) {
  if (!rows?.length) return <div className="text-xs text-gray-400 italic py-4 text-center">No data for this range</div>
  const costs = rows.map(r => Number(r.total_cost))
  const maxC   = Math.max(...costs, 0.0001)
  const W = 500, H = 64, PX = 4, PY = 6
  const xs = i => PX + (i / (rows.length - 1 || 1)) * (W - PX * 2)
  const ys = v => H - PY - ((v / maxC) * (H - PY * 2))
  const pts  = rows.map((r, i) => `${xs(i)},${ys(Number(r.total_cost))}`).join(' ')
  const fill = `M${xs(0)},${ys(costs[0])} ` +
    rows.slice(1).map((r, i) => `L${xs(i + 1)},${ys(Number(r.total_cost))}`).join(' ') +
    ` L${xs(rows.length - 1)},${H} L${xs(0)},${H} Z`
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" preserveAspectRatio="none" aria-hidden="true">
        <path d={fill} fill="#E8670A" fillOpacity="0.1" />
        <polyline fill="none" stroke="#E8670A" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" points={pts} />
      </svg>
      <div className="flex justify-between text-[10px] text-gray-400 mt-1 px-1">
        <span>{rows[0]?.date}</span>
        <span>{rows[rows.length - 1]?.date}</span>
      </div>
    </div>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function UsageAnalytics() {
  const { getToken } = useAuth()
  const { aiCoachName } = useOrgBranding()

  const today   = new Date().toISOString().slice(0, 10)
  const default30 = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10)

  const [start, setStart]     = useState(default30)
  const [end,   setEnd]       = useState(today)
  const [data,  setData]      = useState(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState(null)
  const [tab,     setTab]     = useState('overview')

  const load = useCallback(async (s, e) => {
    setLoading(true)
    setError(null)
    try {
      const token = await getToken()
      const res   = await fetch(`${API_URL}/api/admin/usage-analytics?start=${s}&end=${e}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (res.status === 403) { setError('Super admin access required.'); return }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setData(await res.json())
    } catch (err) {
      setError(err.message || 'Failed to load analytics')
    } finally {
      setLoading(false)
    }
  }, [getToken])

  useEffect(() => { load(start, end) }, []) // eslint-disable-line react-hooks/exhaustive-deps

  function applyRange() { load(start, end) }

  function setPreset(days) {
    const s = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)
    setStart(s)
    setEnd(today)
    load(s, today)
  }

  const TABS = [
    { id: 'overview',    label: 'Overview'   },
    { id: 'clients',     label: 'Clients'    },
    { id: 'engagement',  label: 'Engagement' },
    { id: 'events',      label: 'Events'     },
  ]

  return (
    <div className="w-full max-w-5xl mx-auto pb-10">

      {/* Header */}
      <div className="flex items-start sm:items-center justify-between gap-3 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Usage Analytics</h1>
          <p className="text-xs text-gray-400 mt-0.5">Super admin · cost-driving events</p>
        </div>
      </div>

      {/* Date range picker */}
      <div className="bg-white rounded-2xl border border-gray-200 p-4 mb-6">
        <div className="flex flex-wrap gap-2 items-end">
          <div className="flex flex-col gap-1">
            <label className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide">Start</label>
            <input type="date" value={start} max={end}
              onChange={e => setStart(e.target.value)}
              className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#E8670A]"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide">End</label>
            <input type="date" value={end} min={start} max={today}
              onChange={e => setEnd(e.target.value)}
              className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#E8670A]"
            />
          </div>
          <button onClick={applyRange}
            className="bg-[#E8670A] text-white text-sm font-semibold px-4 py-2 rounded-lg hover:bg-[#c45e09] transition-colors min-h-[40px]">
            Apply
          </button>
          <div className="flex gap-1 ml-2">
            {[7, 30, 90].map(d => (
              <button key={d} onClick={() => setPreset(d)}
                className="px-3 py-2 rounded-lg text-xs font-semibold border border-gray-200 hover:border-[#E8670A] hover:text-[#E8670A] transition-colors min-h-[40px]">
                {d}d
              </button>
            ))}
          </div>
        </div>
        {data && (
          <p className="text-[11px] text-gray-400 mt-2">
            Showing {data.range.start} → {data.range.end}
          </p>
        )}
      </div>

      {error && !loading && (
        <div className="bg-red-50 border border-red-200 rounded-2xl px-5 py-6 mb-6 text-center">
          <p className="text-2xl mb-2">⚠️</p>
          <p className="text-sm font-semibold text-gray-700">{error}</p>
        </div>
      )}

      {loading && (
        <div className="flex justify-center py-20">
          <span className="text-sm text-gray-400">Loading analytics…</span>
        </div>
      )}

      {!loading && !error && data && (
        <>
          {/* Tabs */}
          <div className="flex gap-1 bg-gray-100 rounded-xl p-1 mb-6 w-fit">
            {TABS.map(t => (
              <button key={t.id} onClick={() => setTab(t.id)}
                className={`px-4 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                  tab === t.id ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
                }`}>
                {t.label}
              </button>
            ))}
          </div>

          {/* ── Overview Tab ─────────────────────────────────────────────── */}
          {tab === 'overview' && (
            <>
              {/* Summary stat cards */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
                <StatCard label="Total Cost" value={fmtCost(data.totals.total_cost)} />
                <StatCard label="AI Cost"    value={fmtCost(data.totals.ai_cost)}    sub="Anthropic" />
                <StatCard label="Upload Cost" value={fmtCost(data.totals.upload_cost)} sub="Cloudinary" />
                <StatCard label="Events"     value={fmtNum(data.totals.event_count)}
                  sub={`${data.totals.error_count} errors`}
                  accent={data.totals.error_count > 0 ? 'text-red-600' : 'text-gray-900'} />
                <StatCard label="Active Clients (30d)"    value={fmtNum(data.totals.active_clients_30d)} sub="logged in" />
                <StatCard label="Total Clients"  value={fmtNum(data.totals.total_clients)} sub="active accounts" />
                <StatCard label="Cost / Active Client"
                  value={data.totals.cost_per_active_client != null ? fmtCost(data.totals.cost_per_active_client) : '—'}
                  sub="in date range" />
                <StatCard label="Cost / Total Client"
                  value={data.totals.cost_per_total_client != null ? fmtCost(data.totals.cost_per_total_client) : '—'}
                  sub="in date range" />
              </div>

              {/* Daily trend + breakdowns */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
                <div className="bg-white rounded-2xl border border-gray-200 p-4">
                  <h3 className="text-sm font-semibold text-gray-800 mb-3">Daily Cost Trend</h3>
                  <TrendChart rows={data.daily_trend} />
                </div>

                <div className="bg-white rounded-2xl border border-gray-200 p-4">
                  <h3 className="text-sm font-semibold text-gray-800 mb-3">Cost by Feature</h3>
                  {data.by_feature.length === 0
                    ? <p className="text-xs text-gray-400 italic">No events in this range</p>
                    : <BarChart rows={data.by_feature} labelKey="feature" valueKey="cost" fmtValue={fmtCost} />
                  }
                </div>

                <div className="bg-white rounded-2xl border border-gray-200 p-4">
                  <h3 className="text-sm font-semibold text-gray-800 mb-3">Cost by Provider</h3>
                  {data.by_provider.length === 0
                    ? <p className="text-xs text-gray-400 italic">No events in this range</p>
                    : <BarChart rows={data.by_provider} labelKey="provider" valueKey="cost" fmtValue={fmtCost} />
                  }
                </div>

                <div className="bg-white rounded-2xl border border-gray-200 p-4">
                  <h3 className="text-sm font-semibold text-gray-800 mb-3">Engagement Summary</h3>
                  {[
                    { key: 'high_usage',      label: 'High Usage',    color: 'bg-emerald-500' },
                    { key: 'moderate',        label: 'Moderate',      color: 'bg-blue-400'    },
                    { key: 'at_risk',         label: 'At Risk',       color: 'bg-amber-400'   },
                    { key: 'inactive',        label: 'Inactive',      color: 'bg-red-400'     },
                    { key: 'never_logged_in', label: 'Never Logged',  color: 'bg-gray-300'    },
                  ].map(({ key, label, color }) => {
                    const count = data.engagement_summary[key] ?? 0
                    const total = Object.values(data.engagement_summary).reduce((a, b) => a + b, 0) || 1
                    return (
                      <div key={key} className="flex items-center gap-2 mb-2">
                        <span className={`w-3 h-3 rounded-full shrink-0 ${color}`} />
                        <span className="text-xs text-gray-700 w-24 shrink-0">{label}</span>
                        <div className="flex-1 bg-gray-100 rounded-full h-1.5">
                          <div className={`h-1.5 rounded-full ${color}`}
                            style={{ width: `${(count / total) * 100}%` }} />
                        </div>
                        <span className="text-xs font-semibold text-gray-700 w-6 text-right">{count}</span>
                      </div>
                    )
                  })}
                </div>
              </div>
            </>
          )}

          {/* ── Clients Tab ──────────────────────────────────────────────── */}
          {tab === 'clients' && (
            <>
              {/* High-cost clients */}
              <div className="bg-white rounded-2xl border border-gray-200 p-4 mb-5">
                <h3 className="text-sm font-semibold text-gray-800 mb-3">
                  High-Cost Clients <span className="text-xs text-gray-400 font-normal">(by total attributed cost)</span>
                </h3>
                {data.high_cost_clients.length === 0 ? (
                  <p className="text-xs text-gray-400 italic">No cost events in this range</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-left text-[11px] text-gray-400 uppercase tracking-wide border-b border-gray-100">
                          <th className="pb-2 pr-4 font-medium">Client</th>
                          <th className="pb-2 pr-4 font-medium text-right">Total Cost</th>
                          <th className="pb-2 pr-4 font-medium text-right">AI Calls</th>
                          <th className="pb-2 font-medium text-right">Uploads</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.high_cost_clients.map((c, i) => (
                          <tr key={i} className="border-b border-gray-50 hover:bg-gray-50">
                            <td className="py-2 pr-4">
                              <p className="font-medium text-gray-800 text-sm">{c.first_name ?? '(unknown)'}</p>
                              <p className="text-[11px] text-gray-400">{c.email ?? `User #${c.user_id}`}</p>
                            </td>
                            <td className="py-2 pr-4 text-right font-semibold text-gray-900">
                              {fmtCost(c.total_cost)}
                            </td>
                            <td className="py-2 pr-4 text-right text-gray-600">{fmtNum(c.ai_calls)}</td>
                            <td className="py-2 text-right text-gray-600">{fmtNum(c.uploads)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {/* Low / no usage clients */}
              <div className="bg-white rounded-2xl border border-gray-200 p-4">
                <h3 className="text-sm font-semibold text-gray-800 mb-3">
                  Low / No Usage Clients
                  <span className="text-xs text-gray-400 font-normal ml-1">(inactive, at-risk, or never logged in)</span>
                </h3>
                {data.low_usage_clients.length === 0 ? (
                  <p className="text-xs text-gray-400 italic">All clients are active 🎉</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-left text-[11px] text-gray-400 uppercase tracking-wide border-b border-gray-100">
                          <th className="pb-2 pr-4 font-medium">Client</th>
                          <th className="pb-2 pr-4 font-medium">Status</th>
                          <th className="pb-2 pr-4 font-medium text-right">Last Login</th>
                          <th className="pb-2 font-medium text-right">Active Days (14d)</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.low_usage_clients.map((c, i) => (
                          <tr key={i} className="border-b border-gray-50 hover:bg-gray-50">
                            <td className="py-2 pr-4">
                              <p className="font-medium text-gray-800 text-sm">{c.first_name ?? '(no name)'}</p>
                              <p className="text-[11px] text-gray-400">{c.email}</p>
                            </td>
                            <td className="py-2 pr-4">{engagementBadge(c.engagement_status)}</td>
                            <td className="py-2 pr-4 text-right text-xs text-gray-500">{relDate(c.last_login_at)}</td>
                            <td className="py-2 text-right text-xs text-gray-500">{c.active_days_14}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </>
          )}

          {/* ── Engagement Tab ───────────────────────────────────────────── */}
          {tab === 'engagement' && (
            <div className="bg-white rounded-2xl border border-gray-200 p-4">
              <h3 className="text-sm font-semibold text-gray-800 mb-3">All Client Engagement</h3>
              <p className="text-[11px] text-gray-400 mb-4">
                Engagement reflects client-initiated activity (meals logged, {aiCoachName} chats).
                Staff-triggered events (bloodwork summaries) do not inflate client engagement status.
              </p>
              {data.engagement_per_client.length === 0 ? (
                <p className="text-xs text-gray-400 italic">No client data</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-[11px] text-gray-400 uppercase tracking-wide border-b border-gray-100">
                        <th className="pb-2 pr-4 font-medium">Client</th>
                        <th className="pb-2 pr-4 font-medium">Status</th>
                        <th className="pb-2 pr-4 font-medium text-right">Meal Days (14d)</th>
                        <th className="pb-2 pr-4 font-medium text-right">Meal Days (30d)</th>
                        <th className="pb-2 pr-4 font-medium text-right">{aiCoachName} Msgs (14d)</th>
                        <th className="pb-2 font-medium text-right">Last Login</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.engagement_per_client.map((c, i) => (
                        <tr key={i} className="border-b border-gray-50 hover:bg-gray-50">
                          <td className="py-2 pr-4">
                            <p className="font-medium text-gray-800">{c.first_name ?? '(no name)'}</p>
                            <p className="text-[11px] text-gray-400">{c.email}</p>
                          </td>
                          <td className="py-2 pr-4">{engagementBadge(c.engagement_status)}</td>
                          <td className="py-2 pr-4 text-right text-sm text-gray-700">{c.active_days_14}</td>
                          <td className="py-2 pr-4 text-right text-sm text-gray-700">{c.active_days_30}</td>
                          <td className="py-2 pr-4 text-right text-sm text-gray-700">{c.katie_msgs_14}</td>
                          <td className="py-2 text-right text-xs text-gray-500">{relDate(c.last_login_at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* ── Events Tab ───────────────────────────────────────────────── */}
          {tab === 'events' && (
            <div className="bg-white rounded-2xl border border-gray-200 p-4">
              <h3 className="text-sm font-semibold text-gray-800 mb-3">Recent Expensive Events</h3>
              {data.recent_events.length === 0 ? (
                <p className="text-xs text-gray-400 italic">No events in this range</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left text-[10px] text-gray-400 uppercase tracking-wide border-b border-gray-100">
                        <th className="pb-2 pr-3 font-medium">Time</th>
                        <th className="pb-2 pr-3 font-medium">Feature</th>
                        <th className="pb-2 pr-3 font-medium">Model</th>
                        <th className="pb-2 pr-3 font-medium text-right">Tokens In</th>
                        <th className="pb-2 pr-3 font-medium text-right">Tokens Out</th>
                        <th className="pb-2 pr-3 font-medium text-right">Cost</th>
                        <th className="pb-2 pr-3 font-medium">Status</th>
                        <th className="pb-2 font-medium">User</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.recent_events.map((e, i) => (
                        <tr key={i} className={`border-b border-gray-50 hover:bg-gray-50 ${e.status === 'error' ? 'bg-red-50' : ''}`}>
                          <td className="py-1.5 pr-3 text-gray-400 whitespace-nowrap">
                            {new Date(e.occurred_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}{' '}
                            {new Date(e.occurred_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                          </td>
                          <td className="py-1.5 pr-3 font-medium text-gray-700">{e.feature}</td>
                          <td className="py-1.5 pr-3 text-gray-500 whitespace-nowrap">
                            {e.model ? e.model.replace('claude-', '').replace('-20', ' \'').replace(/(\d{5})/, '') : '—'}
                          </td>
                          <td className="py-1.5 pr-3 text-right text-gray-600">{fmtNum(e.input_tokens)}</td>
                          <td className="py-1.5 pr-3 text-right text-gray-600">{fmtNum(e.output_tokens)}</td>
                          <td className="py-1.5 pr-3 text-right font-semibold text-gray-800">{fmtCost(e.estimated_cost_usd)}</td>
                          <td className="py-1.5 pr-3">
                            <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                              e.status === 'error'   ? 'bg-red-100 text-red-700'     :
                              e.status === 'timeout' ? 'bg-amber-100 text-amber-700' :
                              'bg-emerald-50 text-emerald-600'
                            }`}>{e.status}</span>
                          </td>
                          <td className="py-1.5 text-gray-500 truncate max-w-[120px]">
                            {e.user_name ?? e.user_email ?? '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}
