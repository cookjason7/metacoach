import { useState, useEffect, useRef } from 'react'
import { useAuth } from '@clerk/clerk-react'
import { useParams, useNavigate } from 'react-router-dom'
import { API_URL } from '../config.js'

// ── Field renderers ───────────────────────────────────────────────────────────

function RatingField({ field, value, onChange }) {
  return (
    <div className="flex gap-2 flex-wrap">
      {[1, 2, 3, 4, 5].map(n => (
        <button
          key={n}
          type="button"
          onClick={() => onChange(n)}
          className={`w-11 h-11 rounded-xl text-sm font-bold border-2 transition-all ${
            value === n
              ? 'bg-[#E8670A] border-[#E8670A] text-white shadow-sm'
              : 'bg-white border-gray-200 text-gray-600 hover:border-[#E8670A] hover:text-[#E8670A]'
          }`}
        >
          {n}
        </button>
      ))}
    </div>
  )
}

function YesNoField({ value, onChange }) {
  return (
    <div className="flex gap-3">
      {['Yes', 'No'].map(opt => (
        <button
          key={opt}
          type="button"
          onClick={() => onChange(opt)}
          className={`flex-1 h-11 rounded-xl text-sm font-bold border-2 transition-all ${
            value === opt
              ? 'bg-[#E8670A] border-[#E8670A] text-white'
              : 'bg-white border-gray-200 text-gray-600 hover:border-[#E8670A] hover:text-[#E8670A]'
          }`}
        >
          {opt}
        </button>
      ))}
    </div>
  )
}

function SingleChoiceField({ field, value, onChange }) {
  const options = field.options ?? []
  return (
    <div className="space-y-2">
      {options.map(opt => (
        <button
          key={opt}
          type="button"
          onClick={() => onChange(opt)}
          className={`w-full text-left px-4 py-3 rounded-xl text-sm font-medium border-2 transition-all ${
            value === opt
              ? 'bg-[#E8670A] border-[#E8670A] text-white'
              : 'bg-white border-gray-200 text-gray-700 hover:border-[#E8670A]/50'
          }`}
        >
          {opt}
        </button>
      ))}
    </div>
  )
}

function MultiChoiceField({ field, value, onChange }) {
  const options = field.options ?? []
  const selected = Array.isArray(value) ? value : []

  function toggle(opt) {
    if (selected.includes(opt)) {
      onChange(selected.filter(o => o !== opt))
    } else {
      onChange([...selected, opt])
    }
  }

  return (
    <div className="space-y-2">
      {options.map(opt => {
        const active = selected.includes(opt)
        return (
          <button
            key={opt}
            type="button"
            onClick={() => toggle(opt)}
            className={`w-full text-left px-4 py-3 rounded-xl text-sm font-medium border-2 transition-all ${
              active
                ? 'bg-[#E8670A] border-[#E8670A] text-white'
                : 'bg-white border-gray-200 text-gray-700 hover:border-[#E8670A]/50'
            }`}
          >
            <span className={`inline-flex items-center justify-center w-5 h-5 rounded border-2 mr-2 flex-shrink-0 align-middle ${
              active ? 'bg-white/30 border-white' : 'border-gray-300'
            }`}>
              {active && (
                <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="3" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              )}
            </span>
            {opt}
          </button>
        )
      })}
    </div>
  )
}

function FieldInput({ field, value, onChange }) {
  const base = 'w-full border-2 border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-[#E8670A] transition-colors'

  switch (field.type) {
    case 'rating':
      return <RatingField field={field} value={value} onChange={onChange} />
    case 'yes_no':
      return <YesNoField value={value} onChange={onChange} />
    case 'single_choice':
      return <SingleChoiceField field={field} value={value} onChange={onChange} />
    case 'multi_choice':
      return <MultiChoiceField field={field} value={value} onChange={onChange} />
    case 'long_text':
      return (
        <textarea
          value={value ?? ''}
          onChange={e => onChange(e.target.value)}
          rows={4}
          maxLength={field.max_chars || undefined}
          placeholder={field.description || ''}
          className={`${base} resize-none`}
        />
      )
    case 'number':
      return (
        <input
          type="number"
          value={value ?? ''}
          onChange={e => onChange(e.target.value === '' ? '' : Number(e.target.value))}
          placeholder={field.description || ''}
          className={base}
        />
      )
    case 'date':
      return (
        <input
          type="date"
          value={value ?? ''}
          onChange={e => onChange(e.target.value)}
          className={base}
        />
      )
    default: // short_text
      return (
        <input
          type="text"
          value={value ?? ''}
          onChange={e => onChange(e.target.value)}
          maxLength={field.max_chars || undefined}
          placeholder={field.description || ''}
          className={base}
        />
      )
  }
}

// ── Main Component ────────────────────────────────────────────────────────────

