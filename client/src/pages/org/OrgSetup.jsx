// OrgSetup.jsx — org owner/admin self-service settings.
// Rendered at /org/setup, gated by OrgAdminRoute in App.jsx.
import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '@clerk/clerk-react'
import { API_URL } from '../../config.js'

const TABS = [
  { id: 'branding', label: 'Branding' },
  { id: 'ai_coach',  label: 'AI Coach' },
  { id: 'subscription', label: 'Subscription' },
]

const FOCUS_AREAS = [
  { value: 'weight_loss',  label: 'Weight Loss' },
  { value: 'strength',     label: 'Strength' },
  { value: 'nutrition',    label: 'Nutrition' },
  { value: 'mindset',      label: 'Mindset' },
  { value: 'mobility',     label: 'Mobility' },
  { value: 'performance',  label: 'Performance' },
  { value: 'recovery',     label: 'Recovery' },
  { value: 'menopause',    label: 'Menopause' },
  { value: 'self_trust',   label: 'Self-Trust' },
  { value: 'consistency',  label: 'Consistency' },
]

const TIER_LABELS = { starter: 'Starter', pro: 'Pro', enterprise: 'Enterprise' }
const STATUS_LABELS = {
  active: 'Active', trialing: 'Trialing', past_due: 'Past Due', cancelled: 'Cancelled', paused: 'Paused',
}

function fmtDate(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function TabButton({ active, label, onClick }) {
  return (
    <button
      onClick={onClick}
      className={`min-h-11 flex-1 sm:flex-none sm:px-6 rounded-lg text-sm font-semibold transition-colors ${
        active ? 'bg-[#E8670A] text-white' : 'bg-white text-gray-600 border border-gray-200 hover:bg-gray-50'
      }`}
    >
      {label}
    </button>
  )
}

function Field({ label, hint, children }) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-600 mb-1">{label}</label>
      {children}
      {hint && <p className="text-[11px] text-gray-400 mt-1">{hint}</p>}
    </div>
  )
}

const inputCls = 'w-full min-h-11 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]'
const textareaCls = 'w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A] min-h-[88px]'

// ── Branding tab ──────────────────────────────────────────────────────────────

