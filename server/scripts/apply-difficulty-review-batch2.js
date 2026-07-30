/**
 * apply-difficulty-review-batch2.js — applies Jenn's second difficulty review
 * batch to the `exercises` table.
 *
 * Source: server/data/difficulty-review/exercises_175_difficulty_updates.csv
 * (columns: id, name, current_difficulty, target_difficulty, review_note)
 *
 * Rows with target_difficulty = "exclude" are skipped entirely — "exclude"
 * isn't a valid difficulty value and there's no active/excluded column on
 * `exercises` yet to represent it. Only the `difficulty` column is touched.
 *
 * Usage:
 *   node server/scripts/apply-difficulty-review-batch2.js
 */

import 'dotenv/config'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { parse } from 'csv-parse/sync'
import { pool } from '../db.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CSV_PATH = path.join(__dirname, '../data/difficulty-review/exercises_175_difficulty_updates.csv')
const VALID_DIFFICULTIES = new Set(['beginner', 'intermediate', 'advanced'])

async function main() {
  const raw = fs.readFileSync(CSV_PATH, 'utf8')
  const rows = parse(raw, { columns: true, skip_empty_lines: true })

  const excludeRows = rows.filter(r => r.target_difficulty === 'exclude')
  const candidateRows = rows.filter(r => r.target_difficulty !== 'exclude')

  const invalid = candidateRows.filter(r => !VALID_DIFFICULTIES.has(r.target_difficulty))
  if (invalid.length > 0) {
    console.error('Aborting — rows with unrecognized target_difficulty (not beginner/intermediate/advanced/exclude):')
    console.error(invalid.map(r => `  id=${r.id} name="${r.name}" target_difficulty="${r.target_difficulty}"`).join('\n'))
    process.exit(1)
  }

  const ids = candidateRows.map(r => parseInt(r.id, 10))
  const { rows: dbRows } = await pool.query(
    `SELECT id, difficulty FROM exercises WHERE id = ANY($1)`,
    [ids],
  )
  const dbById = new Map(dbRows.map(r => [r.id, r.difficulty]))

  const missing = []
  const noop = []
  const toUpdate = []
  for (const r of candidateRows) {
    const id = parseInt(r.id, 10)
    const current = dbById.get(id)
    if (current === undefined) { missing.push(id); continue }
    if (current === r.target_difficulty) { noop.push(id); continue }
    toUpdate.push({ id, name: r.name, from: current, to: r.target_difficulty })
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    for (const u of toUpdate) {
      await client.query(`UPDATE exercises SET difficulty = $1 WHERE id = $2`, [u.to, u.id])
    }
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }

  console.log('=== Difficulty review batch 2 — summary ===')
  console.log(`Total CSV rows: ${rows.length}`)
  console.log(`Excluded (target_difficulty="exclude", untouched): ${excludeRows.length}`)
  console.log(`No-op (target already matched DB): ${noop.length}`)
  console.log(`Updated: ${toUpdate.length}`)
  console.log(`Ids in CSV not found in exercises table: ${missing.length}${missing.length ? ' -> ' + missing.join(', ') : ''}`)
  if (toUpdate.length > 0) {
    console.log('\nUpdated rows:')
    toUpdate.forEach(u => console.log(`  id=${u.id} "${u.name}": ${u.from} -> ${u.to}`))
  }

  await pool.end()
}

main().catch(err => { console.error('ERROR:', err); process.exit(1) })