export default function FormFill() {
  const { getToken } = useAuth()
  const { id } = useParams()
  const navigate = useNavigate()

  const [form, setForm]       = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState(null)
  const [answers, setAnswers] = useState({})
  const [fieldErrors, setFieldErrors] = useState({})
  const [submitting, setSubmitting]   = useState(false)
  const [submitted, setSubmitted]     = useState(false)
  const submittedRef = useRef(false)

  useEffect(() => {
    async function load() {
      try {
        const token = await getToken()
        const res = await fetch(`${API_URL}/api/forms/${id}/fill`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (!res.ok) {
          const d = await res.json().catch(() => ({}))
          throw new Error(d.error ?? `Error ${res.status}`)
        }
        setForm(await res.json())
      } catch (e) {
        setError(e.message)
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [id, getToken])

  function setAnswer(fieldId, value) {
    setAnswers(prev => ({ ...prev, [fieldId]: value }))
    setFieldErrors(prev => {
      if (!prev[fieldId]) return prev
      const next = { ...prev }
      delete next[fieldId]
      return next
    })
  }

  async function handleSubmit(e) {
    e.preventDefault()
    if (submittedRef.current) return
    const schema = form?.schema ?? []

    // Client-side required validation
    const errors = {}
    for (const field of schema) {
      if (!field.required) continue
      const val = answers[field.id]
      const empty =
        val === undefined || val === null || val === '' ||
        (Array.isArray(val) && val.length === 0)
      if (empty) errors[field.id] = 'This field is required.'
    }
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors)
      // Scroll to first error
      const firstId = Object.keys(errors)[0]
      document.getElementById(`field-${firstId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      return
    }

    submittedRef.current = true
    setSubmitting(true)
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/forms/${id}/submit`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ answers }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error ?? 'Submission failed')
      }
      setSubmitted(true)
    } catch (e) {
      submittedRef.current = false
      setError(e.message)
    } finally {
      setSubmitting(false)
    }
  }

  // ── Success screen ──
  if (submitted) {
    return (
      <div className="min-h-[60vh] flex flex-col items-center justify-center px-4 text-center">
        <div className="w-16 h-16 bg-emerald-100 rounded-full flex items-center justify-center mb-4">
          <svg className="w-8 h-8 text-emerald-600" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <h2 className="text-xl font-bold text-gray-900 mb-2">Submitted!</h2>
        <p className="text-sm text-gray-500 mb-6">Thanks for completing "{form?.title}".</p>
        <button
          onClick={() => navigate('/dashboard')}
          className="bg-[#E8670A] text-white font-bold px-6 py-3 rounded-xl text-sm hover:bg-[#c45e09] transition-colors"
        >
          Back to Dashboard
        </button>
      </div>
    )
  }

  if (loading) {
    return <p className="text-center text-gray-400 py-16 text-sm">Loading form…</p>
  }

  if (error) {
    return (
      <div className="text-center py-16 px-4">
        <p className="text-red-500 text-sm mb-4">{error}</p>
        <button onClick={() => navigate('/dashboard')} className="text-sm text-[#E8670A] font-semibold hover:underline">
          ← Back to Dashboard
        </button>
      </div>
    )
  }

  const schema = form?.schema ?? []

  return (
    <div className="max-w-xl mx-auto pb-12">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">{form.title}</h1>
        {form.description && <p className="text-sm text-gray-500 mt-1">{form.description}</p>}
      </div>

      {/* Global error */}
      {error && (
        <div className="mb-4 bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-600">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-6" noValidate>
        {schema.map((field, idx) => (
          <div
            key={field.id}
            id={`field-${field.id}`}
            className={`bg-white rounded-2xl border p-5 transition-colors ${
              fieldErrors[field.id] ? 'border-red-300 bg-red-50/30' : 'border-gray-200'
            }`}
          >
            <label className="block mb-3">
              <span className="text-sm font-bold text-gray-900">
                {idx + 1}. {field.label}
                {field.required && <span className="text-red-500 ml-1">*</span>}
              </span>
              {field.description && (
                <span className="block text-xs text-gray-500 mt-0.5">{field.description}</span>
              )}
            </label>

            <FieldInput
              field={field}
              value={answers[field.id]}
              onChange={val => setAnswer(field.id, val)}
            />

            {fieldErrors[field.id] && (
              <p className="mt-2 text-xs text-red-500 font-medium">{fieldErrors[field.id]}</p>
            )}
          </div>
        ))}

        {schema.length === 0 && (
          <p className="text-center text-gray-400 py-8 text-sm">This form has no questions.</p>
        )}

        {schema.length > 0 && (
          <button
            type="submit"
            disabled={submitting}
            className="w-full bg-[#E8670A] text-white font-bold py-4 rounded-2xl text-base hover:bg-[#c45e09] disabled:opacity-60 transition-colors"
          >
            {submitting ? 'Submitting…' : 'Submit Form'}
          </button>
        )}
      </form>
    </div>
  )
}