function BrandingTab({ org, onSaved, getToken }) {
  const [form, setForm] = useState({
    name:          org.name ?? '',
    brand_name:    org.brand_name ?? '',
    primary_color: org.primary_color ?? '#f97316',
    logo_url:      org.logo_url ?? '',
  })
  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState(null)
  const [saved,  setSaved]  = useState(false)

  function set(field, val) { setForm(f => ({ ...f, [field]: val })); setSaved(false) }

  async function save() {
    if (!form.name.trim()) { setError('Organization name is required.'); return }
    setSaving(true); setError(null)
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/organizations/mine`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          name:          form.name.trim(),
          brand_name:    form.brand_name.trim() || null,
          primary_color: form.primary_color,
          logo_url:      form.logo_url.trim() || null,
        }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error || 'Failed to save branding')
      onSaved(body)
      setSaved(true)
    } catch (err) { setError(err.message) } finally { setSaving(false) }
  }

  return (
    <div className="space-y-5">
      <Field label="Organization Name *">
        <input type="text" value={form.name} onChange={e => set('name', e.target.value)} className={inputCls} />
      </Field>
      <Field label="Brand Name" hint="How clients see your brand">
        <input type="text" value={form.brand_name} onChange={e => set('brand_name', e.target.value)}
          placeholder="e.g. Peak Performance" className={inputCls} />
      </Field>
      <Field label="Primary Color">
        <div className="flex items-center gap-3">
          <input
            type="color" value={form.primary_color} onChange={e => set('primary_color', e.target.value)}
            className="w-11 h-11 rounded-lg border border-gray-300 cursor-pointer shrink-0"
          />
          <input
            type="text" value={form.primary_color} onChange={e => set('primary_color', e.target.value)}
            placeholder="#f97316" className={`${inputCls} font-mono`}
          />
        </div>
      </Field>
      <Field label="Logo URL" hint="Cloudinary upload coming soon — paste an image URL for now">
        <input type="text" value={form.logo_url} onChange={e => set('logo_url', e.target.value)}
          placeholder="https://…" className={inputCls} />
      </Field>

      {/* Preview */}
      <div>
        <p className="text-xs font-medium text-gray-600 mb-1">Preview</p>
        <div className="rounded-xl border border-gray-200 overflow-hidden">
          <div className="flex items-center gap-3 px-4 py-3" style={{ backgroundColor: '#1e2a3a' }}>
            {form.logo_url ? (
              <img src={form.logo_url} alt="Logo" className="w-8 h-8 rounded object-cover shrink-0" />
            ) : (
              <div
                className="w-8 h-8 rounded shrink-0 flex items-center justify-center text-xs font-bold text-white"
                style={{ backgroundColor: form.primary_color }}
              >
                {(form.brand_name || form.name || '?').charAt(0).toUpperCase()}
              </div>
            )}
            <span className="text-sm font-semibold text-white truncate">{form.brand_name || form.name || 'Your Organization'}</span>
          </div>
          <button
            type="button"
            className="w-full px-4 py-2 text-sm font-semibold text-white"
            style={{ backgroundColor: form.primary_color }}
          >
            Sample Button
          </button>
        </div>
      </div>

      {error && <p className="text-xs text-red-500">{error}</p>}
      {saved && !error && <p className="text-xs text-emerald-600">Saved.</p>}
      <button onClick={save} disabled={saving}
        className="min-h-11 w-full sm:w-auto bg-[#E8670A] text-white px-6 rounded-lg text-sm font-semibold hover:bg-[#c45e09] disabled:opacity-60 transition-colors">
        {saving ? 'Saving…' : 'Save'}
      </button>
    </div>
  )
}

// ── AI Coach tab ──────────────────────────────────────────────────────────────

function AiCoachTab({ aiConfig, onSaved, getToken }) {
  const [form, setForm] = useState({
    coach_name:          aiConfig.coach_name ?? 'Katie',
    coaching_philosophy: aiConfig.coaching_philosophy ?? '',
    tone_instructions:   aiConfig.tone_instructions ?? '',
    custom_greeting:     aiConfig.custom_greeting ?? '',
    focus_areas:         aiConfig.focus_areas ?? [],
    restricted_topics:   aiConfig.restricted_topics ?? [],
  })
  const [restrictedText, setRestrictedText] = useState((aiConfig.restricted_topics ?? []).join(', '))
  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState(null)
  const [saved,  setSaved]  = useState(false)

  function set(field, val) { setForm(f => ({ ...f, [field]: val })); setSaved(false) }

  function toggleFocusArea(value) {
    setForm(f => ({
      ...f,
      focus_areas: f.focus_areas.includes(value)
        ? f.focus_areas.filter(v => v !== value)
        : [...f.focus_areas, value],
    }))
    setSaved(false)
  }

  async function save() {
    setSaving(true); setError(null)
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/organizations/mine/ai-config`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          coach_name:          form.coach_name.trim() || 'Katie',
          coaching_philosophy: form.coaching_philosophy.trim() || null,
          tone_instructions:   form.tone_instructions.trim() || null,
          custom_greeting:     form.custom_greeting.trim() || null,
          focus_areas:         form.focus_areas,
          restricted_topics:   restrictedText.split(',').map(s => s.trim()).filter(Boolean),
        }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error || 'Failed to save AI coach settings')
      onSaved(body)
      setSaved(true)
    } catch (err) { setError(err.message) } finally { setSaving(false) }
  }

  const previewGreeting = form.custom_greeting.trim()
    || `Hey! I'm ${form.coach_name || 'your coach'} — ready to help you hit your goals. What's on your mind today?`

  return (
    <div className="space-y-5">
      <Field label="Coach Name" hint='e.g. "Katie" or "Coach Alex"'>
        <input type="text" value={form.coach_name} onChange={e => set('coach_name', e.target.value)} className={inputCls} />
      </Field>
      <Field label="Coaching Philosophy" hint="Your core methodology — the AI will use this as its foundation">
        <textarea value={form.coaching_philosophy} onChange={e => set('coaching_philosophy', e.target.value)} className={textareaCls} />
      </Field>
      <Field label="Tone Instructions" hint="How should your AI communicate?">
        <textarea value={form.tone_instructions} onChange={e => set('tone_instructions', e.target.value)} className={textareaCls} />
      </Field>
      <Field label="Custom Greeting" hint="How the AI opens conversations">
        <input type="text" value={form.custom_greeting} onChange={e => set('custom_greeting', e.target.value)} className={inputCls} />
      </Field>
      <Field label="Focus Areas">
        <div className="flex flex-wrap gap-2">
          {FOCUS_AREAS.map(({ value, label }) => {
            const active = form.focus_areas.includes(value)
            return (
              <button
                key={value}
                type="button"
                onClick={() => toggleFocusArea(value)}
                className={`min-h-9 px-3 rounded-full text-xs font-semibold border transition-colors ${
                  active
                    ? 'bg-[#E8670A] text-white border-[#E8670A]'
                    : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
                }`}
              >
                {label}
              </button>
            )
          })}
        </div>
      </Field>
      <Field label="Restricted Topics" hint="Topics the AI should avoid — comma separated">
        <textarea value={restrictedText} onChange={e => { setRestrictedText(e.target.value); setSaved(false) }}
          placeholder="e.g. medical diagnoses, medication advice" className={textareaCls} />
      </Field>

      {/* Preview */}
      <div>
        <p className="text-xs font-medium text-gray-600 mb-1">Preview</p>
        <div className="rounded-xl border border-gray-200 bg-gray-50 px-4 py-3">
          <div className="flex items-start gap-2">
            <div className="w-8 h-8 rounded-full bg-[#E8670A] text-white flex items-center justify-center text-xs font-bold shrink-0">
              {(form.coach_name || 'K').charAt(0).toUpperCase()}
            </div>
            <div className="bg-white rounded-xl rounded-tl-none border border-gray-200 px-3 py-2 text-sm text-gray-800 max-w-[85%]">
              {previewGreeting}
            </div>
          </div>
        </div>
      </div>

      {error && <p className="text-xs text-red-500">{error}</p>}
      {saved && !error && <p className="text-xs text-emerald-600">Saved.</p>}
      <button onClick={save} disabled={saving}
        className="min-h-11 w-full sm:w-auto bg-[#E8670A] text-white px-6 rounded-lg text-sm font-semibold hover:bg-[#c45e09] disabled:opacity-60 transition-colors">
        {saving ? 'Saving…' : 'Save'}
      </button>
    </div>
  )
}

