import Anthropic from '@anthropic-ai/sdk'

const anthropic = new Anthropic()

const SUPPORTED_TYPES = new Set([
  'short_text', 'long_text', 'number', 'date',
  'rating', 'yes_no', 'single_choice', 'multi_choice',
])

// Fields the platform already knows about — skip on import
const IDENTITY_PATTERNS = [
  'first name', 'last name', 'email', 'email address',
  'full name', 'your name', 'name', 'phone', 'phone number',
]

function isIdentityField(label) {
  const lower = (label ?? '').toLowerCase().trim()
  return IDENTITY_PATTERNS.some(p =>
    lower === p || lower === `your ${p}` || lower === `client ${p}`,
  )
}

function genFieldId(index) {
  return `f_${Date.now()}_${index}_${Math.random().toString(36).slice(2, 5)}`
}

function validateAndNormalize(aiResult) {
  const title = aiResult.title?.trim()
  if (!title) {
    const err = new Error('AI could not determine a form title from the provided text.')
    err.status = 422
    throw err
  }

  let fields = Array.isArray(aiResult.fields) ? aiResult.fields : []

  // Filter identity fields
  fields = fields.filter(f => !isIdentityField(f.label ?? ''))

  if (fields.length === 0) {
    const err = new Error('No coaching questions found after filtering identity fields. Add specific questions before importing.')
    err.status = 422
    throw err
  }

  const normalized = []
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i]
    const label = f.label?.trim()
    if (!label) continue

    let type = f.type
    if (!SUPPORTED_TYPES.has(type)) type = 'short_text'

    const isChoice = type === 'single_choice' || type === 'multi_choice'
    let options = Array.isArray(f.options)
      ? f.options.map(o => String(o).trim()).filter(Boolean)
      : []

    // Choice fields need at least 2 options — demote to short_text if not enough
    if (isChoice && options.length < 2) {
      type = 'short_text'
      options = []
    }

    let max_chars = null
    if (f.max_chars != null) {
      const mc = Number(f.max_chars)
      if (Number.isFinite(mc) && mc > 0) max_chars = Math.round(mc)
    }

    normalized.push({
      id:          genFieldId(i),
      type,
      label,
      description: String(f.description ?? '').trim(),
      required:    typeof f.required === 'boolean' ? f.required : false,
      options:     isChoice ? options : [],
      max_chars,
      order:       normalized.length,
    })
  }

  if (normalized.length === 0) {
    const err = new Error('AI could not extract any valid fields from the provided text. Try reformatting the input.')
    err.status = 422
    throw err
  }

  return {
    title,
    description: aiResult.description?.trim() || null,
    fields:      normalized,
  }
}

export async function parseFormWithAI(rawText) {
  const response = await anthropic.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 4096,
    system: `You are a form parser for a health and fitness coaching platform. Given raw form text pasted from any source (PDF, Google Form, Word doc, etc.), extract a clean structured schema.

Field type selection rules:
- short_text: brief open answer, single-line text, "Your answer" placeholder
- long_text: paragraph responses, narrative/journal answers, or text fields with max > 200 chars
- number: weight, steps, hours slept, numeric values
- date: date pickers or "what date" questions
- rating: 1–5 scale questions (energy, sleep, stress, mood, confidence, etc.)
- yes_no: exactly two choices Yes/No, True/False, or similar binary
- single_choice: pick exactly one from a list of options (including numeric ranges like 0–10)
- multi_choice: "select all that apply", "which days", multiple-select, checkboxes

Additional parsing rules:
- Numeric ranges like 0–10 → single_choice with options ["0","1","2","3","4","5","6","7","8","9","10"]
- A list of items directly under a question → those items become the question's options
- Questions marked with * or labeled "required" → required: true
- "Max: N chars" or "Maximum N characters" in instructions → max_chars: N
- Instruction text or helper text under a question → description field
- Skip identity-only fields: first name, last name, email address, phone number — the platform already knows these
- Infer a clear, concise title from the heading or overall document content`,
    tools: [{
      name:        'create_form_schema',
      description: 'Output the complete parsed form schema',
      input_schema: {
        type:     'object',
        required: ['title', 'fields'],
        properties: {
          title: {
            type:        'string',
            description: 'Concise form title inferred from the heading or content',
          },
          description: {
            type:        'string',
            description: 'Optional form description or top-level instructions',
          },
          fields: {
            type:  'array',
            items: {
              type:     'object',
              required: ['label', 'type', 'required'],
              properties: {
                label: {
                  type:        'string',
                  description: 'The question text shown to the client',
                },
                type: {
                  type: 'string',
                  enum: ['short_text', 'long_text', 'number', 'date', 'rating', 'yes_no', 'single_choice', 'multi_choice'],
                },
                description: {
                  type:        'string',
                  description: 'Helper or instruction text displayed under the question',
                },
                required: {
                  type:        'boolean',
                  description: 'True if the question is marked required or has an asterisk',
                },
                options: {
                  type:        'array',
                  items:       { type: 'string' },
                  description: 'Answer choices for single_choice and multi_choice fields',
                },
                max_chars: {
                  type:        'number',
                  description: 'Maximum character limit for text fields, if specified',
                },
              },
            },
          },
        },
      },
    }],
    tool_choice: { type: 'tool', name: 'create_form_schema' },
    messages: [{ role: 'user', content: rawText.slice(0, 15000) }],
  })

  const toolBlock = response.content.find(b => b.type === 'tool_use')
  if (!toolBlock?.input) {
    const err = new Error('AI did not return a structured form. Try simplifying or reformatting the input text.')
    err.status = 422
    throw err
  }

  return validateAndNormalize(toolBlock.input)
}
