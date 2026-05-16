import pg from 'pg'

const { Pool } = pg

export const pool = new Pool({ connectionString: process.env.DATABASE_URL })

// ── Hard-coded admin allowlist ───────────────────────────────────────────────
// These emails are ALWAYS promoted to role='admin' on startup and on every
// /api/users/me request. Adding emails here grants full admin access.
// Regular users are unaffected — security model otherwise unchanged.
export const ADMIN_EMAILS = [
  'jason@lwcvip.com',
  'jason@efcfit.com',
]
export function isAdminEmail(email) {
  if (!email) return false
  return ADMIN_EMAILS.includes(String(email).toLowerCase().trim())
}

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
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS goal_fiber    INTEGER`)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS goal_water    INTEGER`)
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

  // ── Custom foods schema additions ────────────────────────────────────────────
  // FIX 1: is_coach_food distinguishes admin-curated foods (Coach food badge)
  // from global utility foods (Food database badge). Default FALSE means all
  // existing global entries (milk etc.) get retagged automatically.
  await pool.query(`ALTER TABLE custom_foods ADD COLUMN IF NOT EXISTS is_coach_food BOOLEAN DEFAULT FALSE`)
  await pool.query(`ALTER TABLE custom_foods ADD COLUMN IF NOT EXISTS notes TEXT`)

  // ── Global milk foods ────────────────────────────────────────────────────────
  // Stored per-serving (244 ml = 1 cup). Search query normalises to per-100ml.
  await pool.query(`
    INSERT INTO custom_foods (is_global, is_coach_food, food_name, calories_per_serving, protein, carbs, fat, fiber, serving_size, serving_unit)
    SELECT TRUE, FALSE, 'Whole Milk', 149, 8, 12, 8, 0, 244, 'ml'
    WHERE NOT EXISTS (SELECT 1 FROM custom_foods WHERE food_name = 'Whole Milk' AND is_global = TRUE)
  `)
  await pool.query(`
    INSERT INTO custom_foods (is_global, is_coach_food, food_name, calories_per_serving, protein, carbs, fat, fiber, serving_size, serving_unit)
    SELECT TRUE, FALSE, '2% Reduced Fat Milk', 122, 8, 12, 5, 0, 244, 'ml'
    WHERE NOT EXISTS (SELECT 1 FROM custom_foods WHERE food_name = '2% Reduced Fat Milk' AND is_global = TRUE)
  `)
  await pool.query(`
    INSERT INTO custom_foods (is_global, is_coach_food, food_name, calories_per_serving, protein, carbs, fat, fiber, serving_size, serving_unit)
    SELECT TRUE, FALSE, '1% Low Fat Milk', 102, 8, 12, 2.4, 0, 244, 'ml'
    WHERE NOT EXISTS (SELECT 1 FROM custom_foods WHERE food_name = '1% Low Fat Milk' AND is_global = TRUE)
  `)
  await pool.query(`
    INSERT INTO custom_foods (is_global, is_coach_food, food_name, calories_per_serving, protein, carbs, fat, fiber, serving_size, serving_unit)
    SELECT TRUE, FALSE, 'Skim Milk (Fat Free)', 83, 8, 12, 0.2, 0, 244, 'ml'
    WHERE NOT EXISTS (SELECT 1 FROM custom_foods WHERE food_name = 'Skim Milk (Fat Free)' AND is_global = TRUE)
  `)

  // ── FIX 2: Common food database (per 100 g/ml, is_coach_food = FALSE) ────────
  // All values from USDA FoodData Central. is_coach_food = FALSE so they show
  // as "Food database" badge, NOT "Coach food".
  await pool.query(`
    INSERT INTO custom_foods
      (is_global, is_coach_food, food_name, calories_per_serving, protein, carbs, fat, fiber, serving_size, serving_unit)
    SELECT TRUE, FALSE, v.name, v.cal, v.pro, v.carb, v.fat, v.fib, 100, 'g'
    FROM (VALUES
      -- Dairy (per 100 g)
      ('Cottage Cheese',         98,  11.1, 3.4,  4.3,  0.0),
      ('Greek Yogurt Plain',     73,   9.9, 5.7,  1.9,  0.0),
      ('Regular Yogurt Plain',   63,   3.5, 5.0,  3.3,  0.0),
      ('Butter',                717,   0.9, 0.1, 81.0,  0.0),
      ('Cream Cheese',          342,   6.0, 4.1, 34.0,  0.0),
      ('Heavy Cream',           340,   2.8, 2.8, 36.0,  0.0),
      ('Sour Cream',            193,   2.4, 4.6, 19.0,  0.0),
      ('Cheddar Cheese',        403,  25.0, 1.3, 33.0,  0.0),
      ('Mozzarella',            280,  28.0, 2.2, 17.0,  0.0),
      ('Parmesan',              431,  38.0, 4.0, 29.0,  0.0),
      -- Proteins (per 100 g raw)
      ('Chicken Breast',        120,  22.5, 0.0,  2.6,  0.0),
      ('Chicken Thigh',         177,  18.0, 0.0, 11.0,  0.0),
      ('Ground Beef 80/20',     254,  17.0, 0.0, 20.0,  0.0),
      ('Ground Beef 93% Lean',  152,  20.0, 0.0,  8.0,  0.0),
      ('Ground Turkey',         149,  19.0, 0.0,  8.0,  0.0),
      ('Atlantic Salmon',       208,  20.0, 0.0, 13.0,  0.0),
      ('Tuna Canned in Water',  128,  30.0, 0.0,  0.9,  0.0),
      ('Whole Egg',             143,  13.0, 0.7,  9.5,  0.0),
      ('Egg White',              52,  11.0, 0.7,  0.2,  0.0),
      ('Tilapia',                96,  20.0, 0.0,  1.7,  0.0),
      ('Shrimp',                 85,  18.0, 0.9,  0.5,  0.0),
      ('Pork Tenderloin',       109,  21.0, 0.0,  2.7,  0.0),
      ('Bacon',                 541,  37.0, 1.4, 42.0,  0.0),
      ('Turkey Bacon',          218,  15.0, 2.8, 16.0,  0.0),
      -- Carbs (per 100 g, raw/dry unless noted)
      ('White Rice',            365,   7.1,80.0,  0.7,  1.3),
      ('Brown Rice',            370,   7.9,77.0,  2.9,  3.5),
      ('Rolled Oats',           389,  16.9,66.0,  6.9, 10.6),
      ('Sweet Potato',           86,   1.6,20.0,  0.1,  3.0),
      ('White Potato',           77,   2.0,17.0,  0.1,  2.2),
      ('White Bread',           265,   9.0,49.0,  3.2,  2.7),
      ('Whole Wheat Bread',     247,  13.0,41.0,  4.2,  6.0),
      ('Pasta',                 371,  13.0,75.0,  1.5,  2.7),
      ('Quinoa',                368,  14.0,64.0,  6.0,  7.0),
      ('Banana',                 89,   1.1,23.0,  0.3,  2.6),
      ('Apple',                  52,   0.3,14.0,  0.2,  2.4),
      ('Blueberries',            57,   0.7,14.0,  0.3,  2.4),
      ('Strawberries',           32,   0.7, 7.7,  0.3,  2.0),
      ('Orange',                 47,   0.9,12.0,  0.1,  2.4),
      -- Vegetables (per 100 g raw)
      ('Broccoli',               34,   2.8, 7.0,  0.4,  2.6),
      ('Spinach',                23,   2.9, 3.6,  0.4,  2.2),
      ('Kale',                   49,   4.3, 9.0,  0.9,  3.6),
      ('Green Beans',            31,   1.8, 7.0,  0.2,  2.7),
      ('Asparagus',              20,   2.2, 3.9,  0.1,  2.1),
      ('Zucchini',               17,   1.2, 3.1,  0.3,  1.0),
      ('Bell Pepper',            31,   1.0, 6.0,  0.3,  2.1),
      ('Cucumber',               16,   0.7, 3.6,  0.1,  0.5),
      ('Avocado',               160,   2.0, 9.0, 15.0,  6.7),
      ('Tomato',                 18,   0.9, 3.9,  0.2,  1.2),
      ('Onion',                  40,   1.1, 9.3,  0.1,  1.7),
      ('Garlic',                149,   6.4,33.0,  0.5,  2.1),
      -- Fats (per 100 g)
      ('Olive Oil',             884,   0.0, 0.0,100.0,  0.0),
      ('Coconut Oil',           862,   0.0, 0.0,100.0,  0.0),
      ('Almonds',               579,  21.0,22.0, 50.0, 12.5),
      ('Peanut Butter',         588,  25.0,20.0, 50.0,  5.7),
      ('Almond Butter',         614,  21.0,19.0, 55.0, 10.3),
      ('Walnuts',               654,  15.0,14.0, 65.0,  6.7),
      ('Cashews',               553,  18.0,30.0, 44.0,  3.3),
      -- Common packaged (per 100 g)
      ('Whey Protein Powder',   370,  82.0, 8.0,  4.0,  0.0)
    ) AS v(name, cal, pro, carb, fat, fib)
    WHERE NOT EXISTS (
      SELECT 1 FROM custom_foods cf2
      WHERE cf2.is_global = TRUE AND LOWER(cf2.food_name) = LOWER(v.name)
    )
  `)

  // Fairlife milk uses per-240ml serving
  await pool.query(`
    INSERT INTO custom_foods (is_global, is_coach_food, food_name, calories_per_serving, protein, carbs, fat, fiber, serving_size, serving_unit)
    SELECT TRUE, FALSE, 'Fairlife Whole Milk', 150, 13, 6, 8, 0, 240, 'ml'
    WHERE NOT EXISTS (SELECT 1 FROM custom_foods WHERE food_name = 'Fairlife Whole Milk' AND is_global = TRUE)
  `)

  // Per-egg entry (50 g = 1 large egg) and generic protein bar placeholder
  await pool.query(`
    INSERT INTO custom_foods (is_global, is_coach_food, food_name, calories_per_serving, protein, carbs, fat, fiber, serving_size, serving_unit)
    SELECT TRUE, FALSE, 'Egg, whole, large', 72, 6.3, 0.4, 4.8, 0, 50, 'g'
    WHERE NOT EXISTS (SELECT 1 FROM custom_foods WHERE food_name = 'Egg, whole, large' AND is_global = TRUE)
  `)
  await pool.query(`
    INSERT INTO custom_foods (is_global, is_coach_food, food_name, calories_per_serving, protein, carbs, fat, fiber, serving_size, serving_unit)
    SELECT TRUE, FALSE, 'Protein Bar', 200, 20, 21, 7, 2, 60, 'g'
    WHERE NOT EXISTS (SELECT 1 FROM custom_foods WHERE food_name = 'Protein Bar' AND is_global = TRUE)
  `)

  // ── Health Assessment ────────────────────────────────────────────────────────
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS assessment_complete BOOLEAN DEFAULT FALSE`)

  // ── Structured address fields (added after initial assessment launch) ────────
  // Keep the old `address` TEXT column — existing data is preserved.
  // New columns store the broken-out address so the admin can see full details.
  await pool.query(`ALTER TABLE health_assessments ADD COLUMN IF NOT EXISTS street_address TEXT`)
  await pool.query(`ALTER TABLE health_assessments ADD COLUMN IF NOT EXISTS city           TEXT`)
  await pool.query(`ALTER TABLE health_assessments ADD COLUMN IF NOT EXISTS state          TEXT`)
  await pool.query(`ALTER TABLE health_assessments ADD COLUMN IF NOT EXISTS zip_code       TEXT`)
  await pool.query(`ALTER TABLE health_assessments ADD COLUMN IF NOT EXISTS country        TEXT DEFAULT 'United States'`)
  // Life Warrior identity traits — JSONB array of strings (exactly 2 selected)
  await pool.query(`ALTER TABLE health_assessments ADD COLUMN IF NOT EXISTS identity_traits JSONB`)

  // ── Coaching command center ──────────────────────────────────────────────────
  // Role expansion: 'client' (default), 'coach', 'admin'
  // coaching_type: 'vip' (default — has human coach) | 'ai' (AI-only client)
  // assigned_coach_id: which coach owns this client (NULL = unassigned / Jason)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS coaching_type     TEXT DEFAULT 'vip'`)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS assigned_coach_id INTEGER REFERENCES users(id) ON DELETE SET NULL`)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS start_date        DATE`)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at     TIMESTAMPTZ`)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS paid_at           TIMESTAMPTZ`)

  // Client lifecycle: active | archived | deleted (soft delete)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS client_status     TEXT DEFAULT 'active'`)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS archived_at       TIMESTAMPTZ`)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS archived_by       INTEGER REFERENCES users(id) ON DELETE SET NULL`)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at        TIMESTAMPTZ`)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_by        INTEGER REFERENCES users(id) ON DELETE SET NULL`)
  await pool.query(`UPDATE users SET client_status = 'active' WHERE client_status IS NULL`)

  // Backfill paid_at for legacy users who were marked paid before paid_at existed.
  // Use created_at as a best-effort approximation of activation time.
  await pool.query(`UPDATE users SET paid_at = created_at WHERE paid = TRUE AND paid_at IS NULL`)

  // Coach-assigned habits — the structured habit assignments coaches give clients
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coach_assigned_habits (
      id                  SERIAL PRIMARY KEY,
      user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      assigned_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      habit_name          TEXT NOT NULL,
      habit_type          TEXT NOT NULL DEFAULT 'boolean',    -- 'boolean' | 'numeric' | 'completion'
      target_value        NUMERIC(10,2),
      unit                TEXT,
      frequency           TEXT NOT NULL DEFAULT 'daily',      -- 'daily' | 'weekly' | 'specific_days'
      start_date          DATE NOT NULL,
      end_date            DATE,
      days_of_week        TEXT,                                -- comma-separated 0-6 (Sun=0)
      notes               TEXT,
      active              BOOLEAN DEFAULT TRUE,
      created_at          TIMESTAMPTZ DEFAULT NOW(),
      updated_at          TIMESTAMPTZ DEFAULT NOW()
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_habits_user_date ON coach_assigned_habits (user_id, start_date)`)

  // Daily habit completion records — one row per (habit, date)
  // status: 'not_started' (0-49%) | 'partial' (50-79%) | 'complete' (80%+)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS habit_completions (
      id                    SERIAL PRIMARY KEY,
      user_id               INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      habit_id              INTEGER NOT NULL REFERENCES coach_assigned_habits(id) ON DELETE CASCADE,
      completion_date       DATE NOT NULL,
      completed_value       NUMERIC(10,2),
      target_value          NUMERIC(10,2),
      completion_percentage NUMERIC(5,2),
      status                TEXT,
      created_at            TIMESTAMPTZ DEFAULT NOW(),
      updated_at            TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (habit_id, completion_date)
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_habit_completions_user_date ON habit_completions (user_id, completion_date)`)

  // Client notes (internal staff notes with visibility scoping)
  // visibility: 'shared_staff' (admin + assigned coaches) | 'admin_private' (admin only)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS client_notes (
      id         SERIAL PRIMARY KEY,
      client_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      author_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
      note_body  TEXT NOT NULL,
      visibility TEXT NOT NULL DEFAULT 'shared_staff',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_client_notes_client ON client_notes (client_id)`)

  // Client messaging (with thread visibility scoping)
  // thread_type: 'coach_thread' (visible to client + coach + admin)
  //              'admin_private' (visible to client + admin only)
  //              'ai_admin'      (visible to AI client + admin only)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS client_messages (
      id           SERIAL PRIMARY KEY,
      client_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      sender_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
      sender_role  TEXT NOT NULL,
      message_body TEXT NOT NULL,
      thread_type  TEXT NOT NULL,
      visibility   TEXT NOT NULL,
      read_at      TIMESTAMPTZ,
      created_at   TIMESTAMPTZ DEFAULT NOW()
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_client_messages_thread ON client_messages (client_id, thread_type, created_at)`)
  await pool.query(`ALTER TABLE client_messages ADD COLUMN IF NOT EXISTS image_url TEXT`)

  // Comeback events — captures gap-then-return patterns for future Comeback XP
  await pool.query(`
    CREATE TABLE IF NOT EXISTS comeback_events (
      id             SERIAL PRIMARY KEY,
      user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      gap_start_date DATE,
      gap_end_date   DATE,
      comeback_date  DATE NOT NULL,
      comeback_type  TEXT NOT NULL,
      created_at     TIMESTAMPTZ DEFAULT NOW()
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_comeback_user_date ON comeback_events (user_id, comeback_date)`)

  // ── Weekly Check-Ins ─────────────────────────────────────────────────────────
  // One submission per client per week (unique on user_id + week_start).
  // week_start is always the Monday of the client's week (YYYY-MM-DD).
  // On duplicate submit for the same week, the row is updated (upsert).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS weekly_checkins (
      id                  SERIAL PRIMARY KEY,
      user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      week_start          DATE NOT NULL,
      current_weight      NUMERIC(6,1),
      sleep_quality       INTEGER CHECK (sleep_quality BETWEEN 1 AND 5),
      energy              INTEGER CHECK (energy BETWEEN 1 AND 5),
      stress              INTEGER CHECK (stress BETWEEN 1 AND 5),
      cravings            INTEGER CHECK (cravings BETWEEN 1 AND 5),
      workouts_completed  INTEGER,
      days_food_logged    INTEGER,
      days_hit_protein    INTEGER,
      biggest_win         TEXT,
      biggest_struggle    TEXT,
      coach_notes         TEXT,
      submitted_at        TIMESTAMPTZ DEFAULT NOW(),
      updated_at          TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (user_id, week_start)
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_weekly_checkins_user ON weekly_checkins (user_id, week_start DESC)`)

  // ── Forms Foundation ─────────────────────────────────────────────────────────
  //
  // VERSIONING STRATEGY
  // --------------------
  // form_templates  — admin-managed master form; draft_schema is the working copy
  // form_versions   — immutable snapshot created on each publish; referenced by
  //                   submissions forever (old answers always show exact questions)
  // form_submissions— one row per client fill; answers keyed by field id in the schema
  // form_assignments— skeleton for future in-app scheduled delivery (unused now)
  //
  // Publishing flow:
  //   1. Admin edits draft_schema on form_templates (non-destructive)
  //   2. Admin hits Publish → new form_version row created from draft_schema
  //   3. form_templates.current_version_id updated to the new version
  //   4. Clients fill the current_version_id version
  //   5. Submissions always store version_id → answers are permanently tied to
  //      the exact fields the client saw, even after the form is edited again
  //
  // Field schema object format (stored as JSONB array):
  //   { id, type, label, description, required, order, options, max_chars }
  //   type: short_text | long_text | number | date | single_choice |
  //         multi_choice | yes_no | rating

  await pool.query(`
    CREATE TABLE IF NOT EXISTS form_templates (
      id                 SERIAL PRIMARY KEY,
      title              TEXT NOT NULL,
      description        TEXT,
      status             TEXT NOT NULL DEFAULT 'draft'
                           CHECK (status IN ('draft', 'published', 'archived')),
      draft_schema       JSONB NOT NULL DEFAULT '[]',
      created_by         INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at         TIMESTAMPTZ DEFAULT NOW(),
      updated_at         TIMESTAMPTZ DEFAULT NOW()
    )
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS form_versions (
      id           SERIAL PRIMARY KEY,
      template_id  INTEGER NOT NULL REFERENCES form_templates(id) ON DELETE CASCADE,
      version_num  INTEGER NOT NULL DEFAULT 1,
      schema       JSONB NOT NULL,
      published_at TIMESTAMPTZ DEFAULT NOW(),
      published_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      UNIQUE (template_id, version_num)
    )
  `)

  // Add FK from templates → versions after both tables exist
  await pool.query(`
    ALTER TABLE form_templates
      ADD COLUMN IF NOT EXISTS current_version_id INTEGER
        REFERENCES form_versions(id) ON DELETE SET NULL
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS form_submissions (
      id           SERIAL PRIMARY KEY,
      template_id  INTEGER NOT NULL REFERENCES form_templates(id) ON DELETE CASCADE,
      version_id   INTEGER NOT NULL REFERENCES form_versions(id) ON DELETE CASCADE,
      user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      answers      JSONB NOT NULL DEFAULT '{}',
      submitted_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at   TIMESTAMPTZ DEFAULT NOW(),
      reviewed_at  TIMESTAMPTZ,
      reviewed_by  INTEGER REFERENCES users(id) ON DELETE SET NULL
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_form_submissions_user     ON form_submissions (user_id, submitted_at DESC)`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_form_submissions_template ON form_submissions (template_id, submitted_at DESC)`)

  // Future: in-app scheduled delivery + recurring assignments (schema ready, no UI yet)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS form_assignments (
      id             SERIAL PRIMARY KEY,
      template_id    INTEGER NOT NULL REFERENCES form_templates(id) ON DELETE CASCADE,
      client_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      assigned_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
      send_at        TIMESTAMPTZ,
      recurring_rule JSONB,
      is_active      BOOLEAN DEFAULT TRUE,
      created_at     TIMESTAMPTZ DEFAULT NOW()
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_form_assignments_client ON form_assignments (client_id, send_at)`)

  // Scheduling columns for form_assignments
  await pool.query(`ALTER TABLE form_assignments ADD COLUMN IF NOT EXISTS assignment_type TEXT DEFAULT 'manual'`)
  await pool.query(`ALTER TABLE form_assignments ADD COLUMN IF NOT EXISTS status         TEXT DEFAULT 'sent'`)
  await pool.query(`ALTER TABLE form_assignments ADD COLUMN IF NOT EXISTS sent_at        TIMESTAMPTZ`)
  await pool.query(`ALTER TABLE form_assignments ADD COLUMN IF NOT EXISTS last_sent_at   TIMESTAMPTZ`)
  await pool.query(`ALTER TABLE form_assignments ADD COLUMN IF NOT EXISTS next_send_at   TIMESTAMPTZ`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_form_assignments_due ON form_assignments (next_send_at, status, is_active)`)

  // Form assignment tracking on submissions + metadata on messages (for in-app form delivery)
  await pool.query(`ALTER TABLE form_submissions ADD COLUMN IF NOT EXISTS assignment_id INTEGER REFERENCES form_assignments(id) ON DELETE SET NULL`)
  await pool.query(`ALTER TABLE client_messages  ADD COLUMN IF NOT EXISTS metadata JSONB`)
  // Staff review note per submission
  await pool.query(`ALTER TABLE form_submissions ADD COLUMN IF NOT EXISTS coach_note TEXT`)

  // ── Grandfather existing users ───────────────────────────────────────────────
  // Any user who already completed onboarding before the assessment feature was
  // introduced should be treated as having completed the assessment so they are
  // NOT forced through it again on their next login.
  //
  // Guard: only bulk-set when zero users have assessment_complete = TRUE.
  // Once at least one user has it set (grandfathered or self-completed), this
  // UPDATE becomes a no-op on every subsequent server restart, which means dev
  // resets (assessment_complete = FALSE for a single user) survive restarts.
  await pool.query(`
    UPDATE users
    SET assessment_complete = TRUE
    WHERE onboarding_complete = TRUE
      AND assessment_complete = FALSE
      AND NOT EXISTS (
        SELECT 1 FROM users WHERE assessment_complete = TRUE LIMIT 1
      )
  `)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS health_assessments (
      id                   SERIAL PRIMARY KEY,
      user_id              INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      first_name           TEXT,
      last_name            TEXT,
      email                TEXT,
      phone                TEXT,
      address              TEXT,
      date_of_birth        DATE,
      shirt_size           TEXT,
      coach_name           TEXT,
      supplements          TEXT,
      goals_6_months       TEXT,
      injuries_limitations TEXT,
      num_kids             INTEGER,
      occupation           TEXT,
      energy_level         INTEGER CHECK (energy_level BETWEEN 1 AND 5),
      sleep_hours          TEXT,
      stress_management    INTEGER CHECK (stress_management BETWEEN 1 AND 5),
      sleep_quality        INTEGER CHECK (sleep_quality BETWEEN 1 AND 5),
      daily_water          TEXT,
      alcohol_weekdays     INTEGER DEFAULT 0,
      alcohol_weekends     INTEGER DEFAULT 0,
      happiness_level      INTEGER CHECK (happiness_level BETWEEN 1 AND 5),
      confidence_level     INTEGER CHECK (confidence_level BETWEEN 1 AND 5),
      activity_level       TEXT,
      completed_at         TIMESTAMPTZ,
      created_at           TIMESTAMPTZ DEFAULT NOW(),
      updated_at           TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (user_id)
    )
  `)

  // ── VIP Client Invites ───────────────────────────────────────────────────────
  // Stores admin-created invite tokens that allow new VIP clients to sign up.
  // token: generated UUID, serves as the invite URL key.
  // accepted_at / accepted_by_user_id: set when a Clerk user claims the invite.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS client_invites (
      id                    SERIAL PRIMARY KEY,
      token                 TEXT NOT NULL UNIQUE DEFAULT gen_random_uuid()::text,
      email                 TEXT NOT NULL,
      first_name            TEXT NOT NULL,
      last_name             TEXT,
      phone                 TEXT,
      assigned_coach_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
      notes                 TEXT,
      invited_by            INTEGER REFERENCES users(id) ON DELETE SET NULL,
      coaching_type         TEXT NOT NULL DEFAULT 'vip',
      created_at            TIMESTAMPTZ DEFAULT NOW(),
      expires_at            TIMESTAMPTZ DEFAULT NOW() + INTERVAL '30 days',
      accepted_at           TIMESTAMPTZ,
      accepted_by_user_id   INTEGER REFERENCES users(id) ON DELETE SET NULL
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_client_invites_email ON client_invites (LOWER(email))`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_client_invites_token ON client_invites (token)`)

  // ── Remove old onboarding gate — mark all users as onboarding_complete ──────
  // The multi-step onboarding form (name/gender/age/height/weight) is removed.
  // New post-signup flow is: Health Assessment → Identity Traits → Enter app.
  // Mark every existing user onboarding_complete=TRUE so nobody gets stuck.
  await pool.query(`UPDATE users SET onboarding_complete = TRUE WHERE onboarding_complete = FALSE OR onboarding_complete IS NULL`)

  // ── Admin allowlist bootstrap ───────────────────────────────────────────────
  // Force role=admin for the hard-coded ADMIN_EMAILS list on every startup.
  // Existing user data (meals, workouts, journal, etc.) is preserved — this
  // only sets flag columns. Regular users are unaffected.
  if (ADMIN_EMAILS.length > 0) {
    const placeholders = ADMIN_EMAILS.map((_, i) => `$${i + 1}`).join(', ')
    const result = await pool.query(
      `UPDATE users
       SET role                = 'admin',
           paid                = TRUE,
           onboarding_complete = TRUE,
           assessment_complete = TRUE
       WHERE LOWER(email) IN (${placeholders})
       RETURNING id, email`,
      ADMIN_EMAILS.map(e => e.toLowerCase()),
    )
    if (result.rowCount > 0) {
      console.log(`[admin-bootstrap] promoted ${result.rowCount} user(s) on startup:`,
        result.rows.map(r => r.email).join(', '))
    } else {
      console.log('[admin-bootstrap] no existing rows matched ADMIN_EMAILS yet; will self-promote on first /api/users/me call')
    }
  }
}

// getOrCreateUser: ensures a DB user row exists for this Clerk user.
// Optionally captures their email — if it matches ADMIN_EMAILS the row is
// promoted to admin atomically. This is the runtime backstop that catches
// admin users whose email column was NULL at startup migration time.
export async function getOrCreateUser(clerkUserId, email = null) {
  const existing = await pool.query(
    'SELECT id, email, role FROM users WHERE clerk_user_id = $1',
    [clerkUserId],
  )

  let dbUserId
  if (existing.rows.length > 0) {
    dbUserId = existing.rows[0].id

    // Backfill email if we have it and it's missing or different
    if (email && existing.rows[0].email !== email) {
      await pool.query('UPDATE users SET email = $1 WHERE id = $2', [email, dbUserId])
    }
  } else {
    const inserted = await pool.query(
      'INSERT INTO users (clerk_user_id, email) VALUES ($1, $2) RETURNING id',
      [clerkUserId, email],
    )
    dbUserId = inserted.rows[0].id
  }

  // Runtime admin self-promote — covers the case where the startup migration
  // ran before the user row had an email populated.
  if (isAdminEmail(email)) {
    const r = await pool.query(
      `UPDATE users
       SET role = 'admin', paid = TRUE,
           onboarding_complete = TRUE, assessment_complete = TRUE
       WHERE id = $1 AND role != 'admin'
       RETURNING id`,
      [dbUserId],
    )
    if (r.rowCount > 0) {
      console.log(`[admin-bootstrap] runtime-promoted ${email} (id=${dbUserId}) to admin`)
    }
  }

  return dbUserId
}
