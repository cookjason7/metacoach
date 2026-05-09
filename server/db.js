import pg from 'pg'

const { Pool } = pg

export const pool = new Pool({ connectionString: process.env.DATABASE_URL })

export async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            SERIAL PRIMARY KEY,
      clerk_user_id TEXT UNIQUE NOT NULL,
      email         TEXT,
      name          TEXT,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS meals (
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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS daily_logs (
      id           SERIAL PRIMARY KEY,
      user_id      INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      water_oz     NUMERIC(6,1),
      steps        INTEGER,
      weight_lbs   NUMERIC(6,1),
      logged_date  DATE        NOT NULL DEFAULT CURRENT_DATE,
      UNIQUE (user_id, logged_date)
    )
  `)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coaching_conversations (
      id         SERIAL PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role       TEXT    NOT NULL CHECK (role IN ('user', 'assistant')),
      message    TEXT    NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `)
  await pool.query(`ALTER TABLE meals ADD COLUMN IF NOT EXISTS fiber NUMERIC(6,1)`)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS community_posts (
      id         SERIAL PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      content    TEXT    NOT NULL,
      photo_url  TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS post_likes (
      id         SERIAL PRIMARY KEY,
      post_id    INTEGER NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (post_id, user_id)
    )
  `)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS post_comments (
      id         SERIAL PRIMARY KEY,
      post_id    INTEGER NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      content    TEXT    NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS post_reactions (
      id            SERIAL PRIMARY KEY,
      post_id       INTEGER NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE,
      user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      reaction_type VARCHAR(10) NOT NULL CHECK (reaction_type IN ('like', 'love', 'laugh')),
      created_at    TIMESTAMP DEFAULT NOW(),
      UNIQUE(post_id, user_id, reaction_type)
    )
  `)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS comment_reactions (
      id            SERIAL PRIMARY KEY,
      comment_id    INTEGER NOT NULL REFERENCES post_comments(id) ON DELETE CASCADE,
      user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      reaction_type TEXT    NOT NULL CHECK (reaction_type IN ('like', 'love', 'laugh')),
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (comment_id, user_id, reaction_type)
    )
  `)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS paid BOOLEAN DEFAULT FALSE`)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS goal_calories INTEGER`)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS goal_protein  INTEGER`)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS goal_carbs    INTEGER`)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS goal_fat      INTEGER`)
  await pool.query(`ALTER TABLE meals ADD COLUMN IF NOT EXISTS portion_notes TEXT`)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS gender       TEXT`)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_number TEXT`)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS role         TEXT DEFAULT 'client'`)
  await pool.query(`ALTER TABLE community_posts ADD COLUMN IF NOT EXISTS category TEXT`)
  await pool.query(`ALTER TABLE community_posts ADD COLUMN IF NOT EXISTS pinned   BOOLEAN DEFAULT FALSE`)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS notifications (
      id           SERIAL PRIMARY KEY,
      user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type         TEXT NOT NULL CHECK (type IN ('comment', 'mention')),
      post_id      INTEGER REFERENCES community_posts(id) ON DELETE CASCADE,
      from_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      read         BOOLEAN DEFAULT FALSE,
      created_at   TIMESTAMPTZ DEFAULT NOW()
    )
  `)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS community_polls (
      id         SERIAL PRIMARY KEY,
      post_id    INTEGER NOT NULL UNIQUE REFERENCES community_posts(id) ON DELETE CASCADE,
      question   TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS poll_options (
      id            SERIAL PRIMARY KEY,
      poll_id       INTEGER NOT NULL REFERENCES community_polls(id) ON DELETE CASCADE,
      option_text   TEXT NOT NULL,
      display_order INTEGER NOT NULL DEFAULT 0
    )
  `)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS poll_votes (
      id         SERIAL PRIMARY KEY,
      poll_id    INTEGER NOT NULL REFERENCES community_polls(id) ON DELETE CASCADE,
      option_id  INTEGER NOT NULL REFERENCES poll_options(id) ON DELETE CASCADE,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (poll_id, user_id)
    )
  `)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS progress_photos (
      id         SERIAL PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      photo_url  TEXT    NOT NULL,
      angle      TEXT    NOT NULL CHECK (angle IN ('front', 'back', 'side')),
      taken_at   TIMESTAMPTZ DEFAULT NOW()
    )
  `)

  // ── Food database ────────────────────────────────────────────────────────────

  // pg_trgm enables fuzzy/similarity matching (e.g. "bannana" → "banana")
  await pool.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`)

  // Core food records — one row per food item from USDA or user-added entries.
  // calories and all nutrient amounts are stored per 100g for consistent scaling.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS foods (
      id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      fdc_id            INTEGER     UNIQUE,
      name              TEXT        NOT NULL,
      data_type         TEXT        NOT NULL CHECK (data_type IN ('SR Legacy', 'Foundation', 'Branded', 'Custom')),
      serving_size      NUMERIC(8,2),
      serving_size_unit TEXT,
      calories          NUMERIC(8,2),
      search_vector     TSVECTOR,
      created_at        TIMESTAMPTZ DEFAULT NOW()
    )
  `)

  // GIN index: powers fast full-text search across the full foods table
  await pool.query(`
    CREATE INDEX IF NOT EXISTS foods_search_vector_idx
    ON foods USING GIN (search_vector)
  `)

  // GIN trigram index: powers fuzzy/prefix matching on the raw name string
  await pool.query(`
    CREATE INDEX IF NOT EXISTS foods_name_trgm_idx
    ON foods USING GIN (name gin_trgm_ops)
  `)

  // Nutrient definitions keyed to USDA's nutrient ID system.
  // Examples: 1003 = Protein (g), 1004 = Total Fat (g), 1005 = Carbohydrates (g),
  //           1079 = Fiber (g), 1008 = Energy (kcal), 1093 = Sodium (mg)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS nutrients (
      id              SERIAL  PRIMARY KEY,
      fdc_nutrient_id INTEGER UNIQUE,
      name            TEXT    NOT NULL,
      unit_name       TEXT    NOT NULL
    )
  `)

  // Join table: maps each food to its per-100g nutrient amounts.
  // Composite PK enforces one amount per food+nutrient pair.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS food_nutrients (
      food_id     UUID    NOT NULL REFERENCES foods(id)     ON DELETE CASCADE,
      nutrient_id INTEGER NOT NULL REFERENCES nutrients(id) ON DELETE CASCADE,
      amount      NUMERIC(10,3) NOT NULL,
      PRIMARY KEY (food_id, nutrient_id)
    )
  `)

  await pool.query(`
    CREATE INDEX IF NOT EXISTS food_nutrients_food_idx
    ON food_nutrients (food_id)
  `)

  // Trigger function: rebuilds search_vector from the food name on every
  // insert or name update, so we never have to maintain it manually.
  await pool.query(`
    CREATE OR REPLACE FUNCTION update_food_search_vector()
    RETURNS trigger AS $$
    BEGIN
      NEW.search_vector := to_tsvector('english', coalesce(NEW.name, ''));
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `)

  // Create the trigger only if it doesn't already exist — safe for repeated
  // migrate() calls since CREATE OR REPLACE TRIGGER needs PostgreSQL 14+.
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        WHERE t.tgname = 'food_search_vector_trigger'
          AND c.relname = 'foods'
      ) THEN
        CREATE TRIGGER food_search_vector_trigger
          BEFORE INSERT OR UPDATE OF name ON foods
          FOR EACH ROW EXECUTE FUNCTION update_food_search_vector();
      END IF;
    END;
    $$
  `)

  // ── Meal slot & phase ────────────────────────────────────────────────────────
  await pool.query(`ALTER TABLE meals ADD COLUMN IF NOT EXISTS meal_slot TEXT`)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS program_phase INTEGER DEFAULT 1`)

  // ── Recipes ──────────────────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS recipes (
      id         SERIAL PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name       TEXT NOT NULL,
      servings   NUMERIC(6,1) NOT NULL DEFAULT 1,
      calories   NUMERIC(8,1),
      protein    NUMERIC(6,1),
      carbs      NUMERIC(6,1),
      fat        NUMERIC(6,1),
      fiber      NUMERIC(6,1),
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS recipe_ingredients (
      id         SERIAL PRIMARY KEY,
      recipe_id  INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
      food_name  TEXT NOT NULL,
      calories   NUMERIC(8,1),
      protein    NUMERIC(6,1),
      carbs      NUMERIC(6,1),
      fat        NUMERIC(6,1),
      fiber      NUMERIC(6,1),
      amount     NUMERIC(8,2),
      unit       TEXT
    )
  `)

  // ── Workouts ─────────────────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS workouts (
      id          SERIAL PRIMARY KEY,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name        TEXT NOT NULL,
      description TEXT,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS workout_exercises (
      id            SERIAL PRIMARY KEY,
      workout_id    INTEGER NOT NULL REFERENCES workouts(id) ON DELETE CASCADE,
      day           TEXT NOT NULL,
      exercise_name TEXT NOT NULL,
      sets          INTEGER,
      reps          TEXT,
      rest_seconds  INTEGER,
      notes         TEXT
    )
  `)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS workout_logs (
      id           SERIAL PRIMARY KEY,
      user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      workout_id   INTEGER REFERENCES workouts(id) ON DELETE SET NULL,
      completed_at TIMESTAMPTZ DEFAULT NOW(),
      notes        TEXT
    )
  `)

  // ── Custom foods ─────────────────────────────────────────────────────────────
  await pool.query(`ALTER TABLE meals ADD COLUMN IF NOT EXISTS sugar NUMERIC(6,1)`)
  await pool.query(`ALTER TABLE meals ADD COLUMN IF NOT EXISTS log_date DATE`)
  await pool.query(`ALTER TABLE meals ADD COLUMN IF NOT EXISTS serving_size NUMERIC(8,2)`)
  await pool.query(`ALTER TABLE meals ADD COLUMN IF NOT EXISTS serving_unit TEXT`)
  await pool.query(`ALTER TABLE meals ADD COLUMN IF NOT EXISTS source_type TEXT`)
  await pool.query(`ALTER TABLE meals ADD COLUMN IF NOT EXISTS source_label TEXT`)
  await pool.query(`ALTER TABLE meals ADD COLUMN IF NOT EXISTS is_verified BOOLEAN DEFAULT FALSE`)
  await pool.query(`ALTER TABLE meals ADD COLUMN IF NOT EXISTS micronutrients JSONB`)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS custom_foods (
      id                   SERIAL PRIMARY KEY,
      user_id              INTEGER REFERENCES users(id) ON DELETE CASCADE,
      is_global            BOOLEAN DEFAULT FALSE,
      food_name            TEXT NOT NULL,
      calories_per_serving NUMERIC(8,2),
      protein              NUMERIC(6,2),
      carbs                NUMERIC(6,2),
      fat                  NUMERIC(6,2),
      fiber                NUMERIC(6,2),
      serving_size         NUMERIC(8,2) DEFAULT 100,
      serving_unit         TEXT DEFAULT 'g',
      created_at           TIMESTAMPTZ DEFAULT NOW()
    )
  `)

  // ── Proactive Katie messages ─────────────────────────────────────────────────
  await pool.query(`ALTER TABLE coaching_conversations ADD COLUMN IF NOT EXISTS is_proactive    BOOLEAN    DEFAULT FALSE`)
  await pool.query(`ALTER TABLE coaching_conversations ADD COLUMN IF NOT EXISTS read_at         TIMESTAMPTZ`)
  await pool.query(`ALTER TABLE coaching_conversations ADD COLUMN IF NOT EXISTS proactive_trigger TEXT`)
  await pool.query(`ALTER TABLE coaching_conversations ADD COLUMN IF NOT EXISTS trigger_date    DATE`)

  // ── Gamification ─────────────────────────────────────────────────────────────

  // Cumulative XP and current rank per user
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_xp (
      id           SERIAL PRIMARY KEY,
      user_id      INTEGER UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      total_xp     INTEGER NOT NULL DEFAULT 0,
      current_rank TEXT    NOT NULL DEFAULT 'Recruit',
      updated_at   TIMESTAMPTZ DEFAULT NOW()
    )
  `)

  // Append-only log of every XP award (used for dedup and history)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS xp_log (
      id          SERIAL PRIMARY KEY,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      action_type TEXT    NOT NULL,
      xp_earned   INTEGER NOT NULL,
      earned_date DATE    NOT NULL DEFAULT CURRENT_DATE,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS xp_log_user_date_idx ON xp_log (user_id, earned_date)
  `)

  // Per-behavior streak counters
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_streaks (
      id             SERIAL PRIMARY KEY,
      user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      streak_type    TEXT    NOT NULL,
      current_streak INTEGER NOT NULL DEFAULT 0,
      last_log_date  DATE,
      UNIQUE (user_id, streak_type)
    )
  `)

  // Earned achievement badges (one row per user+badge, UNIQUE prevents duplicates)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_badges (
      id        SERIAL PRIMARY KEY,
      user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      badge_id  TEXT    NOT NULL,
      earned_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (user_id, badge_id)
    )
  `)
}

export async function getOrCreateUser(clerkUserId) {
  const existing = await pool.query(
    'SELECT id FROM users WHERE clerk_user_id = $1',
    [clerkUserId],
  )
  if (existing.rows.length > 0) return existing.rows[0].id

  const inserted = await pool.query(
    'INSERT INTO users (clerk_user_id) VALUES ($1) RETURNING id',
    [clerkUserId],
  )
  return inserted.rows[0].id
}
