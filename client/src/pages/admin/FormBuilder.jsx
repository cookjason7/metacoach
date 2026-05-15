import { useState, useEffect, useCallback, useRef } from 'react'
import { useAuth } from '@clerk/clerk-react'
import { useNavigate, useParams } from 'react-router-dom'
import { API_URL } from '../../config.js'

// ── Constants ─────────────────────────────────────────────────────────────────

const FIELD_TYPES = [
  { value: 'short_text',    label: 'Short Text' },
  { value: 'long_text',     label: 'Long Text' },
  { value: 'number',        label: 'Number' },
  { value: 'date',          label: 'Date' },
  { value: 'rating',        label: 'Rating (1–5)' },
  { value: 'yes_no',        label: 'Yes / No' },
  { value: 'single_choice', label: 'Single Choice' },
  { value: 'multi_choice',  label: 'Multiple Choice' },
]

const STATUS_STYLES = {
  draft:     'bg-gray-100 text-gray-600',
  published: 'bg-emerald-100 text-emerald-700',
  archived:  'bg-amber-100 text-amber-700',
}

function genId() {
  return `f_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
}

function makeField(order) {
  return {
    id:          genId(),
    type:        'short_text',
    label:       '',
    description: '',
    required:    false,
    order,
    options:     ['Option A', 'Option B'],
    max_chars:   null,
  }
}

// ── Field editor (inline, expanded when a field is selected) ──────────────────

function FieldEditor({ field, onChange, onDelete, onMoveUp, onMoveDown, isFirst, isLast }) {
  const [open, setOpen] = useState(!field.label)  // open by default if new

  const needsOptions = field.type === 'single_choice' || field.type === 'multi_choice'

  function update(key, val) { onChange({ ...field, [key]: val }) }

  function addOption() { update('options', [...(field.options ?? []), `Option ${(field.options?.length ?? 0) + 1}`]) }
  function removeOption(i) { update('options', field.options.filter((_, idx) => idx !== i)) }
  function updateOption(i, val) {
    const opts = [...(field.options ?? [])]
    opts[i] = val
    update('options', opts)
  }

  const typeLabel = FIELD_TYPES.find(t => t.value === field.type)?.label ?? field.type

  return (
    <div className={`bg-white border rounded-xl overflow-hidden transition-colors ${open ? 'border-[#E8670A]' : 'border-gray-200'}`}>
      {/* Summary row */}
      <div
        className="flex items-center gap-3 px-4 py-3 cursor-pointer select-none"
        onClick={() => setOpen(o => !o)}
      >
        <div className="flex flex-col gap-1 shrink-0">
          <button
            type="button"
            onClick={e => { e.stopPropagation(); onMoveUp() }}
            disabled={isFirst}
            className="text-gray-300 hover:text-gray-500 disabled:opacity-20 text-xs leading-none"
          >▲</button>
          <button
            type="button"
            onClick={e => { e.stopPropagation(); onMoveDown() }}
            disabled={isLast}
            className="text-gray-300 hover:text-gray-500 disabled:opacity-20 text-xs leading-none"
          >▼</button>
        </div>
        <div className="flex-1 min-w-0">
          <p className={`text-sm font-medium truncate ${field.label ? 'text-gray-900' : 'text-gray-400 italic'}`}>
            {field.label || 'Untitled question'}
          </p>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-[10px] text-gray-400 bg-gray-100 rounded px-1.5 py-0.5 font-medium">{typeLabel}</span>
            {field.required && <span className="text-[10px] text-[#E8670A] font-bold">Required</span>}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0" onClick={e => e.stopPropagation()}>
          <button
            type="button"
            onClick={onDelete}
            className="text-red-400 hover:text-red-600 text-xs font-medium px-2 py-1 rounded hover:bg-red-50 transition-colors"
          >
            Delete
          </button>
          <svg className={`w-4 h-4 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`}
            fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </div>
      </div>

      {/* Expanded editor */}
      {open && (
        <div className="px-4 pb-4 border-t border-gray-100 pt-3 space-y-3">
          {/* Type selector */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-1">Field Type</label>
              <select
                value={field.type}
                onChange={e => update('type', e.target.value)}
                className="w-full border border-gray-200 rounded-lg px-2.5 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]"
              >
                {FIELD_TYPES.map(t => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            </div>
            <div className="flex items-end pb-1">
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <div
                  onClick={() => update('required', !field.required)}
                  className={`w-9 h-5 rounded-full relative transition-colors ${field.required ? 'bg-[#E8670A]' : 'bg-gray-200'}`}
                >
                  <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${field.required ? 'translate-x-4' : 'translate-x-0.5'}`} />
                </div>
                <span className="text-sm text-gray-700 font-medium">Required</span>
              </label>
            </div>
          </div>

          {/* Label */}
          <div>
            <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-1">Question Label *</label>
            <input
              type="text"
              value={field.label}
              onChange={e => update('label', e.target.value)}
              placeholder="e.g. How was your energy this week?"
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]"
            />
          </div>

          {/* Helper text */}
          <div>
            <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-1">Helper Text <span className="text-gray-300 font-normal normal-case">(optional)</span></label>
            <input
              type="text"
              value={field.description}
              onChange={e => update('description', e.target.value)}
              placeholder="Short hint or instruction shown below the question"
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]"
            />
          </div>

          {/* Options for choice fields */}
          {needsOptions && (
            <div>
              <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-1">Options</label>
              <div className="space-y-1.5">
                {(field.options ?? []).map((opt, i) => (
                  <div key={i} className="flex gap-2 items-center">
                    <input
                      type="text"
                      value={opt}
                      onChange={e => updateOption(i, e.target.value)}
                      className="flex-1 border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]"
                    />
                    <button
                      type="button"
                      onClick={() => removeOption(i)}
                      disabled={(field.options?.length ?? 0) <= 1}
                      className="text-red-400 hover:text-red-600 text-sm font-bold disabled:opacity-20"
                    >✕</button>
                  </div>
                ))}
              </div>
              <button
                type="button"
                onClick={addOption}
                className="mt-2 text-xs text-[#E8670A] font-semibold hover:underline"
              >
                + Add option
              </button>
            </div>
          )}

          {/* Max chars for text fields */}
          {(field.type === 'short_text' || field.type === 'long_text') && (
            <div>
              <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-1">Max Characters <span className="text-gray-300 font-normal normal-case">(optional)</span></label>
              <input
                type="number"
                min="1" max="10000"
                value={field.max_chars ?? ''}
                onChange={e => update('max_chars', e.target.value ? Number(e.target.value) : null)}
                placeholder="No limit"
                className="w-32 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]"
              />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Main Component ────────────────────────────────────────────────────────────

export default function FormBuilder() {
  const { getToken } = useAuth()
  const navigate = useNavigate()
  const { id: paramId } = useParams()
  const isNew = !paramId

  const [template,  setTemplate]  = useState(null)
  const [title,     setTitle]     = useState('')
  const [desc,      setDesc]      = useState('')
  const [fields,    setFields]    = useState([])
  const [loading,   setLoading]   = useState(!isNew)
  const [saving,    setSaving]    = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [saveMsg,   setSaveMsg]   = useState('')
  const [error,     setError]     = useState(null)
  const saveTimer = useRef(null)

  // Load existing form
  useEffect(() => {
    if (isNew || !paramId) return
    async function load() {
      try {
        const token = await getToken()
        const res = await fetch(`${API_URL}/api/forms/${paramId}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (!res.ok) throw new Error(`Server ${res.status}`)
        const data = await res.json()
        setTemplate(data)
        setTitle(data.title ?? '')
        setDesc(data.description ?? '')
        setFields(Array.isArray(data.draft_schema) ? data.draft_schema : [])
      } catch (e) { setError(e.message) }
      finally { setLoading(false) }
    }
    load()
  }, [paramId, isNew, getToken])

  // Save (debounced helper)
  const saveNow = useCallback(async (newTitle, newDesc, newFields, quiet = false) => {
    if (!paramId) return
    if (!quiet) setSaving(true)
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/forms/${paramId}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title:       newTitle,
          description: newDesc || null,
          draft_schema: newFields,
        }),
      })
      if (!res.ok) throw new Error('Save failed')
      const updated = await res.json()
      setTemplate(updated)
      setSaveMsg('Saved')
      setTimeout(() => setSaveMsg(''), 2000)
    } catch (e) { setSaveMsg('Save failed') }
    finally { if (!quiet) setSaving(false) }
  }, [paramId, getToken])

  // Debounced auto-save when fields/title/desc change
  function triggerAutoSave(newTitle, newDesc, newFields) {
    if (!paramId) return
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => saveNow(newTitle, newDesc, newFields, true), 1200)
  }

  function updateTitle(v) {
    setTitle(v)
    triggerAutoSave(v, desc, fields)
  }
  function updateDesc(v) {
    setDesc(v)
    triggerAutoSave(title, v, fields)
  }
  function updateFields(newFields) {
    setFields(newFields)
    triggerAutoSave(title, desc, newFields)
  }

  function addField() {
    updateFields([...fields, makeField(fields.length)])
  }

  function updateField(idx, updated) {
    const next = fields.map((f, i) => i === idx ? { ...updated, order: i } : f)
    updateFields(next)
  }

  function deleteField(idx) {
    updateFields(fields.filter((_, i) => i !== idx).map((f, i) => ({ ...f, order: i })))
  }

  function moveField(idx, dir) {
    const next = [...fields]
    const swap = idx + dir
    if (swap < 0 || swap >= next.length) return;
    [next[idx], next[swap]] = [next[swap], next[idx]]
    updateFields(next.map((f, i) => ({ ...f, order: i })))
  }

  async function handleManualSave() {
    clearTimeout(saveTimer.current)
    await saveNow(title, desc, fields)
  }

  async function handlePublish() {
    clearTimeout(saveTimer.current)
    await saveNow(title, desc, fields, true)
    setPublishing(true)
    setError(null)
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/forms/${paramId}/publish`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error ?? 'Publish failed')
      setTemplate(data.template)
      setSaveMsg('Published!')
      setTimeout(() => setSaveMsg(''), 3000)
    } catch (e) { setError(e.message) }
    finally { setPublishing(false) }
  }

  // ── Render: loading ──────────────────────────────────────────────────────────

  if (loading) {
    return <p className="text-center text-gray-400 py-12 text-sm">Loading form…</p>
  }

  // ── Render: main ─────────────────────────────────────────────────────────────

  const status = template?.status ?? 'draft'
  const isArchived = status === 'archived'

  return (
    <div className="max-w-2xl mx-auto pb-10">

      {/* Header */}
      <div className="flex items-center gap-3 mb-5">
        <button
          onClick={() => navigate('/admin/forms')}
          className="p-1.5 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100 transition-colors"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <div className="flex-1 min-w-0">
          <h1 className="text-xl font-bold text-gray-900 truncate">{title || 'Untitled Form'}</h1>
        </div>
        <span className={`text-[10px] font-bold uppercase tracking-wide px-2 py-1 rounded-full ${STATUS_STYLES[status] ?? STATUS_STYLES.draft}`}>
          {status}
        </span>
        {saveMsg && <span className="text-xs text-gray-400">{saveMsg}</span>}
      </div>

      {error && (
        <div className="mb-4 bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      {isArchived && (
        <div className="mb-4 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm text-amber-700">
          This form is archived. It can be viewed but not edited or published.
        </div>
      )}

      {/* Form metadata */}
      <div className="bg-white border border-gray-200 rounded-xl p-4 space-y-3 mb-4">
        <div>
          <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-1">Form Title *</label>
          <input
            type="text"
            value={title}
            onChange={e => updateTitle(e.target.value)}
            disabled={isArchived}
            placeholder="e.g. Weekly Check-In"
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A] disabled:bg-gray-50 disabled:text-gray-400"
          />
        </div>
        <div>
          <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-1">Description <span className="text-gray-300 font-normal normal-case">(shown to client)</span></label>
          <textarea
            value={desc}
            onChange={e => updateDesc(e.target.value)}
            disabled={isArchived}
            placeholder="Optional intro or instructions for the client"
            rows={2}
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A] resize-none disabled:bg-gray-50"
          />
        </div>
      </div>

      {/* Fields */}
      <div className="space-y-3 mb-4">
        {fields.length === 0 ? (
          <div className="bg-gray-50 border border-dashed border-gray-200 rounded-xl p-8 text-center">
            <p className="text-sm text-gray-400 mb-3">No questions yet. Add your first question below.</p>
          </div>
        ) : (
          fields.map((field, idx) => (
            <FieldEditor
              key={field.id}
              field={field}
              onChange={updated => updateField(idx, updated)}
              onDelete={() => deleteField(idx)}
              onMoveUp={() => moveField(idx, -1)}
              onMoveDown={() => moveField(idx, 1)}
              isFirst={idx === 0}
              isLast={idx === fields.length - 1}
            />
          ))
        )}
      </div>

      {/* Add field button */}
      {!isArchived && (
        <button
          type="button"
          onClick={addField}
          className="w-full flex items-center justify-center gap-2 border border-dashed border-gray-300 text-gray-500 hover:border-[#E8670A] hover:text-[#E8670A] font-semibold py-3 rounded-xl text-sm transition-colors mb-6"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
          </svg>
          Add Question
        </button>
      )}

      {/* Action buttons */}
      {!isArchived && paramId && (
        <div className="flex gap-3">
          <button
            type="button"
            onClick={handleManualSave}
            disabled={saving}
            className="flex-1 border border-gray-200 text-gray-700 font-semibold py-3 rounded-xl text-sm hover:bg-gray-50 disabled:opacity-60 transition-colors"
          >
            {saving ? 'Saving…' : 'Save Draft'}
          </button>
          <button
            type="button"
            onClick={handlePublish}
            disabled={publishing || fields.length === 0}
            className="flex-1 bg-[#E8670A] text-white font-bold py-3 rounded-xl text-sm hover:bg-[#c45e09] disabled:opacity-60 transition-colors"
          >
            {publishing
              ? 'Publishing…'
              : status === 'published'
                ? 'Republish (new version)'
                : 'Publish Form'}
          </button>
        </div>
      )}

      {/* Preview link if published */}
      {status === 'published' && (
        <div className="mt-4 text-center">
          <button
            onClick={() => navigate(`/forms/${paramId}/fill`)}
            className="text-sm text-blue-600 hover:underline font-medium"
          >
            Preview as client →
          </button>
        </div>
      )}
    </div>
  )
}
