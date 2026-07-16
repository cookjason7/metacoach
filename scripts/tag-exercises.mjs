/**
 * scripts/tag-exercises.mjs
 *
 * Standalone script — auto-tags exercises.contraindication_tags on STAGING using
 * Claude. Does not import from the app; connects directly via `pg` and calls
 * the Anthropic API directly via `@anthropic-ai/sdk`.
 *
 * DATABASE_URL must point to the staging database. This script does not verify
 * environment — pass the correct staging DATABASE_URL explicitly when invoking:
 *
 *   DATABASE_URL=<staging-url> node scripts/tag-exercises.mjs
 *
 * Processes exercises in batches of 20, asking Claude to assign contraindication
 * tags from a fixed approved list. Any batch that fails to parse is logged and
 * skipped (not retried) so one bad batch never crashes the whole run.
 */

import 'dotenv/config'
import pg from 'pg'
import Anthropic from '@anthropic-ai/sdk'

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
const anthropic = new Anthropic()

const BATCH_SIZE = 20

const APPROVED_TAGS = [
  'knee', 'lower_back', 'shoulder', 'hip', 'ankle', 'wrist', 'neck',
  'osteoporosis', 'high_blood_pressure', 'pregnancy', 'pelvic_floor',
  'balance', 'vertigo', 'elbow',
]

const SYSTEM_PROMPT = `You are a certified strength and conditioning specialist assigning safety contraindication tags to exercises for a women's fitness app (ages 40-55). Be conservative — when in doubt, add a tag.`

function buildUserPrompt(batch) {
  const exerciseLines = batch.map(ex =>
    `id: ${ex.id}, name: "${ex.name}", movement_pattern: "${ex.movement_pattern}", equipment: "${ex.equipment ?? 'none'}"`
  ).join('\n')

  return `For each exercise below, return a JSON array of contraindication tags from ONLY this approved list:
["knee","lower_back","shoulder","hip","ankle","wrist","neck","osteoporosis","high_blood_pressure","pregnancy","pelvic_floor","balance","vertigo","elbow"]

Rules:
- Only use tags from the approved list above
- An empty array [] means the exercise is safe for all conditions
- Be conservative: if an exercise puts stress on a joint, tag it
- knee: any exercise with deep knee bend, impact landing, or knee-dominant load
- lower_back: any exercise with spinal load, forward hinge under load, or lumbar flexion
- shoulder: any overhead movement, pressing, or rotator cuff stress
- hip: any exercise with deep hip flexion or hip-dominant load
- ankle: any jump, hop, single-leg balance, or ankle-loaded movement
- wrist: any exercise with wrist extension under load (push-up, plank variations)
- neck: any exercise with cervical load or head position stress
- osteoporosis: high-impact, spinal flexion, or heavy axial loading
- high_blood_pressure: high-intensity or inverted positions
- pregnancy: prone positions, supine after first trimester, high impact, heavy valsalva
- pelvic_floor: high impact, heavy intra-abdominal pressure, jumping
- balance: single-leg, unstable surface, or dynamic balance requirements
- vertigo: any head position change, inversion, or balance-dependent movement
- elbow: any exercise with elbow flexion/extension under load

Return ONLY a valid JSON object, no markdown, no extra text:
{
  "results": [
    {"id": <exercise_id>, "tags": ["tag1", "tag2"]},
    ...
  ]
}

Exercises:
${exerciseLines}`
}

function extractJsonText(rawText) {
  let text = rawText.trim()
  const fence = text.match(/```(?:json)?\n?([\s\S]+?)\n?```/)
  if (fence) text = fence[1]
  return text
}

function validateTags(tags) {
  if (!Array.isArray(tags)) return null
  const filtered = tags.filter(t => APPROVED_TAGS.includes(t))
  return [...new Set(filtered)]
}

async function tagBatch(batch) {
  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: buildUserPrompt(batch) }],
  })
  const rawText = message.content[0].text
  const jsonText = extractJsonText(rawText)
  const parsed = JSON.parse(jsonText)
  if (!Array.isArray(parsed.results)) {
    throw new Error('Response missing "results" array')
  }
  return parsed.results
}

async function run() {
  const { rows: exercises } = await pool.query(
    `SELECT id, name, movement_pattern, equipment FROM exercises WHERE contraindication_tags = '{}' ORDER BY id`
  )

  console.log(`Found ${exercises.length} exercises needing contraindication tags.`)

  const batches = []
  for (let i = 0; i < exercises.length; i += BATCH_SIZE) {
    batches.push(exercises.slice(i, i + BATCH_SIZE))
  }

  let totalTagged = 0
  let totalSkipped = 0

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i]
    const batchNum = i + 1
    try {
      const results = await tagBatch(batch)
      const idsInBatch = new Set(batch.map(ex => ex.id))
      let taggedInBatch = 0

      for (const result of results) {
        if (!idsInBatch.has(result.id)) continue
        const tags = validateTags(result.tags)
        if (tags === null) {
          console.warn(`  [batch ${batchNum}] Skipping exercise id=${result.id} — invalid tags shape: ${JSON.stringify(result.tags)}`)
          continue
        }
        await pool.query('UPDATE exercises SET contraindication_tags = $1 WHERE id = $2', [tags, result.id])
        taggedInBatch++
      }

      totalTagged += taggedInBatch
      console.log(`Batch ${batchNum}/${batches.length} complete — tagged ${taggedInBatch} exercises`)
    } catch (err) {
      totalSkipped += batch.length
      console.error(`Batch ${batchNum}/${batches.length} FAILED — skipping (${batch.length} exercises untagged): ${err.message}`)
    }
  }

  console.log('\n=== Summary ===')
  console.log(`Total tagged:  ${totalTagged}`)
  console.log(`Total skipped: ${totalSkipped}`)

  await pool.end()
}

run().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
