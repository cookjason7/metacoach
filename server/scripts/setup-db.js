import 'dotenv/config'
import pg from 'pg'

const { Pool } = pg
const pool = new Pool({ connectionString: process.env.DATABASE_URL })

async function setup() {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    // Drop in reverse FK order so we can re-run cleanly
    await client.query('DROP TABLE IF EXISTS daily_logs CASCADE')
    await client.query('DROP TABLE IF EXISTS meals CASCADE')
    await client.query('DROP TABLE IF EXISTS users CASCADE')

    await client.query(`
      CREATE TABLE users (
        id            SERIAL PRIMARY KEY,
        clerk_user_id TEXT UNIQUE NOT NULL,
        email         TEXT,
        name          TEXT,
        created_at    TIMESTAMPTZ DEFAULT NOW()
      )
    `)

    await client.query(`
      CREATE TABLE meals (
        id          SERIAL PRIMARY KEY,
        user_id     INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        meal_name   TEXT        NOT NULL,
        photo_url   TEXT,
        calories    INTEGER,
        protein     NUMERIC(6,1),
        carbs       NUMERIC(6,1),
        fat         NUMERIC(6,1),
        logged_at   TIMESTAMPTZ DEFAULT NOW()
      )
    `)

    await client.query(`
      CREATE TABLE daily_logs (
        id           SERIAL PRIMARY KEY,
        user_id      INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        water_oz     NUMERIC(6,1),
        steps        INTEGER,
        weight_lbs   NUMERIC(6,1),
        logged_date  DATE        NOT NULL DEFAULT CURRENT_DATE,
        UNIQUE (user_id, logged_date)
      )
    `)

    await client.query('COMMIT')
    console.log('✓ Created tables: users, meals, daily_logs')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
    await pool.end()
  }
}

setup().catch((err) => {
  console.error('Setup failed:', err.message)
  process.exit(1)
})