// ── Subscription tab ──────────────────────────────────────────────────────────

function SubscriptionTab({ org }) {
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3">
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <p className="text-xs text-gray-500">Current Tier</p>
          <p className="text-lg font-bold text-gray-900 mt-0.5">{TIER_LABELS[org.subscription_tier] ?? org.subscription_tier}</p>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <p className="text-xs text-gray-500">Status</p>
          <p className="text-lg font-bold text-gray-900 mt-0.5">{STATUS_LABELS[org.subscription_status] ?? org.subscription_status}</p>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <p className="text-xs text-gray-500">Client Limit</p>
          <p className="text-lg font-bold text-gray-900 mt-0.5">{org.client_count} / {org.max_clients}</p>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <p className="text-xs text-gray-500">Coaches</p>
          <p className="text-lg font-bold text-gray-900 mt-0.5">{org.coach_count}</p>
        </div>
      </div>

      {org.trial_ends_at && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl px-4 py-3">
          <p className="text-sm text-blue-800">Trial ends <strong>{fmtDate(org.trial_ends_at)}</strong></p>
        </div>
      )}

      <div className="bg-orange-50 border border-orange-200 rounded-xl px-4 py-3">
        <p className="text-sm text-[#c45e09]">
          Want to upgrade your plan or add more client seats?{' '}
          <a href="mailto:jason@lwcvip.com" className="font-semibold underline">
            Contact Life Warrior Coaching
          </a>
        </p>
      </div>
    </div>
  )
}

// ── Main page ────────────────────────────────────────────────────────────────

export default function OrgSetup() {
  const { getToken } = useAuth()

  const [tab,      setTab]      = useState('branding')
  const [org,      setOrg]      = useState(null)
  const [aiConfig, setAiConfig] = useState(null)
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState(null)

  const load = useCallback(async () => {
    try {
      const token = await getToken()
      const headers = { Authorization: `Bearer ${token}` }
      const [orgRes, aiRes] = await Promise.all([
        fetch(`${API_URL}/api/organizations/mine`,           { headers }),
        fetch(`${API_URL}/api/organizations/mine/ai-config`, { headers }),
      ])
      if (!orgRes.ok) throw new Error('Failed to load your organization')
      setOrg(await orgRes.json())
      setAiConfig(aiRes.ok ? await aiRes.json() : {})
    } catch (err) { setError(err.message) } finally { setLoading(false) }
  }, [getToken])

  useEffect(() => { load() }, [load])

  if (loading) return <p className="text-sm text-gray-400 text-center py-12">Loading…</p>
  if (error)   return <p className="text-sm text-red-500 py-4">{error}</p>

  return (
    <div className="max-w-3xl mx-auto">
      <div className="mb-5">
        <h1 className="text-xl font-bold text-gray-900">Organization Setup</h1>
        <p className="text-sm text-gray-500 mt-0.5">Branding, AI coach configuration, and subscription</p>
      </div>

      <div className="flex gap-2 mb-5">
        {TABS.map(t => (
          <TabButton key={t.id} active={tab === t.id} label={t.label} onClick={() => setTab(t.id)} />
        ))}
      </div>

      <div className="bg-white rounded-2xl border border-gray-200 p-4 sm:p-6">
        {tab === 'branding'     && <BrandingTab org={org} onSaved={setOrg} getToken={getToken} />}
        {tab === 'ai_coach'     && <AiCoachTab aiConfig={aiConfig} onSaved={setAiConfig} getToken={getToken} />}
        {tab === 'subscription' && <SubscriptionTab org={org} />}
      </div>
    </div>
  )
}
