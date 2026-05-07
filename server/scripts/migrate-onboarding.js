import 'dotenv/config'
import pg from 'pg'

const { Pool } = pg
const pool = new Pool({ connectionString: process.env.DATABASE_URL })

async function run() {
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_complete BOOLEAN DEFAULT false`)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS first_name TEXT`)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS age INTEGER`)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS starting_weight_lbs NUMERIC(6,1)`)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS goal_weight_lbs NUMERIC(6,1)`)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS activity_level TEXT`)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS tried_before TEXT`)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS why_joined TEXT`)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS identity_anchors TEXT[]`)
  console.log('✓ Onboarding columns added to users table')
  await pool.end()
}

run().catch((err) => { console.error(err.message); process.exit(1) })
