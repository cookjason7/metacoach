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
    CREATE TABLE IF NOT EXISTS meal_comments (
      id           SERIAL PRIMARY KEY,
      meal_id      INTEGER REFERENCES meals(id) ON DELETE CASCADE,
      coach_id     INTEGER REFERENCES users(id),
      comment_text TEXT NOT NULL,
      created_at   TIMESTAMPTZ DEFAULT NOW()
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
  await pool.query(`ALTER TABLE daily_logs ADD COLUMN IF NOT EXISTS sleep_minutes INTEGER`)
  await pool.query(`ALTER TABLE daily_logs ADD COLUMN IF NOT EXISTS steps_source TEXT DEFAULT 'manual'`)
  await pool.query(`ALTER TABLE daily_logs ADD COLUMN IF NOT EXISTS sleep_source TEXT DEFAULT 'manual'`)
  await pool.query(`ALTER TABLE daily_logs ADD COLUMN IF NOT EXISTS weight_note TEXT`)
  await pool.query(`ALTER TABLE daily_logs ADD COLUMN IF NOT EXISTS water_note TEXT`)
  await pool.query(`ALTER TABLE daily_logs ADD COLUMN IF NOT EXISTS sleep_note TEXT`)
  // Replaced by the per-metric columns above (added same day, no production data to migrate).
  await pool.query(`ALTER TABLE daily_logs DROP COLUMN IF EXISTS note`)
  // Tracks when steps_source/sleep_source were last written by an automated sync
  // (fitbit/google_health/apple_health/synced). Lets a newer sync from one source
  // overwrite an older sync from another instead of being permanently locked out
  // once a different source claims the row. NULL for legacy rows / manual entries.
  await pool.query(`ALTER TABLE daily_logs ADD COLUMN IF NOT EXISTS steps_source_updated_at TIMESTAMPTZ`)
  await pool.query(`ALTER TABLE daily_logs ADD COLUMN IF NOT EXISTS sleep_source_updated_at TIMESTAMPTZ`)
  // Backfill: any row where steps or sleep has a value but source is NULL
  // should be treated as manually entered. The DEFAULT handles new rows; this
  // catches rows created before the column existed or via raw INSERT paths.
  await pool.query(`UPDATE daily_logs SET steps_source = 'manual' WHERE steps IS NOT NULL AND steps_source IS NULL`)
  await pool.query(`UPDATE daily_logs SET sleep_source = 'manual' WHERE sleep_minutes IS NOT NULL AND sleep_source IS NULL`)
  // Google Health-only for now (see googleHealthSync.js) — mirrors the
  // steps_source/sleep_source precedence pattern so a future manual-entry path
  // or another sync source can't be permanently locked out.
  await pool.query(`ALTER TABLE daily_logs ADD COLUMN IF NOT EXISTS calories_burned INTEGER`)
  await pool.query(`ALTER TABLE daily_logs ADD COLUMN IF NOT EXISTS calories_source TEXT DEFAULT 'manual'`)
  await pool.query(`ALTER TABLE daily_logs ADD COLUMN IF NOT EXISTS calories_source_updated_at TIMESTAMPTZ`)
  await pool.query(`UPDATE daily_logs SET calories_source = 'manual' WHERE calories_burned IS NOT NULL AND calories_source IS NULL`)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fitbit_tokens (
      id               SERIAL PRIMARY KEY,
      user_id          INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      fitbit_user_id   TEXT,
      access_token     TEXT NOT NULL,
      refresh_token    TEXT NOT NULL,
      scope            TEXT,
      expires_at       TIMESTAMPTZ NOT NULL,
      last_synced_at   TIMESTAMPTZ,
      created_at       TIMESTAMPTZ DEFAULT NOW(),
      updated_at       TIMESTAMPTZ DEFAULT NOW()
    )
  `)
  await pool.query(`ALTER TABLE fitbit_tokens ADD COLUMN IF NOT EXISTS last_sync_error    TEXT`)
  await pool.query(`ALTER TABLE fitbit_tokens ADD COLUMN IF NOT EXISTS last_sync_error_at TIMESTAMPTZ`)
  // The Google account email the OAuth token belongs to — captured from Google's
  // userinfo endpoint at connect/reconnect time. Lets us detect and surface the
  // case where the account authorized here isn't the one Fitbit data flows into.
  await pool.query(`ALTER TABLE fitbit_tokens ADD COLUMN IF NOT EXISTS google_email TEXT`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_fitbit_tokens_user ON fitbit_tokens (user_id)`)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fitbit_oauth_state (
      state       TEXT PRIMARY KEY,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at  TIMESTAMPTZ NOT NULL,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_fitbit_oauth_state_expires ON fitbit_oauth_state (expires_at)`)

  // ── Google Calendar (one-way, write-only habit push) ────────────────────────
  // Modelled directly on fitbit_tokens above. Separate OAuth client and separate
  // token row from Google Health — a client may connect either, both, or neither,
  // and revoking one must never disturb the other. access_token / refresh_token
  // hold AES-256-GCM envelopes (see server/utils/tokenEncryption.js), never
  // plaintext. We only ever WRITE to the user's calendar; nothing here reads it.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS google_calendar_tokens (
      id                 SERIAL PRIMARY KEY,
      user_id            INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      access_token       TEXT NOT NULL,
      refresh_token      TEXT NOT NULL,
      scope              TEXT,
      expires_at         TIMESTAMPTZ NOT NULL,
      google_email       TEXT,
      last_synced_at     TIMESTAMPTZ,
      last_sync_error    TEXT,
      last_sync_error_at TIMESTAMPTZ,
      created_at         TIMESTAMPTZ DEFAULT NOW(),
      updated_at         TIMESTAMPTZ DEFAULT NOW()
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_google_calendar_tokens_user ON google_calendar_tokens (user_id)`)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS google_calendar_oauth_state (
      state       TEXT PRIMARY KEY,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at  TIMESTAMPTZ NOT NULL,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_google_calendar_oauth_state_expires ON google_calendar_oauth_state (expires_at)`)

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
  // macro_target_history — audit log of users.goal_* changes; one snapshot row per
  // PATCH /api/admin/users/:id/macros call (coach visibility only, no scheduling).
  // org_id is added below via TENANT_TABLES in 001_multi_tenancy.js (runs after
  // this migrate() call, once the organizations table exists) rather than as a
  // column here, so the existing-install path and the fresh-install path take
  // the same code — same reasoning as community_resources above.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS macro_target_history (
      id            SERIAL PRIMARY KEY,
      user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      goal_calories INTEGER,
      goal_protein  INTEGER,
      goal_carbs    INTEGER,
      goal_fat      INTEGER,
      goal_fiber    INTEGER,
      goal_water    INTEGER,
      changed_at    TIMESTAMPTZ DEFAULT NOW(),
      changed_by    INTEGER REFERENCES users(id) ON DELETE SET NULL
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_macro_target_history_user ON macro_target_history (user_id, changed_at DESC)`)
  await pool.query(`ALTER TABLE meals ADD COLUMN IF NOT EXISTS portion_notes TEXT`)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_complete BOOLEAN DEFAULT FALSE`)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS first_name TEXT`)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_name TEXT`)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS age INTEGER`)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS height_inches INTEGER`)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS starting_weight_lbs NUMERIC(6,1)`)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS goal_weight_lbs NUMERIC(6,1)`)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS activity_level TEXT`)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS tried_before TEXT`)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS why_joined TEXT`)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS identity_anchors TEXT[]`)
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
  // Widen the notifications.type CHECK to add 'new_post' (staff creates a community
  // post -> clients get a badge notification), alongside the existing comment/mention types.
  await pool.query(`
    DO $$ BEGIN
      ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
      ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
        CHECK (type IN ('comment', 'mention', 'new_post', 'meal_comment'));
    END $$;
  `)
  // title/message support a self-contained notification body (e.g. meal_comment)
  // that isn't derived by joining back to a community_posts row like comment/mention/new_post are.
  await pool.query(`ALTER TABLE notifications ADD COLUMN IF NOT EXISTS title   TEXT`)
  await pool.query(`ALTER TABLE notifications ADD COLUMN IF NOT EXISTS message TEXT`)
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
      id               SERIAL PRIMARY KEY,
      user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      photo_url        TEXT    NOT NULL,
      angle            TEXT    NOT NULL CHECK (angle IN ('front', 'back', 'side')),
      taken_at         TIMESTAMPTZ DEFAULT NOW(),
      photo_session_id TEXT
    )
  `)
  // Add photo_session_id to existing tables that predate the column
  await pool.query(`ALTER TABLE progress_photos ADD COLUMN IF NOT EXISTS photo_session_id TEXT`)
  // Backfill: group legacy photos by user + calendar date so they appear as a set
  await pool.query(`
    UPDATE progress_photos
    SET photo_session_id = 'legacy-' || user_id::text || '-' || TO_CHAR(taken_at AT TIME ZONE 'UTC', 'YYYY-MM-DD')
    WHERE photo_session_id IS NULL
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

  // ── workout_exercises columns added post-launch ───────────────────────────────
  await pool.query(`ALTER TABLE workout_exercises ADD COLUMN IF NOT EXISTS weight TEXT`)
  await pool.query(`ALTER TABLE workout_exercises ADD COLUMN IF NOT EXISTS sort_order INTEGER DEFAULT 0`)

  // status: 'assigned' (visible to client, default — preserves prior behavior for
  // existing rows) | 'draft' (coach-only, saved but not yet assigned to the client)
  await pool.query(`ALTER TABLE workouts ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'assigned'`)

  // requested_circuits: the client's raw answers.circuits value ('none'/'some'/
  // 'full') at generation time, captured in generateWorkoutPlan() before
  // mergeResponse() runs so it reflects what was actually asked for, regardless
  // of what Claude returned or how mergeResponse salvaged/dropped circuits (see
  // workout_circuit_diagnostics below and onCircuitDiagnostic in
  // workoutGenerator.js, added in 6db5815). Nullable — only ever set on plans
  // that went through AI generation; manually-built workouts never had a
  // circuits answer to begin with. JSONB rather than TEXT to leave room for
  // richer captured context later without another migration.
  await pool.query(`ALTER TABLE workouts ADD COLUMN IF NOT EXISTS requested_circuits JSONB`)

  // ── Exercise library ─────────────────────────────────────────────────────────
  // Categorized exercise catalog, seeded from free-exercise-db (see
  // server/scripts/import-exercises.js). movement_pattern drives Katie's
  // day-template quota (one squat / hinge / upper_push / upper_pull / core,
  // optional carry or conditioning) instead of freely-generated exercise names.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS exercises (
      id                SERIAL PRIMARY KEY,
      name              TEXT NOT NULL,
      movement_pattern  TEXT NOT NULL CHECK (movement_pattern IN (
                           'squat_bilateral', 'squat_unilateral',
                           'hinge_bilateral', 'hinge_unilateral',
                           'upper_push', 'upper_pull', 'core', 'carry',
                           'conditioning', 'mobility', 'arms'
                         )),
      is_unilateral     BOOLEAN NOT NULL DEFAULT FALSE,
      primary_muscles   TEXT[] DEFAULT '{}',
      secondary_muscles TEXT[] DEFAULT '{}',
      equipment         TEXT,
      difficulty        TEXT,
      image_url         TEXT,
      instructions      TEXT,
      source            TEXT NOT NULL DEFAULT 'seed',
      created_at        TIMESTAMPTZ DEFAULT NOW()
    )
  `)
  // Lets the importer re-run safely (ON CONFLICT upsert) and lets future non-seed
  // sources (e.g. a coach-submitted custom exercise) coexist with the same name.
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS exercises_name_source_uq ON exercises (name, source)`)
  await pool.query(`CREATE INDEX IF NOT EXISTS exercises_movement_pattern_idx ON exercises (movement_pattern)`)

  // requires_bench: 176 exercises need a flat/incline/decline bench (lying/incline
  // presses, incline curls, bench-supported rows, etc.) but `equipment` only ever
  // holds one primary value (dumbbell/barbell/…), so nothing previously captured
  // this. 'Benches' in EQUIPMENT_MAP used to resolve to an empty array — no
  // filtering effect at all — so a client without a bench could be handed any of
  // these. Backfilled from a name/instructions audit (see
  // server/scripts/backfill-requires-bench.js); default FALSE so every
  // unaudited/future row is assumed bench-free (never over-filters by accident).
  await pool.query(`ALTER TABLE exercises ADD COLUMN IF NOT EXISTS requires_bench BOOLEAN NOT NULL DEFAULT FALSE`)

  // exercise_id: links a workout_exercises row back to the library when the
  // exercise was AI-selected or coach-picked from search. Nullable — free-typed
  // custom entries (not in the library) keep exercise_name only, as before.
  await pool.query(`ALTER TABLE workout_exercises ADD COLUMN IF NOT EXISTS exercise_id INTEGER REFERENCES exercises(id) ON DELETE SET NULL`)
  // day_focus: human-readable movement-pattern summary for the day (e.g.
  // "Squat (Unilateral) • Hinge (Unilateral) • Upper Push • Upper Pull • Core").
  // Previously this existed only as day.focus in the AI response and was
  // dropped on save; now persisted per exercise row alongside its day.
  await pool.query(`ALTER TABLE workout_exercises ADD COLUMN IF NOT EXISTS day_focus TEXT`)
  // image_url / instructions: carried through at save time from what the
  // assembleSession()-backed "Generate with Katie" review screen already
  // shows (exercise_library.instructions, and image_url resolved via
  // exercise_library.legacy_exercise_id) — see
  // server/services/assemblyWorkoutGenerator.js. Nullable: most exercises
  // have neither (only ~20% of exercise_library rows link to legacy media,
  // ~26% have an instructions cue). Plain TEXT, no re-querying at save time.
  await pool.query(`ALTER TABLE workout_exercises ADD COLUMN IF NOT EXISTS image_url TEXT`)
  await pool.query(`ALTER TABLE workout_exercises ADD COLUMN IF NOT EXISTS instructions TEXT`)

  // Manual workout builder: sections (Warm-Up / Strength / Conditioning / Cool
  // Down / custom) and groups (single exercise / superset / circuit) within a
  // day. group_id ties 2+ exercise rows into one superset/circuit; group_label
  // is the display tag ('A'/'B' for supersets, '1'/'2'/'3'… for circuits).
  await pool.query(`ALTER TABLE workout_exercises ADD COLUMN IF NOT EXISTS section_name TEXT`)
  await pool.query(`ALTER TABLE workout_exercises ADD COLUMN IF NOT EXISTS group_id TEXT`)
  await pool.query(`ALTER TABLE workout_exercises ADD COLUMN IF NOT EXISTS group_type TEXT NOT NULL DEFAULT 'exercise'`)
  await pool.query(`ALTER TABLE workout_exercises ADD COLUMN IF NOT EXISTS group_label TEXT`)

  // org_id backfill for workouts/workout_exercises moved below runMigrations() —
  // see the block right after that call. workouts.org_id/workout_exercises.org_id/
  // users.org_id don't exist yet at this point in a fresh bootstrap (they're added
  // by 001_multi_tenancy.js's TENANT_TABLES loop, which only runs at the very end
  // of migrate()), so referencing w.org_id here threw "column w.org_id does not
  // exist" on any genuinely fresh DB.

  // ── Workout scheduling ───────────────────────────────────────────────────────
  // Mirrors the coach_assigned_habits / habit_completions pattern, but assigns a
  // saved workout program's individual "day" onto the client's calendar. One row
  // per (workout_id, day_label): a 3-day program yields 3 independently-schedulable
  // rows, each with its own weekday cadence. day_label matches a distinct
  // workout_exercises.day value for that workout_id.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coach_assigned_workouts (
      id                  SERIAL PRIMARY KEY,
      user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      assigned_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      workout_id          INTEGER NOT NULL REFERENCES workouts(id) ON DELETE CASCADE,
      day_label           TEXT NOT NULL,                       -- matches a workout_exercises.day value
      frequency           TEXT NOT NULL DEFAULT 'weekly',      -- 'daily' | 'weekly' | 'specific_days'
      start_date          DATE NOT NULL,
      end_date            DATE,
      days_of_week        TEXT,                                -- comma-separated 0-6 (Sun=0)
      active              BOOLEAN DEFAULT TRUE,
      created_at          TIMESTAMPTZ DEFAULT NOW(),
      updated_at          TIMESTAMPTZ DEFAULT NOW()
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_assigned_workouts_user_date ON coach_assigned_workouts (user_id, start_date)`)

  // workout_logs gains per-calendar-slot linkage, mirroring habit_completions:
  //   scheduled_date — the calendar date this log satisfies
  //   assignment_id  — the coach_assigned_workouts row it belongs to (nullable so
  //                    pre-existing ad-hoc logs, which have neither, still work)
  await pool.query(`ALTER TABLE workout_logs ADD COLUMN IF NOT EXISTS scheduled_date DATE`)
  await pool.query(`ALTER TABLE workout_logs ADD COLUMN IF NOT EXISTS assignment_id INTEGER REFERENCES coach_assigned_workouts(id) ON DELETE SET NULL`)
  // One log per (assignment, calendar date) — mirrors habit_completions'
  // UNIQUE(habit_id, completion_date). A unique INDEX (not a table constraint) so
  // it's idempotent via IF NOT EXISTS. NULLs are distinct in Postgres, so legacy
  // rows with NULL assignment_id/scheduled_date are unaffected, and the index still
  // backs ON CONFLICT (assignment_id, scheduled_date) upserts.
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS workout_logs_assignment_date_uq
      ON workout_logs (assignment_id, scheduled_date)
  `)

  // Per-set actuals for a workout log (actual reps/weight vs the exercise's target).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS workout_set_logs (
      id                  SERIAL PRIMARY KEY,
      workout_log_id      INTEGER NOT NULL REFERENCES workout_logs(id) ON DELETE CASCADE,
      workout_exercise_id INTEGER REFERENCES workout_exercises(id) ON DELETE SET NULL,
      set_number          INTEGER,
      actual_reps         TEXT,
      actual_weight       TEXT,
      created_at          TIMESTAMPTZ DEFAULT NOW()
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_workout_set_logs_log ON workout_set_logs (workout_log_id)`)

  // ── Workout day notes ────────────────────────────────────────────────────────
  // Coach-authored note shown above the Warm-Up section of one day of a program.
  // Keyed by (workout_id, day) — the same "a day is just a distinct
  // workout_exercises.day value" convention coach_assigned_workouts.day_label
  // already uses, since there is no workout_days table and a day has no row of
  // its own. One row per day, created on first save; the row is deleted (not
  // blanked) when a coach clears the note, so a read never has to distinguish an
  // empty note from no note.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS workout_day_notes (
      id         SERIAL PRIMARY KEY,
      workout_id INTEGER NOT NULL REFERENCES workouts(id) ON DELETE CASCADE,
      day        TEXT NOT NULL,                       -- matches a workout_exercises.day value
      note_text  TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `)
  // Unique so the PUT route can upsert via ON CONFLICT (workout_id, day). A unique
  // INDEX rather than a table constraint so it stays idempotent via IF NOT EXISTS
  // (matching workout_logs_assignment_date_uq above).
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS workout_day_notes_workout_day_uq
      ON workout_day_notes (workout_id, day)
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
  await pool.query(`ALTER TABLE custom_foods ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE`)
  await pool.query(`ALTER TABLE custom_foods ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`)
  await pool.query(`ALTER TABLE custom_foods ADD COLUMN IF NOT EXISTS created_by INTEGER REFERENCES users(id) ON DELETE SET NULL`)

  // ── Client food review queue ──────────────────────────────────────────────────
  // review_status: 'pending' (awaiting admin action) | 'approved' | 'dismissed'
  // Only client-created private foods use this; global foods are always 'approved'.
  await pool.query(`ALTER TABLE custom_foods ADD COLUMN IF NOT EXISTS review_status TEXT`)
  await pool.query(`ALTER TABLE custom_foods ADD COLUMN IF NOT EXISTS reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL`)
  await pool.query(`ALTER TABLE custom_foods ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ`)
  // Backfill existing rows (idempotent — WHERE review_status IS NULL guard prevents overwrite)
  await pool.query(`UPDATE custom_foods SET review_status = 'approved' WHERE is_global = TRUE  AND review_status IS NULL`)
  await pool.query(`UPDATE custom_foods SET review_status = 'pending'  WHERE is_global = FALSE AND user_id IS NOT NULL AND review_status IS NULL`)

  // ── Sugar & Sodium columns ────────────────────────────────────────────────────
  await pool.query(`ALTER TABLE custom_foods ADD COLUMN IF NOT EXISTS sugar NUMERIC(6,1)`)
  await pool.query(`ALTER TABLE custom_foods ADD COLUMN IF NOT EXISTS sodium_mg NUMERIC(8,1)`)
  await pool.query(`ALTER TABLE recipes ADD COLUMN IF NOT EXISTS sugar NUMERIC(6,1)`)
  await pool.query(`ALTER TABLE recipes ADD COLUMN IF NOT EXISTS sodium_mg NUMERIC(8,1)`)
  await pool.query(`ALTER TABLE recipe_ingredients ADD COLUMN IF NOT EXISTS sugar NUMERIC(6,1)`)
  await pool.query(`ALTER TABLE recipe_ingredients ADD COLUMN IF NOT EXISTS sodium_mg NUMERIC(8,1)`)

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

  // ── Egg, whole, large — verified per-egg entry (50 g = 1 large egg) ─────────
  // is_coach_food=TRUE so it ranks first in search results (ORDER BY is_coach_food DESC)
  // above generic "Whole Egg" (per-100g) and USDA results.
  // Macros from USDA FoodData Central Foundation Foods (FDC 748967).
  await pool.query(`
    INSERT INTO custom_foods (is_global, is_coach_food, food_name, calories_per_serving, protein, carbs, fat, fiber, serving_size, serving_unit)
    SELECT TRUE, TRUE, 'Egg, whole, large', 72, 6.3, 0.4, 4.8, 0, 50, 'g'
    WHERE NOT EXISTS (SELECT 1 FROM custom_foods WHERE food_name = 'Egg, whole, large' AND is_global = TRUE)
  `)
  // Ensure any existing row has the correct macros, coach-food priority, and notes for alias search
  await pool.query(`
    UPDATE custom_foods
    SET is_coach_food          = TRUE,
        calories_per_serving   = 72,
        protein                = 6.3,
        carbs                  = 0.4,
        fat                    = 4.8,
        fiber                  = 0,
        serving_size           = 50,
        serving_unit           = 'g',
        notes                  = 'whole egg large egg per egg one egg egg white'
    WHERE food_name = 'Egg, whole, large' AND is_global = TRUE
  `)
  await pool.query(`
    INSERT INTO custom_foods (is_global, is_coach_food, food_name, calories_per_serving, protein, carbs, fat, fiber, serving_size, serving_unit)
    SELECT TRUE, FALSE, 'Protein Bar', 200, 20, 21, 7, 2, 60, 'g'
    WHERE NOT EXISTS (SELECT 1 FROM custom_foods WHERE food_name = 'Protein Bar' AND is_global = TRUE)
  `)

  // ── Barcode persistence: add barcode column to custom_foods ───────────────────
  // Allows manually-added barcode foods to be found on future scans.
  await pool.query(`ALTER TABLE custom_foods ADD COLUMN IF NOT EXISTS barcode TEXT`)
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_custom_foods_barcode
    ON custom_foods (barcode)
    WHERE barcode IS NOT NULL
  `)

  // ── Health Assessment ────────────────────────────────────────────────────────
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS assessment_complete BOOLEAN DEFAULT FALSE`)

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
  // coaching_type: 'vip' (default — has human coach) | 'hybrid' (AI-coached)
  //   | 'basic' (tracking tier, no community). The legacy value 'ai' was
  //   consolidated into 'hybrid' — nothing writes it anymore, but the column is
  //   deliberately left unconstrained TEXT so any old row still stores and
  //   reads back fine; readers treat 'ai' as 'hybrid'.
  // assigned_coach_id: which coach owns this client (NULL = unassigned / Jason)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS coaching_type     TEXT DEFAULT 'vip'`)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS coaching_type_source TEXT`)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS assigned_coach_id INTEGER REFERENCES users(id) ON DELETE SET NULL`)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS start_date        DATE`)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS program_end_date  DATE`)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at     TIMESTAMPTZ`)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS paid_at           TIMESTAMPTZ`)

  // Client lifecycle: active | deactivated | deleted (soft delete)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS client_status     TEXT DEFAULT 'active'`)
  // Rename legacy archive columns to deactivate naming (idempotent — no-op once already renamed)
  await pool.query(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'archived_at')
         AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'deactivated_at') THEN
        ALTER TABLE users RENAME COLUMN archived_at TO deactivated_at;
      END IF;
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'archived_by')
         AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'deactivated_by') THEN
        ALTER TABLE users RENAME COLUMN archived_by TO deactivated_by;
      END IF;
    END $$;
  `)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS deactivated_at    TIMESTAMPTZ`)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS deactivated_by    INTEGER REFERENCES users(id) ON DELETE SET NULL`)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at        TIMESTAMPTZ`)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_by        INTEGER REFERENCES users(id) ON DELETE SET NULL`)
  await pool.query(`UPDATE users SET client_status = 'deactivated' WHERE client_status = 'archived'`)
  await pool.query(`UPDATE users SET client_status = 'active' WHERE client_status IS NULL`)

  // Staff lifecycle: active | archived (non-destructive; separate from client_status)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS staff_status TEXT DEFAULT 'active'`)

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
  await pool.query(`ALTER TABLE coach_assigned_habits ADD COLUMN IF NOT EXISTS identity_category TEXT`)
  // The Google Calendar event this habit was pushed to, for clients who opted in
  // to Calendar sync. NULL means "no event exists" — either the client never
  // connected Calendar, or the push failed, or they deleted the event on their
  // side (we clear the id when Google reports it gone). Never assume non-NULL.
  await pool.query(`ALTER TABLE coach_assigned_habits ADD COLUMN IF NOT EXISTS google_calendar_event_id TEXT`)

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

  // Client tags (CRM-style tagging for admin dashboard)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS client_tags (
      id         SERIAL PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      tag_name   VARCHAR(50) NOT NULL,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, tag_name)
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_client_tags_user ON client_tags (user_id)`)

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

  // Message reactions — separate from community post_likes/post_reactions (those are
  // for community posts/comments; this is per-message reactions in 1:1 client_messages
  // threads, reactable by both the client and staff). Same emoji set as post_reactions
  // for visual consistency, but its own table since it hangs off a different parent row.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS message_reactions (
      id            SERIAL PRIMARY KEY,
      message_id    INTEGER NOT NULL REFERENCES client_messages(id) ON DELETE CASCADE,
      user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      reaction_type VARCHAR(10) NOT NULL CHECK (reaction_type IN ('like', 'love', 'laugh', 'care')),
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (message_id, user_id, reaction_type)
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_message_reactions_message ON message_reactions (message_id)`)

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
  //   { id, type, label, description, required, order, options, max_chars, condition }
  //   type: short_text | long_text | number | date | single_choice |
  //         multi_choice | yes_no | rating
  //   condition (optional, null by default): conditional-display rule —
  //     { questionId, operator: 'equals', value } — question is only shown
  //     when the answer to questionId equals value. No DB column needed;
  //     stored inline in the JSONB schema, so no migration is required.
  //     Only yes_no / single_choice / rating questions (fixed value sets)
  //     can be a condition's controlling question.

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
  await pool.query(`ALTER TABLE form_assignments ADD COLUMN IF NOT EXISTS parent_assignment_id INTEGER REFERENCES form_assignments(id) ON DELETE CASCADE`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_form_assignments_due ON form_assignments (next_send_at, status, is_active)`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_form_assignments_parent ON form_assignments (parent_assignment_id)`)

  // Form assignment tracking on submissions + metadata on messages (for in-app form delivery)
  await pool.query(`ALTER TABLE form_submissions ADD COLUMN IF NOT EXISTS assignment_id INTEGER REFERENCES form_assignments(id) ON DELETE SET NULL`)
  await pool.query(`ALTER TABLE client_messages  ADD COLUMN IF NOT EXISTS metadata JSONB`)
  await pool.query(`ALTER TABLE client_messages  ADD COLUMN IF NOT EXISTS audio_url TEXT`)
  // Soft-delete: a sender may delete their own message; the row is retained with deleted_at set.
  await pool.query(`ALTER TABLE client_messages  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`)
  // Per-staff conversation state: archive conversations, mark as unread
  await pool.query(`
    CREATE TABLE IF NOT EXISTS staff_inbox_states (
      staff_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      client_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      thread_type   TEXT NOT NULL,
      archived      BOOLEAN NOT NULL DEFAULT FALSE,
      archived_at   TIMESTAMPTZ,
      marked_unread BOOLEAN NOT NULL DEFAULT FALSE,
      PRIMARY KEY (staff_id, client_id, thread_type)
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_staff_inbox_states_staff ON staff_inbox_states (staff_id)`)
  // Staff review note per submission
  await pool.query(`ALTER TABLE form_submissions ADD COLUMN IF NOT EXISTS coach_note TEXT`)
  await pool.query(`ALTER TABLE form_submissions ADD COLUMN IF NOT EXISTS due_at TIMESTAMPTZ`)
  await pool.query(`ALTER TABLE form_submissions ADD COLUMN IF NOT EXISTS is_late BOOLEAN DEFAULT FALSE`)
  await pool.query(`ALTER TABLE form_submissions ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ`)
  await pool.query(`ALTER TABLE form_submissions ADD COLUMN IF NOT EXISTS completed_by INTEGER REFERENCES users(id) ON DELETE SET NULL`)
  // AI-generated coaching feedback for a submission — generated on staff demand,
  // regenerating overwrites the previous value (no history kept).
  await pool.query(`ALTER TABLE form_submissions ADD COLUMN IF NOT EXISTS ai_feedback TEXT`)
  await pool.query(`ALTER TABLE form_submissions ADD COLUMN IF NOT EXISTS ai_feedback_generated_at TIMESTAMPTZ`)
  await pool.query(`ALTER TABLE form_submissions ADD COLUMN IF NOT EXISTS ai_feedback_generated_by INTEGER REFERENCES users(id) ON DELETE SET NULL`)
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM form_submissions
        WHERE assignment_id IS NOT NULL
        GROUP BY assignment_id, user_id
        HAVING COUNT(*) > 1
      ) THEN
        CREATE UNIQUE INDEX IF NOT EXISTS idx_form_submissions_assignment_user_unique
          ON form_submissions (assignment_id, user_id)
          WHERE assignment_id IS NOT NULL;
      END IF;
    END $$;
  `)

  // ── Multi-tenancy: org_id scoping for forms (critical security isolation) ────
  // Moved below runMigrations() — see the block after that call. The FK here
  // targets organizations(id), which doesn't exist yet at this point in a fresh
  // bootstrap (organizations is created by 001_multi_tenancy.js, only run via
  // runMigrations() at the very end of migrate()), so this threw "relation
  // organizations does not exist" on any genuinely fresh DB.

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
      expires_at            TIMESTAMPTZ DEFAULT NOW() + INTERVAL '24 hours',
      accepted_at           TIMESTAMPTZ,
      accepted_by_user_id   INTEGER REFERENCES users(id) ON DELETE SET NULL
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_client_invites_email ON client_invites (LOWER(email))`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_client_invites_token ON client_invites (token)`)
  // Migration: shorten invite expiry from 30 days to 24 hours (idempotent)
  await pool.query(`ALTER TABLE client_invites ALTER COLUMN expires_at SET DEFAULT NOW() + INTERVAL '24 hours'`)
  // org_id: which org this client is being invited INTO — moved below
  // runMigrations() — see the block after that call. Depends on both
  // organizations(id) (the FK target) and users.org_id (read in the backfill's
  // COALESCE), neither of which exist yet at this point in a fresh bootstrap
  // (both come from 001_multi_tenancy.js's TENANT_TABLES loop), so this threw on
  // any genuinely fresh DB. Without it, claiming an invite left the new user on
  // getOrCreateUser's org_id = 1 fallback, so every non-LWC org's invited clients
  // silently landed in (and were only visible to) org 1 — see claimInvite and
  // getOrCreateUser below. Mirrors staff_invites.org_id.

  // ── Staff / Coach Invites ────────────────────────────────────────────────────
  // Invite tokens for new coaches/admins to join without a fake DB row first.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS staff_invites (
      id                  SERIAL PRIMARY KEY,
      token               TEXT NOT NULL UNIQUE DEFAULT gen_random_uuid()::text,
      email               TEXT NOT NULL,
      first_name          TEXT NOT NULL,
      last_name           TEXT,
      role                TEXT NOT NULL DEFAULT 'coach' CHECK (role IN ('coach', 'admin')),
      invited_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at          TIMESTAMPTZ DEFAULT NOW(),
      expires_at          TIMESTAMPTZ DEFAULT NOW() + INTERVAL '24 hours',
      accepted_at         TIMESTAMPTZ,
      accepted_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_staff_invites_email ON staff_invites (LOWER(email))`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_staff_invites_token ON staff_invites (token)`)
  // Widen staff_invites.role CHECK to add 'va' — client onboarding/transition
  // staff role, scoped narrowly in server/routes/coachAdmin.js.
  await pool.query(`
    DO $$ BEGIN
      ALTER TABLE staff_invites DROP CONSTRAINT IF EXISTS staff_invites_role_check;
      ALTER TABLE staff_invites ADD CONSTRAINT staff_invites_role_check
        CHECK (role IN ('coach', 'admin', 'va'));
    END $$;
  `)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_name TEXT`)
  await pool.query(`ALTER TABLE community_posts ADD COLUMN IF NOT EXISTS channel TEXT DEFAULT 'vip'`)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS activity_logs (
      id               SERIAL PRIMARY KEY,
      user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      activity_type    TEXT    NOT NULL,
      duration_minutes INTEGER,
      notes            TEXT,
      logged_at        TIMESTAMPTZ DEFAULT NOW()
    )
  `)
  // High-growth read paths for 100+ active clients.
  // Each index is attempted individually so a single failure cannot block
  // subsequent table creation. The original expression index on COALESCE(log_date,
  // logged_at::date) used a timezone-dependent TIMESTAMPTZ cast which PostgreSQL
  // rejects as non-IMMUTABLE; replaced with a simple two-column index below.
  for (const idxSql of [
    `CREATE INDEX IF NOT EXISTS idx_meals_user_log_date            ON meals (user_id, log_date)`,
    `CREATE INDEX IF NOT EXISTS idx_meals_user_logged_at           ON meals (user_id, logged_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_users_assigned_coach           ON users (assigned_coach_id)`,
    `CREATE INDEX IF NOT EXISTS idx_users_role_client_status       ON users (role, client_status)`,
    `CREATE INDEX IF NOT EXISTS idx_client_messages_unread         ON client_messages (client_id, read_at)`,
    `CREATE INDEX IF NOT EXISTS idx_client_messages_sender_unread  ON client_messages (client_id, sender_role, read_at)`,
    `CREATE INDEX IF NOT EXISTS idx_community_posts_feed           ON community_posts (channel, pinned, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_post_comments_post_created     ON post_comments (post_id, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_post_likes_post                ON post_likes (post_id)`,
    `CREATE INDEX IF NOT EXISTS idx_post_reactions_post_created    ON post_reactions (post_id, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_notifications_user_read        ON notifications (user_id, read)`,
    `CREATE INDEX IF NOT EXISTS idx_progress_photos_user_taken     ON progress_photos (user_id, taken_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_activity_logs_user_logged_at   ON activity_logs (user_id, logged_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_form_submissions_review_queue  ON form_submissions (reviewed_at, submitted_at DESC)`,
  ]) {
    try { await pool.query(idxSql) } catch (e) { console.warn('[migration] index skipped:', e.message) }
  }
  // org_id is added below via TENANT_TABLES in 001_multi_tenancy.js (runs after
  // this migrate() call, once the organizations table exists) rather than as a
  // column here, so the existing-install path and the fresh-install path take
  // the same code. Every route in routes/communityResources.js filters on it.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS community_resources (
      id            SERIAL PRIMARY KEY,
      title         TEXT    NOT NULL,
      description   TEXT,
      resource_type TEXT    NOT NULL DEFAULT 'link',
      url           TEXT    NOT NULL,
      category      TEXT,
      display_order INTEGER NOT NULL DEFAULT 0,
      published     BOOLEAN NOT NULL DEFAULT FALSE,
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      updated_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `)
  // display_order predates manual reordering UI and was always left at its
  // default of 0. Backfill distinct values from the existing created_at
  // sequence once so drag/drop has real positions to work with — guarded so
  // it never overwrites an ordering an admin has already customized.
  await pool.query(`
    DO $$
    BEGIN
      IF (SELECT COUNT(DISTINCT display_order) FROM community_resources) <= 1
         AND (SELECT COUNT(*) FROM community_resources) > 0 THEN
        UPDATE community_resources cr
        SET display_order = sub.rn * 10
        FROM (
          SELECT id, ROW_NUMBER() OVER (ORDER BY created_at ASC, id ASC) AS rn
          FROM community_resources
        ) sub
        WHERE cr.id = sub.id;
      END IF;
    END $$;
  `)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mindset_videos (
      id            SERIAL PRIMARY KEY,
      title         TEXT    NOT NULL,
      description   TEXT,
      youtube_url   TEXT    NOT NULL,
      published     BOOLEAN NOT NULL DEFAULT FALSE,
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      updated_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `)
  // Newest-first ordering replaced manual module/order fields — drop them from
  // tables created before this migration.
  await pool.query(`ALTER TABLE mindset_videos DROP COLUMN IF EXISTS module_name`)
  await pool.query(`ALTER TABLE mindset_videos DROP COLUMN IF EXISTS display_order`)

  // ── Video watch progress ─────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS video_watch_progress (
      id               SERIAL PRIMARY KEY,
      user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      video_id         INTEGER NOT NULL REFERENCES mindset_videos(id) ON DELETE CASCADE,
      started          BOOLEAN NOT NULL DEFAULT FALSE,
      highest_pct      NUMERIC(5,1) NOT NULL DEFAULT 0,
      completed        BOOLEAN NOT NULL DEFAULT FALSE,
      first_watched_at TIMESTAMPTZ,
      last_watched_at  TIMESTAMPTZ,
      UNIQUE (user_id, video_id)
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_video_watch_user ON video_watch_progress (user_id)`)
  // Defensive column additions — guard against tables created before full schema was in place
  await pool.query(`ALTER TABLE video_watch_progress ADD COLUMN IF NOT EXISTS started          BOOLEAN      NOT NULL DEFAULT FALSE`)
  await pool.query(`ALTER TABLE video_watch_progress ADD COLUMN IF NOT EXISTS highest_pct      NUMERIC(5,1) NOT NULL DEFAULT 0`)
  await pool.query(`ALTER TABLE video_watch_progress ADD COLUMN IF NOT EXISTS completed        BOOLEAN      NOT NULL DEFAULT FALSE`)
  await pool.query(`ALTER TABLE video_watch_progress ADD COLUMN IF NOT EXISTS first_watched_at TIMESTAMPTZ`)
  await pool.query(`ALTER TABLE video_watch_progress ADD COLUMN IF NOT EXISTS last_watched_at  TIMESTAMPTZ`)

  // ── Brain Mapping video comments & reactions ─────────────────────────────────
  // video_id references mindset_videos(id) — the actual stable identifier used
  // by the Brain Mapping video list (Community.jsx MindsetTab), confirmed in code.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS brain_mapping_comments (
      id            SERIAL PRIMARY KEY,
      video_id      INTEGER NOT NULL REFERENCES mindset_videos(id) ON DELETE CASCADE,
      user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      comment_text  TEXT    NOT NULL CHECK (char_length(comment_text) <= 500),
      created_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_bm_comments_video ON brain_mapping_comments (video_id)`)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS brain_mapping_reactions (
      id             SERIAL PRIMARY KEY,
      comment_id     INTEGER NOT NULL REFERENCES brain_mapping_comments(id) ON DELETE CASCADE,
      user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      reaction_type  TEXT    NOT NULL CHECK (reaction_type IN ('like', 'love', 'fire')),
      created_at     TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (comment_id, user_id, reaction_type)
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_bm_reactions_comment ON brain_mapping_reactions (comment_id)`)

  // Video-level reactions — separate from per-comment reactions above; a user
  // reacts to the video itself, not to any particular comment.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS brain_mapping_video_reactions (
      id             SERIAL PRIMARY KEY,
      video_id       INTEGER NOT NULL REFERENCES mindset_videos(id) ON DELETE CASCADE,
      user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      reaction_type  TEXT    NOT NULL CHECK (reaction_type IN ('like', 'love', 'fire')),
      created_at     TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (video_id, user_id, reaction_type)
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_bm_video_reactions_video ON brain_mapping_video_reactions (video_id)`)

  // ── Client Measurements ───────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS client_measurements (
      id               SERIAL PRIMARY KEY,
      user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      measurement_date DATE NOT NULL DEFAULT CURRENT_DATE,
      chest            NUMERIC(5,1),
      waist            NUMERIC(5,1),
      hips             NUMERIC(5,1),
      created_at       TIMESTAMPTZ DEFAULT NOW(),
      updated_at       TIMESTAMPTZ DEFAULT NOW()
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_client_measurements_user ON client_measurements (user_id, measurement_date DESC)`)

  // ── Scheduled job locking ────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS job_locks (
      job_name     TEXT PRIMARY KEY,
      locked_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      locked_until TIMESTAMPTZ NOT NULL
    )
  `)

  // ── Bloodwork uploads ─────────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bloodwork_uploads (
      id                    SERIAL PRIMARY KEY,
      user_id               INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      cloudinary_public_id  TEXT NOT NULL,
      original_filename     TEXT,
      mime_type             TEXT,
      lab_date              DATE,
      notes                 TEXT,
      extracted_text        TEXT,
      ai_summary            TEXT,
      status                TEXT NOT NULL DEFAULT 'active',
      deleted               BOOLEAN NOT NULL DEFAULT FALSE,
      created_at            TIMESTAMPTZ DEFAULT NOW(),
      updated_at            TIMESTAMPTZ DEFAULT NOW()
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_bloodwork_user_date ON bloodwork_uploads (user_id, lab_date DESC, created_at DESC)`)
  await pool.query(`ALTER TABLE bloodwork_uploads ADD COLUMN IF NOT EXISTS ai_client_summary TEXT`)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS bloodwork_enabled BOOLEAN NOT NULL DEFAULT FALSE`)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bloodwork_intake (
      id                       SERIAL PRIMARY KEY,
      user_id                  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      conditions               JSONB    NOT NULL DEFAULT '[]',
      medication_categories    JSONB    NOT NULL DEFAULT '[]',
      confirmed_age            INTEGER,
      confirmed_sex            TEXT,
      confirmed_height_inches  NUMERIC(5,1),
      confirmed_weight_lbs     NUMERIC(6,1),
      notes                    TEXT,
      created_at               TIMESTAMPTZ DEFAULT NOW(),
      updated_at               TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (user_id)
    )
  `)

  // ── Usage analytics ──────────────────────────────────────────────────────────

  // Cost rate table — editable without a deploy. Seeded with Anthropic prices.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS usage_cost_rates (
      id          SERIAL PRIMARY KEY,
      rate_key    TEXT          NOT NULL UNIQUE,
      rate_usd    NUMERIC(16,8) NOT NULL,
      description TEXT,
      active      BOOLEAN       NOT NULL DEFAULT TRUE,
      updated_at  TIMESTAMPTZ   DEFAULT NOW()
    )
  `)
  // Seed default rates (idempotent via ON CONFLICT DO NOTHING)
  await pool.query(`
    INSERT INTO usage_cost_rates (rate_key, rate_usd, description) VALUES
      ('claude-sonnet-4-6:input_per_1m',            3.00,     'Claude Sonnet 4.6 input — per 1M tokens'),
      ('claude-sonnet-4-6:output_per_1m',           15.00,    'Claude Sonnet 4.6 output — per 1M tokens'),
      ('claude-3-5-sonnet-20241022:input_per_1m',   3.00,     'Claude 3.5 Sonnet input — per 1M tokens'),
      ('claude-3-5-sonnet-20241022:output_per_1m',  15.00,    'Claude 3.5 Sonnet output — per 1M tokens'),
      ('claude-haiku-4-5-20251001:input_per_1m',    0.80,     'Claude Haiku 4.5 input — per 1M tokens'),
      ('claude-haiku-4-5-20251001:output_per_1m',   4.00,     'Claude Haiku 4.5 output — per 1M tokens'),
      ('claude-3-haiku-20240307:input_per_1m',      0.25,     'Claude 3 Haiku input — per 1M tokens'),
      ('claude-3-haiku-20240307:output_per_1m',     1.25,     'Claude 3 Haiku output — per 1M tokens'),
      ('claude-3-5-haiku-20241022:input_per_1m',    0.80,     'Claude 3.5 Haiku input — per 1M tokens'),
      ('claude-3-5-haiku-20241022:output_per_1m',   4.00,     'Claude 3.5 Haiku output — per 1M tokens'),
      ('cloudinary:image_upload_per_mb',            0.00025,  'Cloudinary image storage/bandwidth per MB')
    ON CONFLICT (rate_key) DO NOTHING
  `)

  // Append-only usage events — one row per tracked action.
  // company_id is nullable for future SaaS multi-tenancy.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS usage_events (
      id                  BIGSERIAL    PRIMARY KEY,
      occurred_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      actor_user_id       INTEGER      REFERENCES users(id) ON DELETE SET NULL,
      target_user_id      INTEGER      REFERENCES users(id) ON DELETE SET NULL,
      company_id          INTEGER,
      feature             TEXT         NOT NULL,
      action              TEXT         NOT NULL,
      provider            TEXT,
      provider_operation  TEXT,
      model               TEXT,
      input_tokens        INTEGER,
      output_tokens       INTEGER,
      file_count          INTEGER,
      bytes_in            BIGINT,
      estimated_cost_usd  NUMERIC(16,8),
      unit_cost_snapshot  JSONB,
      status              TEXT         NOT NULL DEFAULT 'success',
      duration_ms         INTEGER,
      metadata            JSONB,
      created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_usage_events_actor    ON usage_events (actor_user_id,  occurred_at DESC)`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_usage_events_target   ON usage_events (target_user_id, occurred_at DESC)`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_usage_events_time     ON usage_events (occurred_at DESC)`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_usage_events_feature  ON usage_events (feature, occurred_at DESC)`)

  // ── Meal planning preferences ─────────────────────────────────────────────
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS food_dislikes  TEXT`)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS food_allergies TEXT`)

  // ── Remove old onboarding gate — mark all users as onboarding_complete ──────
  // The multi-step onboarding form (name/gender/age/height/weight) is removed.
  // New post-signup flow is: Health Assessment → Identity Traits → Enter app.
  // Mark every existing user onboarding_complete=TRUE so nobody gets stuck.
  await pool.query(`UPDATE users SET onboarding_complete = TRUE WHERE onboarding_complete = FALSE OR onboarding_complete IS NULL`)

  // ── Push notification foundation ─────────────────────────────────────────────
  // Device tokens for push notifications (FCM). Multiple devices per user allowed.
  // platform: 'android' | 'ios' | 'web'
  await pool.query(`
    CREATE TABLE IF NOT EXISTS push_devices (
      id           SERIAL PRIMARY KEY,
      user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token        TEXT NOT NULL UNIQUE,
      platform     TEXT NOT NULL DEFAULT 'android',
      created_at   TIMESTAMPTZ DEFAULT NOW(),
      last_used_at TIMESTAMPTZ DEFAULT NOW()
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_push_devices_user ON push_devices (user_id)`)
  // Notification preferences on users
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS notif_master_enabled    BOOLEAN NOT NULL DEFAULT TRUE`)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS notif_dm_enabled        BOOLEAN NOT NULL DEFAULT TRUE`)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS notif_community_enabled BOOLEAN NOT NULL DEFAULT TRUE`)

  // ── Exercise Library (Programming Guide schema) ─────────────────────────────
  // Structural catalog + templating config for a future template-driven workout
  // generator. Schema + seed data only — no assembly/generation logic yet (separate
  // build). Additive: does not touch the existing `exercises` catalog (seeded from
  // free-exercise-db, see server/scripts/import-exercises.js) or the
  // workouts/workout_exercises tables backing the current Katie-generated programs.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS exercise_library (
      id                 SERIAL PRIMARY KEY,
      name               TEXT NOT NULL,
      category           TEXT NOT NULL CHECK (category IN (
                            'foam_roll', 'mobility', 'lengthen', 'combo_mobility',
                            'activation', 'mini_band', 'big_band', 'plyo', 'core',
                            'main_lift', 'finisher', 'stretch'
                          )),
      movement_pattern   TEXT CHECK (movement_pattern IN (
                            'hinge', 'squat', 'vertical_push', 'vertical_pull',
                            'horizontal_push', 'horizontal_pull', 'lift', 'carry'
                          )),
      core_subtype       TEXT CHECK (core_subtype IN (
                            'anti_extension', 'anti_rotation', 'anti_lateral_flexion'
                          )),
      plyo_level         INTEGER CHECK (plyo_level BETWEEN 1 AND 4),
      plyo_type          TEXT CHECK (plyo_type IN ('jump', 'hop', 'bound', 'skip')),
      equipment_required TEXT[] NOT NULL DEFAULT '{}',
      level_min          TEXT NOT NULL DEFAULT 'beginner' CHECK (level_min IN ('beginner', 'intermediate', 'advanced')),
      unilateral         BOOLEAN NOT NULL DEFAULT FALSE,
      plane              TEXT CHECK (plane IN ('linear', 'lateral')),
      instructions       TEXT,
      source_program     TEXT,
      active             BOOLEAN NOT NULL DEFAULT TRUE,
      created_at         TIMESTAMPTZ DEFAULT NOW()
    )
  `)
  // Composite uniqueness (not just name) — the same exercise name legitimately
  // recurs across different circuits/programs (e.g. "Windmills" in both the PVC
  // Stick mobility drills and the medicine ball power list) as distinct rows.
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS exercise_library_name_source_uq ON exercise_library (name, source_program)`)
  await pool.query(`CREATE INDEX IF NOT EXISTS exercise_library_category_idx ON exercise_library (category)`)
  // Optional link to the legacy free-exercise-db `exercises` table (873 rows,
  // seeded from the original import) purely for media reuse — exercise_library
  // was never seeded with its own image/video. Nullable: only ~20% of
  // exercise_library rows have a name-matching legacy row (see
  // server/scripts/match-legacy-exercise-media.js); the rest are
  // Programming-Guide-specific drills that never existed in that import and
  // have no media to link. ON DELETE SET NULL so a legacy row disappearing
  // never blocks deleting it.
  await pool.query(`ALTER TABLE exercise_library ADD COLUMN IF NOT EXISTS legacy_exercise_id INTEGER REFERENCES exercises(id) ON DELETE SET NULL`)
  await pool.query(`CREATE INDEX IF NOT EXISTS exercise_library_legacy_exercise_idx ON exercise_library (legacy_exercise_id)`)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS program_templates (
      id               SERIAL PRIMARY KEY,
      session_length   INTEGER NOT NULL CHECK (session_length IN (20, 30, 45, 60, 90)),
      block_order      INTEGER NOT NULL,
      block_type       TEXT NOT NULL CHECK (block_type IN (
                          'foam_roll', 'mobility', 'activation', 'plyo', 'core', 'circuit', 'stretch'
                        )),
      time_minutes_min INTEGER NOT NULL,
      time_minutes_max INTEGER NOT NULL,
      slot_count       INTEGER NOT NULL,
      created_at       TIMESTAMPTZ DEFAULT NOW()
    )
  `)
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS program_templates_length_order_uq ON program_templates (session_length, block_order)`)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS program_day_patterns (
      id               SERIAL PRIMARY KEY,
      day_label        TEXT NOT NULL CHECK (day_label IN ('A', 'B')),
      movement_pattern TEXT NOT NULL CHECK (movement_pattern IN (
                          'hinge', 'squat', 'vertical_push', 'vertical_pull',
                          'horizontal_push', 'horizontal_pull', 'lift', 'carry'
                        )),
      sequence         INTEGER NOT NULL,
      created_at       TIMESTAMPTZ DEFAULT NOW()
    )
  `)
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS program_day_patterns_label_seq_uq ON program_day_patterns (day_label, sequence)`)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS volume_rules (
      id         SERIAL PRIMARY KEY,
      goal       TEXT NOT NULL UNIQUE CHECK (goal IN ('strength', 'power', 'hypertrophy', 'endurance')),
      rep_range  TEXT NOT NULL,
      sets_min   INTEGER NOT NULL,
      sets_max   INTEGER NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `)

  // 'mobility' added for the Flexibility/Mobility goal (coach-facing generator) —
  // sets_min/sets_max = 0 signals "skip main-lift work entirely" to
  // buildMainWork() (see workoutAssembly/assembleSession.js). Table predates
  // this goal so the original inline CHECK must be dropped and re-added rather
  // than edited in place.
  await pool.query(`ALTER TABLE volume_rules DROP CONSTRAINT IF EXISTS volume_rules_goal_check`)
  await pool.query(`
    ALTER TABLE volume_rules ADD CONSTRAINT volume_rules_goal_check
      CHECK (goal IN ('strength', 'power', 'hypertrophy', 'endurance', 'mobility'))
  `)

  // Seed program_templates — 60-min layout is the guide's baseline; 20/45/90 scale
  // time + slot_count proportionally (0.33x / 0.75x / 1.5x); 30-min uses the guide's
  // own explicit ranges directly (Workout Prep + Stretch are "on own" => slot_count 0
  // at 30 min only). The guide gives time ranges but never slot_count for any
  // duration — these slot_count values are a reasonable starting baseline for a
  // future generator to refine, not a source-given prescription. Workout Prep in the
  // guide covers two block_types here (foam_roll, mobility); the guide doesn't split
  // its 6-10 min range between them, so both blocks share the same range.
  await pool.query(`
    INSERT INTO program_templates (session_length, block_order, block_type, time_minutes_min, time_minutes_max, slot_count) VALUES
      (20, 1, 'foam_roll',  2,  3, 1),
      (20, 2, 'mobility',   2,  3, 1),
      (20, 3, 'activation', 2,  2, 1),
      (20, 4, 'plyo',       2,  2, 1),
      (20, 5, 'core',       1,  1, 1),
      (20, 6, 'circuit',    8, 12, 2),
      (20, 7, 'stretch',    2,  2, 1),

      (30, 1, 'foam_roll',  0,  0, 0),
      (30, 2, 'mobility',   0,  0, 0),
      (30, 3, 'activation', 2,  3, 1),
      (30, 4, 'plyo',       2,  3, 1),
      (30, 5, 'core',       1,  2, 1),
      (30, 6, 'circuit',   17, 22, 4),
      (30, 7, 'stretch',    0,  0, 0),

      (45, 1, 'foam_roll',  5,  8, 2),
      (45, 2, 'mobility',   5,  8, 3),
      (45, 3, 'activation', 4,  5, 2),
      (45, 4, 'plyo',       4,  4, 1),
      (45, 5, 'core',       2,  2, 2),
      (45, 6, 'circuit',   19, 26, 5),
      (45, 7, 'stretch',    4,  4, 2),

      (60, 1, 'foam_roll',  6, 10, 2),
      (60, 2, 'mobility',   6, 10, 4),
      (60, 3, 'activation', 5,  7, 3),
      (60, 4, 'plyo',       5,  5, 1),
      (60, 5, 'core',       2,  3, 2),
      (60, 6, 'circuit',   25, 35, 6),
      (60, 7, 'stretch',    5,  5, 3),

      (90, 1, 'foam_roll',  9, 15, 3),
      (90, 2, 'mobility',   9, 15, 6),
      (90, 3, 'activation', 8, 11, 5),
      (90, 4, 'plyo',       8,  8, 2),
      (90, 5, 'core',       3,  5, 3),
      (90, 6, 'circuit',   38, 53, 9),
      (90, 7, 'stretch',    8,  8, 5)
    ON CONFLICT (session_length, block_order) DO NOTHING
  `)

  // Seed program_day_patterns from the guide's sample movement layout
  await pool.query(`
    INSERT INTO program_day_patterns (day_label, movement_pattern, sequence) VALUES
      ('A', 'squat',           1),
      ('A', 'horizontal_pull', 2),
      ('A', 'horizontal_push', 3),
      ('A', 'carry',           4),
      ('B', 'hinge',           1),
      ('B', 'vertical_pull',   2),
      ('B', 'vertical_push',   3),
      ('B', 'lift',            4)
    ON CONFLICT (day_label, sequence) DO NOTHING
  `)

  // Seed volume_rules from the guide's volume/intensity table
  await pool.query(`
    INSERT INTO volume_rules (goal, rep_range, sets_min, sets_max) VALUES
      ('strength',    '<6',   2, 6),
      ('power',       '3-5',  3, 5),
      ('hypertrophy', '6-12', 3, 5),
      ('endurance',   '>12',  2, 3)
    ON CONFLICT (goal) DO NOTHING
  `)

  // INVENTED — 'mobility' has no source in the guide's volume/intensity table
  // (that table only covers strength/power/hypertrophy/endurance main-lift
  // work). sets_min/sets_max = 0 is a deliberate signal, not a placeholder
  // gap: getMainLiftVolume() returns sets: 0 for this goal with no code
  // change, and buildMainWork() (workoutAssembly/assembleSession.js) treats
  // sets === 0 as "skip main-lift work for this session" so a mobility
  // session never forces a squat/hinge pick. rep_range is unused when
  // sets = 0 but kept non-null to satisfy the NOT NULL constraint.
  await pool.query(`
    INSERT INTO volume_rules (goal, rep_range, sets_min, sets_max) VALUES
      ('mobility', 'n/a', 0, 0)
    ON CONFLICT (goal) DO NOTHING
  `)

  // Admin-entered corrections pulled into Katie's context at answer-time so a
  // wrong/hedged answer can be fixed without a code deploy. org_id (populated via
  // the multi-tenancy migration's TENANT_TABLES backfill) scopes each correction
  // to the org that authored it — see getKatieCorrections in katieCorrections.js.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS katie_corrections (
      id               SERIAL PRIMARY KEY,
      org_id           INTEGER,
      trigger_keywords TEXT[]      NOT NULL,
      correct_answer   TEXT        NOT NULL,
      created_by       INTEGER     REFERENCES users(id) ON DELETE SET NULL,
      active           BOOLEAN     NOT NULL DEFAULT TRUE,
      created_at       TIMESTAMPTZ DEFAULT NOW()
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_katie_corrections_active ON katie_corrections (active)`)

  // ── Staff Team Communication (Slack-style channels + DMs, coaches/admins only) ──
  // Entirely separate from client_messages — clients never see or query this.
  // org_id is added below via TENANT_TABLES in 001_multi_tenancy.js (runs after
  // this migrate() call, once the organizations table exists) rather than as a
  // direct FK here, matching how every other post-launch table in this codebase
  // picks up multi-tenancy scoping.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS staff_channels (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      is_private BOOLEAN DEFAULT false,
      created_by INTEGER REFERENCES users(id),
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS staff_channel_members (
      channel_id INTEGER REFERENCES staff_channels(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY (channel_id, user_id)
    )
  `)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS staff_messages (
      id SERIAL PRIMARY KEY,
      channel_id INTEGER REFERENCES staff_channels(id) ON DELETE CASCADE,
      sender_id INTEGER REFERENCES users(id),
      message_body TEXT,
      audio_url TEXT,
      attachment_url TEXT,
      attachment_name TEXT,
      is_pinned BOOLEAN DEFAULT false,
      pinned_by INTEGER REFERENCES users(id),
      pinned_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_staff_messages_channel ON staff_messages (channel_id, created_at)`)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS staff_message_reads (
      message_id INTEGER REFERENCES staff_messages(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      read_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (message_id, user_id)
    )
  `)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS staff_direct_messages (
      id SERIAL PRIMARY KEY,
      sender_id INTEGER REFERENCES users(id),
      recipient_id INTEGER REFERENCES users(id),
      message_body TEXT,
      audio_url TEXT,
      attachment_url TEXT,
      attachment_name TEXT,
      is_pinned BOOLEAN DEFAULT false,
      pinned_by INTEGER REFERENCES users(id),
      pinned_at TIMESTAMPTZ,
      read_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_staff_dm_participants      ON staff_direct_messages (sender_id, recipient_id, created_at)`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_staff_dm_recipient_unread ON staff_direct_messages (recipient_id, read_at)`)

  // NOTE: this used to auto-seed a default #coachingteam channel per org (and
  // auto-join that org's staff into it) on every startup. Removed — org
  // owners now set up their own channels manually after onboarding. Any
  // #coachingteam channel already in the DB (e.g. LWC/org_id 1) is untouched;
  // this just stops the seed from running for orgs that don't have one.
  //
  // The stray cross-org membership cleanup that used to run here (self-healing
  // fix for a past bug where the seed above CROSS JOINed every staff user
  // against a single globally name-guarded channel) is now below runMigrations()
  // — see the block after that call — since it reads staff_channels.org_id and
  // users.org_id, neither of which exist yet at this point in a fresh bootstrap.
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

  // ── TEMPORARY: circuit generation diagnostics ────────────────────────────────
  // Investigating a ~2.8% failure rate where a client requests circuits
  // (answers.circuits != 'none') but the generated plan silently comes back
  // with no circuit-grouped exercises on one or more days — see
  // onCircuitDiagnostic / recordCircuitDiagnostics in workoutGenerator.js.
  // Insert-only from the app's perspective: nothing in generation ever reads
  // this table back, so it cannot affect what a client is handed. Staging only
  // for now — remove this table and its call sites once the root cause behind
  // the failure rate is confirmed and fixed.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS workout_circuit_diagnostics (
      id               SERIAL PRIMARY KEY,
      user_id          INTEGER REFERENCES users(id) ON DELETE SET NULL,
      org_id           INTEGER,
      created_at       TIMESTAMPTZ DEFAULT NOW(),
      circuits_answer  TEXT,
      supersets_answer TEXT,
      days_per_week    INTEGER,
      session_length   TEXT,
      day_index        INTEGER,
      day_name         TEXT,
      reason           TEXT NOT NULL,
      detail           JSONB
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_workout_circuit_diagnostics_reason ON workout_circuit_diagnostics (reason, created_at)`)

  await runMigrations()
}

// Multi-tenancy foundation migration (server/migrations/001_multi_tenancy.js).
// Idempotent by design — safe to call on every server startup alongside migrate().
// Failure is logged only, never crashes the server: the app must keep running
// single-tenant (org_id nullable, resolveOrgId() falls back to 1) even if this
// migration hasn't been applied yet.
export async function runMigrations() {
  try {
    const { default: runMultiTenancyMigration } = await import('./migrations/001_multi_tenancy.js')
    await runMultiTenancyMigration(pool)
    console.log('[migrations] 001_multi_tenancy applied successfully')

    // org_id: set only by the super-admin "invite org owner" flow
    // (server/routes/organizations.js) so a brand-new user created via
    // getOrCreateUser() lands in the right org instead of defaulting to
    // org_id = 1. NULL for ordinary staff invites (coachAdmin.js), which are
    // always accepted by someone already scoped to the inviting admin's org.
    // Must run after runMultiTenancyMigration — organizations doesn't exist before that.
    await pool.query(`ALTER TABLE staff_invites ADD COLUMN IF NOT EXISTS org_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL`)
  } catch (err) {
    console.error('[migrations] 001_multi_tenancy failed:', err.message)
  }

  // One-time (self-healing) cleanup for stray cross-org staff_channel_members
  // rows left over from a past bug where a since-removed #coachingteam auto-seed
  // CROSS JOINed every staff user against a single globally name-guarded channel,
  // so every org's admins got auto-joined into whichever org created
  // "coachingteam" first — confirmed exploited on staging (org 2 admins were
  // members of org 1's private channel). Platform super admins are allowed
  // cross-org membership (they manage channels across every org via the app), so
  // they're exempt. Moved here (from migrate()'s main body, before this function
  // was ever called) — reads staff_channels.org_id and users.org_id, neither of
  // which exist until 001_multi_tenancy just above adds them, so this threw
  // "column c.org_id does not exist" on any genuinely fresh DB.
  try {
    if (ADMIN_EMAILS.length > 0) {
      const placeholders = ADMIN_EMAILS.map((_, i) => `$${i + 1}`).join(', ')
      await pool.query(
        `DELETE FROM staff_channel_members cm
         USING staff_channels c, users u
         WHERE cm.channel_id = c.id
           AND cm.user_id = u.id
           AND c.org_id IS NOT NULL
           AND u.org_id IS NOT NULL
           AND c.org_id != u.org_id
           AND LOWER(u.email) NOT IN (${placeholders})`,
        ADMIN_EMAILS.map(e => e.toLowerCase()),
      )
    } else {
      await pool.query(`
        DELETE FROM staff_channel_members cm
        USING staff_channels c, users u
        WHERE cm.channel_id = c.id
          AND cm.user_id = u.id
          AND c.org_id IS NOT NULL
          AND u.org_id IS NOT NULL
          AND c.org_id != u.org_id
      `)
    }
  } catch (err) {
    console.error('[migrations] stray cross-org staff_channel_members cleanup failed:', err.message)
  }

  // Backfill org_id on workout rows. Required, not cosmetic: coachAdmin.js's
  // INSERTs used to omit org_id entirely, so every coach-built program and
  // exercise carries org_id IS NULL. Now that the UPDATE/DELETE routes there
  // filter on org_id, those legacy rows would be uneditable and undeletable
  // without this. Derived from the owning user (workouts.user_id), which is the
  // same source the INSERTs now use. Idempotent — only touches NULL rows. Moved
  // here (from migrate()'s main body, before this function was ever called) —
  // workouts.org_id/workout_exercises.org_id/users.org_id don't exist until
  // 001_multi_tenancy just above adds them, so this threw "column w.org_id does
  // not exist" on any genuinely fresh DB. Every current INSERT INTO
  // workouts/workout_exercises already sets org_id explicitly (routes/workouts.js,
  // routes/coachAdmin.js), so this only ever affects pre-multi-tenancy legacy
  // rows, not new ones — running it after TENANT_TABLES' own blanket "org_id = 1
  // WHERE org_id IS NULL" backfill (just above, inside 001_multi_tenancy) doesn't
  // leave anything for this more precise pass to correct today, but it's kept
  // here (rather than deleted) as a no-op safety net in case that assumption
  // ever changes.
  try {
    await pool.query(`
      UPDATE workouts w SET org_id = u.org_id
      FROM users u WHERE u.id = w.user_id AND w.org_id IS NULL AND u.org_id IS NOT NULL
    `)
    await pool.query(`
      UPDATE workout_exercises we SET org_id = w.org_id
      FROM workouts w WHERE w.id = we.workout_id AND we.org_id IS NULL AND w.org_id IS NOT NULL
    `)
  } catch (err) {
    console.error('[migrations] workouts org_id backfill failed:', err.message)
  }

  // ── Multi-tenancy: org_id scoping for forms (critical security isolation) ────
  // Moved here (from migrate()'s main body, before this function was ever
  // called) for the same reason as the workouts backfill above — organizations,
  // the FK target, doesn't exist until 001_multi_tenancy just above creates it.
  // Unlike workouts/workout_exercises, none of these 4 tables are in
  // TENANT_TABLES, so there's no competing blanket backfill to worry about
  // ordering against here.
  try {
    await pool.query(`ALTER TABLE form_templates ADD COLUMN IF NOT EXISTS org_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE`)
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_form_templates_org ON form_templates (org_id)`)
    await pool.query(`ALTER TABLE form_versions ADD COLUMN IF NOT EXISTS org_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE`)
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_form_versions_org ON form_versions (org_id)`)
    await pool.query(`ALTER TABLE form_submissions ADD COLUMN IF NOT EXISTS org_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE`)
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_form_submissions_org ON form_submissions (org_id)`)
    await pool.query(`ALTER TABLE form_assignments ADD COLUMN IF NOT EXISTS org_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE`)
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_form_assignments_org ON form_assignments (org_id)`)
    // Backfill: assign existing forms to org_id = 1 (seed org)
    await pool.query(`UPDATE form_templates SET org_id = 1 WHERE org_id IS NULL`)
    await pool.query(`UPDATE form_versions SET org_id = 1 WHERE org_id IS NULL`)
    await pool.query(`UPDATE form_submissions SET org_id = 1 WHERE org_id IS NULL`)
    await pool.query(`UPDATE form_assignments SET org_id = 1 WHERE org_id IS NULL`)
  } catch (err) {
    console.error('[migrations] forms org_id scoping failed:', err.message)
  }

  // org_id: which org an invited client is being invited INTO — moved here (from
  // migrate()'s main body, before this function was ever called) for the same
  // reason: depends on organizations (the FK target) and users.org_id (read in
  // the backfill's COALESCE below), neither of which exist until
  // 001_multi_tenancy just above runs. Without it, claiming an invite left the
  // new user on getOrCreateUser's org_id = 1 fallback, so every non-LWC org's
  // invited clients silently landed in (and were only visible to) org 1 — see
  // claimInvite and getOrCreateUser below. Mirrors staff_invites.org_id.
  try {
    await pool.query(`ALTER TABLE client_invites ADD COLUMN IF NOT EXISTS org_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL`)
    // Backfill legacy rows from whoever issued them (inviting staff member, else
    // the pre-assigned coach) — the same COALESCE the pending-invite routes in
    // coachAdmin.js already used to derive an invite's org before this column
    // existed. Anything still unresolved is org 1, which is where those rows
    // landed anyway.
    await pool.query(`
      UPDATE client_invites ci
      SET org_id = COALESCE(
        (SELECT u.org_id FROM users u WHERE u.id = ci.invited_by),
        (SELECT u.org_id FROM users u WHERE u.id = ci.assigned_coach_id),
        1
      )
      WHERE ci.org_id IS NULL
    `)
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_client_invites_org_id ON client_invites (org_id)`)
  } catch (err) {
    console.error('[migrations] client_invites org_id backfill failed:', err.message)
  }

  // community_groups: org-manageable categories/channels backing the community
  // post "category" field (server/routes/community.js, client Community.jsx).
  // Previously this was a hardcoded 2-item list in both files that no one but a
  // developer could change. Must run after runMultiTenancyMigration —
  // organizations doesn't exist before that.
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS community_groups (
        id             SERIAL PRIMARY KEY,
        org_id         INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        name           TEXT NOT NULL,
        description    TEXT,
        type           TEXT NOT NULL DEFAULT 'public' CHECK (type IN ('public', 'private')),
        display_order  INTEGER NOT NULL DEFAULT 0,
        is_active      BOOLEAN NOT NULL DEFAULT TRUE,
        created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at     TIMESTAMPTZ DEFAULT NOW(),
        updated_at     TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(org_id, name)
      )
    `)
    // Opt-in flag for the default-groups seed below. Defaults TRUE so every
    // existing org (including LWC/org_id 1) keeps today's behavior unchanged;
    // new orgs that want a blank slate can flip this off per-org.
    await pool.query(`ALTER TABLE organizations ADD COLUMN IF NOT EXISTS auto_create_default_groups BOOLEAN NOT NULL DEFAULT TRUE`)
    // Seed every org with the two categories the app used to hardcode, so
    // existing behavior (and existing posts' category labels) is unchanged
    // for orgs that haven't customized anything yet. WHERE NOT EXISTS makes
    // this idempotent — only orgs with zero rows ever get seeded. Gated by
    // auto_create_default_groups so orgs that opt out never get these two
    // groups auto-created on startup.
    await pool.query(`
      INSERT INTO community_groups (org_id, name, description, type, display_order)
      SELECT o.id, g.name, g.description, 'public', g.ord
      FROM organizations o
      CROSS JOIN (VALUES
        ('General Discussion',  'Everyday check-ins and conversation', 0),
        ('Non-Scale Victories', 'Wins that aren''t on the scale',       1)
      ) AS g(name, description, ord)
      WHERE NOT EXISTS (SELECT 1 FROM community_groups cg WHERE cg.org_id = o.id)
        AND o.auto_create_default_groups = TRUE
    `)
  } catch (err) {
    console.error('[migrations] community_groups setup failed:', err.message)
  }

  // group_members + community_posts.group_id: turns community_groups from a
  // pure label (posts matched a group only by string-equal category name) into
  // a real membership-scoped feed. group_id is the authoritative link; category
  // is kept in sync as a display label so existing feed/badge rendering and the
  // group post_count query keep working unchanged.
  // Must run after the community_groups block above — both FKs depend on it.
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS group_members (
        id         SERIAL PRIMARY KEY,
        group_id   INTEGER NOT NULL REFERENCES community_groups(id) ON DELETE CASCADE,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        org_id     INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        added_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(group_id, user_id)
      )
    `)
    // ON DELETE SET NULL, not CASCADE — deactivating/removing a group must never
    // delete the posts written in it; they fall back to the main feed instead.
    await pool.query(`
      ALTER TABLE community_posts
      ADD COLUMN IF NOT EXISTS group_id INTEGER REFERENCES community_groups(id) ON DELETE SET NULL
    `)
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_group_members_user_org ON group_members (user_id, org_id)`)
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_group_members_group    ON group_members (group_id)`)
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_community_posts_group  ON community_posts (group_id, created_at DESC)`)

    // Backfill group_id from the old category-name link. Org-scoped so two orgs
    // with a same-named group never cross-assign. Idempotent via group_id IS NULL.
    await pool.query(`
      UPDATE community_posts cp
      SET group_id = cg.id
      FROM community_groups cg
      WHERE cp.org_id = cg.org_id
        AND cp.category = cg.name
        AND cp.group_id IS NULL
    `)

    // Backfill membership: every active client lands in every active public
    // group in their own org, so the migration preserves today's "everyone sees
    // everything public" behavior. Staff are deliberately excluded here — they
    // reach group content through the super-admin/admin paths, and auto-adding
    // them would make the members list unusable as an audience picker.
    await pool.query(`
      INSERT INTO group_members (group_id, user_id, org_id, added_by)
      SELECT cg.id, u.id, u.org_id, NULL
      FROM community_groups cg
      JOIN users u ON u.org_id = cg.org_id
      WHERE cg.is_active = TRUE
        AND cg.type = 'public'
        AND u.client_status = 'active'
        AND u.role = 'client'
      ON CONFLICT (group_id, user_id) DO NOTHING
    `)
  } catch (err) {
    console.error('[migrations] group_members setup failed:', err.message)
  }

  // Second-pass backfill: the first membership backfill above required
  // client_status = 'active' at the time it ran, so clients who were inactive
  // then (or signed up before either backfill ran) can still be missing a
  // group_members row. Drops that status filter — every client gets added to
  // every active public group in their org regardless of current status.
  // Safe to over-include: isGroupMember still enforces client_status =
  // 'active' at request time, so a deactivated client with a group_members
  // row still can't read/post into the group. Idempotent via ON CONFLICT.
  try {
    await pool.query(`
      INSERT INTO group_members (group_id, user_id, org_id, added_by)
      SELECT cg.id, u.id, u.org_id, NULL
      FROM community_groups cg
      JOIN users u ON u.org_id = cg.org_id
      WHERE cg.is_active = TRUE
        AND cg.type = 'public'
        AND u.role = 'client'
      ON CONFLICT (group_id, user_id) DO NOTHING
    `)
  } catch (err) {
    console.error('[migrations] client group_members re-backfill failed:', err.message)
  }

  // Self-healing cleanup for stray cross-org group_members rows, mirroring the
  // staff_channel_members cleanup above. A group_members row is only valid
  // when the member's org_id, the group's org_id, and the user's own org_id
  // all agree — any mismatch means the row was seeded/joined against the
  // wrong org (e.g. a user or group later moved orgs, or a future seed bug
  // like the staff_channel_members one). Platform super admins (ADMIN_EMAILS)
  // are exempt — they legitimately manage groups across every org.
  try {
    const placeholders = ADMIN_EMAILS.length > 0
      ? ADMIN_EMAILS.map((_, i) => `$${i + 1}`).join(', ')
      : null
    const adminParams = ADMIN_EMAILS.map(e => e.toLowerCase())
    const exemptClause = placeholders ? `AND LOWER(u.email) NOT IN (${placeholders})` : ''

    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*) AS count
       FROM group_members gm
       JOIN users u ON gm.user_id = u.id
       JOIN community_groups cg ON gm.group_id = cg.id
       WHERE (gm.org_id != u.org_id OR gm.org_id != cg.org_id OR u.org_id != cg.org_id)
       ${exemptClause}`,
      adminParams,
    )
    const strayCount = Number(countRows[0]?.count || 0)

    if (strayCount > 0) {
      const { rows: breakdownRows } = await pool.query(
        `SELECT gm.org_id AS member_org_id, u.org_id AS user_org_id, cg.org_id AS group_org_id, COUNT(*) AS count
         FROM group_members gm
         JOIN users u ON gm.user_id = u.id
         JOIN community_groups cg ON gm.group_id = cg.id
         WHERE (gm.org_id != u.org_id OR gm.org_id != cg.org_id OR u.org_id != cg.org_id)
         ${exemptClause}
         GROUP BY gm.org_id, u.org_id, cg.org_id`,
        adminParams,
      )
      console.log(`[migrations] group_members cleanup: found ${strayCount} stray cross-org row(s)`, breakdownRows)

      const { rowCount: deletedCount } = await pool.query(
        `DELETE FROM group_members gm
         USING users u, community_groups cg
         WHERE gm.user_id = u.id AND gm.group_id = cg.id
         AND (gm.org_id != u.org_id OR gm.org_id != cg.org_id OR u.org_id != cg.org_id)
         ${exemptClause}`,
        adminParams,
      )
      console.log(`[migrations] group_members cleanup: deleted ${deletedCount} stray cross-org row(s)`)
    }
  } catch (err) {
    console.error('[migrations] group_members cleanup failed:', err.message)
  }

  // One-time backfill: the Main Feed (group_id IS NULL) concept is retired —
  // every post must belong to a group. Assigns orphaned posts to their org's
  // first active group, same ordering POST /posts uses for new posts without
  // a group_id. Idempotent — only ever touches group_id IS NULL rows, and does
  // nothing for an org with no active groups.
  try {
    const { rowCount } = await pool.query(`
      UPDATE community_posts cp
      SET group_id = (
        SELECT id FROM community_groups
        WHERE org_id = cp.org_id
        AND is_active = TRUE
        ORDER BY display_order ASC, id ASC
        LIMIT 1
      )
      WHERE cp.group_id IS NULL
      AND EXISTS (
        SELECT 1 FROM community_groups
        WHERE org_id = cp.org_id
        AND is_active = TRUE
      )
    `)
    if (rowCount > 0) {
      console.log(`[migrations] backfilled group_id for ${rowCount} orphaned community post(s)`)
    }
  } catch (err) {
    console.error('[migrations] community_posts group_id backfill failed:', err.message)
  }

  // One-time backfill: orgs that predate the owner_user_id column (or whose
  // owner invite was accepted before that write path existed) are left with
  // owner_user_id = NULL, which locks branding/settings saves to super admin
  // only (see isOrgOwnerOrAdmin in organizations.js). Picks the earliest
  // 'admin'-role user in that org as a reasonable stand-in for "the owner".
  // Idempotent — WHERE owner_user_id IS NULL means it only ever touches rows
  // still missing one.
  try {
    const { rowCount } = await pool.query(`
      UPDATE organizations o
      SET owner_user_id = admin_user.id
      FROM (
        SELECT DISTINCT ON (org_id) org_id, id
        FROM users
        WHERE role = 'admin' AND org_id IS NOT NULL
        ORDER BY org_id, id ASC
      ) admin_user
      WHERE o.id = admin_user.org_id AND o.owner_user_id IS NULL
    `)
    if (rowCount > 0) {
      console.log(`[migrations] backfilled owner_user_id for ${rowCount} organization(s)`)
    }
  } catch (err) {
    console.error('[migrations] owner_user_id backfill failed:', err.message)
  }

  // meal_items: per-ingredient breakdown for a logged meal, following the
  // recipe_ingredients precedent (recipes/recipe_ingredients above). meals
  // keeps its existing collapsed calories/protein/carbs/fat row unchanged —
  // this is an additive child table, populated for photo-analyzed meals
  // whose AI response includes an itemized ingredients array. Rows are
  // absent for meals logged before this table existed or via flows that
  // don't itemize (manual/search/text entry).
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS meal_items (
        id        SERIAL PRIMARY KEY,
        meal_id   INTEGER NOT NULL REFERENCES meals(id) ON DELETE CASCADE,
        item      TEXT NOT NULL,
        portion   TEXT,
        weight_g  NUMERIC(8,1),
        calories  NUMERIC(8,1),
        protein   NUMERIC(6,1),
        carbs     NUMERIC(6,1),
        fat       NUMERIC(6,1)
      )
    `)
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_meal_items_meal_id ON meal_items (meal_id)`)
  } catch (err) {
    console.error('[migrations] meal_items setup failed:', err.message)
  }
}

// Resolves the organization an internal user id belongs to. Falls back to 1
// (Life Warrior Coaching, the seeded single-tenant org) when org_id is NULL —
// covers rows created before this migration ran, and any environment where
// the migration hasn't applied yet.
export async function resolveOrgId(userId) {
  const { rows } = await pool.query('SELECT org_id FROM users WHERE id = $1', [userId])
  return rows[0]?.org_id ?? 1
}

// The org's AI coach display name, from org_ai_config.coach_name — the canonical
// field (organizations.ai_coach_name is kept mirrored to it by the PATCH routes
// in server/routes/organizations.js). Falls back to 'Katie' for orgs with no
// config row, preserving pre-multi-tenancy behaviour. Used anywhere a generated
// artifact needs to speak as the coach — see workoutGenerator.js.
export async function getOrgCoachName(orgId) {
  if (orgId == null) return 'Katie'
  try {
    const { rows } = await pool.query(
      'SELECT coach_name FROM org_ai_config WHERE org_id = $1 AND is_active = TRUE LIMIT 1',
      [orgId],
    )
    return rows[0]?.coach_name || 'Katie'
  } catch {
    return 'Katie'
  }
}

// claimInvite: applies a client_invites row to a user and marks it accepted.
// Shared by the token-based accept route (server/routes/invites.js) and the
// email-match auto-claim in getOrCreateUser() below, so both paths produce
// identical user state.
//
// `executor` is anything with .query() — pass `pool` for a standalone call, or
// a checked-out client when this must run inside a caller's transaction.
//
// client_status = 'invited' — stays invited until the Health Assessment is
// completed, at which point healthAssessment.js flips it to 'active'.
export async function claimInvite(executor, invite, dbUserId) {
  await executor.query(
    `UPDATE users
     SET first_name          = COALESCE(NULLIF(first_name, ''), $1),
         last_name           = COALESCE(NULLIF(last_name,  ''), $2),
         -- A stale invite minted before the 'ai' → 'hybrid' consolidation is
         -- folded here so claiming it can't reintroduce the legacy value.
         coaching_type       = CASE WHEN COALESCE($3, 'vip') = 'ai' THEN 'hybrid' ELSE COALESCE($3, 'vip') END,
         coaching_type_source = 'invite',
         assigned_coach_id   = COALESCE(assigned_coach_id, $4),
         -- The invite is authoritative about which org this client joins: it was
         -- issued from an admin's own org context. Overwrites rather than
         -- COALESCEs because a self-signup may already be sitting on the org 1
         -- fallback (or NULL) from getOrCreateUser, and claiming an org 2 invite
         -- must move them to org 2 — that mis-assignment is the whole bug this
         -- column exists to fix. Legacy invites with a NULL org_id keep whatever
         -- the user already had.
         org_id              = COALESCE($5, org_id),
         onboarding_complete = TRUE,
         assessment_complete = FALSE,
         client_status       = 'invited',
         paid                = TRUE
     WHERE id = $6`,
    [invite.first_name, invite.last_name, invite.coaching_type, invite.assigned_coach_id, invite.org_id ?? null, dbUserId],
  )

  await executor.query(
    `UPDATE client_invites
     SET accepted_at = NOW(), accepted_by_user_id = $1
     WHERE id = $2`,
    [dbUserId, invite.id],
  )
}

// getOrCreateUser: ensures a DB user row exists for this Clerk user.
// Optionally captures their email — if it matches ADMIN_EMAILS the row is
// promoted to admin atomically. This is the runtime backstop that catches
// admin users whose email column was NULL at startup migration time.
export async function getOrCreateUser(clerkUserId, email = null) {
  const existing = await pool.query(
    'SELECT id, email, role, last_login_at, client_status, paid FROM users WHERE clerk_user_id = $1',
    [clerkUserId],
  )

  let dbUserId
  if (existing.rows.length > 0) {
    dbUserId = existing.rows[0].id

    // Stamp last_login_at on every authenticated request and backfill email if needed.
    // Throttle to at most one write per hour to avoid hammering the DB on every API call.
    const updates = []
    const vals    = []
    if (email && existing.rows[0].email !== email) {
      vals.push(email)
      updates.push(`email = $${vals.length}`)
    }
    // Only update last_login_at if it hasn't been set in the last hour
    if (!existing.rows[0].last_login_at ||
        Date.now() - new Date(existing.rows[0].last_login_at).getTime() > 60 * 60 * 1000) {
      updates.push(`last_login_at = NOW()`)
    }
    if (updates.length > 0) {
      vals.push(dbUserId)
      await pool.query(
        `UPDATE users SET ${updates.join(', ')} WHERE id = $${vals.length}`,
        vals,
      )
    }

    // Re-check gated accounts on every login: an invite may have been sent, or a
    // purchase completed, since they were first held at /pending-access. Without
    // this they'd stay gated even after being invited, because the auto-claim
    // below only runs on the very first login.
    if (existing.rows[0].client_status === 'pending_access') {
      const inviteEmail = email ?? existing.rows[0].email
      let released = false
      if (inviteEmail) {
        const { rows: matchedInvite } = await pool.query(
          `SELECT * FROM client_invites
           WHERE LOWER(email) = LOWER($1) AND accepted_at IS NULL
             AND (expires_at IS NULL OR expires_at > NOW())
           ORDER BY created_at DESC LIMIT 1`,
          [inviteEmail],
        )
        if (matchedInvite.length) {
          await claimInvite(pool, matchedInvite[0], dbUserId)
          released = true
          console.log(`[auto-claim] released gated user id=${dbUserId} via invite id=${matchedInvite[0].id}`)
        }
      }
      if (!released && existing.rows[0].paid === true) {
        await pool.query(`UPDATE users SET client_status = 'active' WHERE id = $1`, [dbUserId])
        console.log(`[auto-claim] released gated user id=${dbUserId} — paid = TRUE`)
      }
    }
  } else {
    // Which org does this brand-new user belong to? Resolved from a pending
    // invite addressed to their email, never guessed:
    //
    //   1. staff_invites — the super-admin "invite org owner" flow
    //      (server/routes/organizations.js), so a newly-invited org owner lands
    //      in their own org instead of LWC's. Checked first: staff outrank
    //      clients, and a staff invite also exempts them from the access gate.
    //   2. client_invites — an admin invited this client into their own org
    //      (org_id stamped from ctx.orgId at invite time, see coachAdmin.js).
    //   3. Neither → NULL. This used to hard-default to org 1, which is exactly
    //      how every non-LWC org's self-signups became invisible to their own
    //      admins: they were filed under org 1 and org-scoped queries never saw
    //      them again. A user with no invite has no knowable org, and is gated
    //      at pending_access below regardless, so they wait unassigned until an
    //      admin invites them (claimInvite sets org_id) or activates them
    //      (coachAdmin.js adopts the activating admin's org).
    let targetOrgId = null
    let hasStaffInvite = false
    if (email) {
      const { rows: pendingInvite } = await pool.query(
        `SELECT org_id FROM staff_invites
         WHERE LOWER(email) = LOWER($1) AND accepted_at IS NULL AND org_id IS NOT NULL
           AND (expires_at IS NULL OR expires_at > NOW())
         ORDER BY created_at DESC LIMIT 1`,
        [email],
      )
      if (pendingInvite.length) {
        targetOrgId    = pendingInvite[0].org_id
        hasStaffInvite = true
      } else {
        const { rows: pendingClientInvite } = await pool.query(
          `SELECT org_id FROM client_invites
           WHERE LOWER(email) = LOWER($1) AND accepted_at IS NULL AND org_id IS NOT NULL
             AND (expires_at IS NULL OR expires_at > NOW())
           ORDER BY created_at DESC LIMIT 1`,
          [email],
        )
        if (pendingClientInvite.length) targetOrgId = pendingClientInvite[0].org_id
      }
    }

    // The INSERT and the invite auto-claim / access gate share one transaction:
    // a new row must never be visible in the window between being created and
    // having its client_status settled, or the frontend gate would flap.
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const inserted = await client.query(
        'INSERT INTO users (clerk_user_id, email, org_id) VALUES ($1, $2, $3) RETURNING id, paid',
        [clerkUserId, email, targetOrgId],
      )
      dbUserId = inserted.rows[0].id

      // Paid users are never gated. `paid` is set directly by the Stripe webhook
      // (server/routes/stripe.js) and is independent of invite expiry, so a
      // buyer whose invite lapsed before first login still gets straight in.
      // Staff-invite signups and the super-admin allowlist are likewise exempt —
      // neither is a client and neither will ever match a client_invites row.
      const exemptFromGate = inserted.rows[0].paid === true || hasStaffInvite || isAdminEmail(email)

      // Auto-claim a pending invite addressed to this email. Covers signups that
      // went through Clerk directly instead of the /invite/:token link.
      let claimed = false
      if (email) {
        const { rows: matchedInvite } = await client.query(
          `SELECT * FROM client_invites
           WHERE LOWER(email) = LOWER($1) AND accepted_at IS NULL
             AND (expires_at IS NULL OR expires_at > NOW())
           ORDER BY created_at DESC LIMIT 1`,
          [email],
        )
        if (matchedInvite.length) {
          await claimInvite(client, matchedInvite[0], dbUserId)
          claimed = true
          console.log(`[auto-claim] matched invite id=${matchedInvite[0].id} for ${email} (user id=${dbUserId})`)
        }
      }

      // No invite and not paid → hold the account until an admin grants access.
      // Set explicitly rather than relying on the column default ('active').
      if (!claimed) {
        await client.query(
          `UPDATE users SET client_status = $1 WHERE id = $2`,
          [exemptFromGate ? 'active' : 'pending_access', dbUserId],
        )
        if (!exemptFromGate) {
          console.log(`[auto-claim] no invite match for ${email ?? '(no email)'} — user id=${dbUserId} set to pending_access`)
        }
      }

      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      client.release()
    }
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

// Used only by the orgContext middleware (server/middleware/orgContext.js) to get
// org_id and the full user row in one extra query alongside getOrCreateUser.
// Deliberately kept separate from getOrCreateUser rather than changing that
// function's return shape — 28+ route files call getOrCreateUser expecting back
// a plain numeric id (e.g. `const dbUserId = await getOrCreateUser(userId)` used
// directly as a SQL param), and returning an object there would break all of them.
export async function getOrCreateUserWithOrg(clerkUserId, email = null) {
  const dbUserId = await getOrCreateUser(clerkUserId, email)
  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [dbUserId])
  return rows[0]
}

// Read-only lookup by Clerk id — never inserts. Used by the orgContext
// middleware to decide, *before* a row can be created, whether this request
// needs an email resolved from Clerk: org resolution in getOrCreateUser is
// email-gated, and an insert that happens without one strands the user at
// org_id NULL with no way to self-heal. Cheap enough for the hot path —
// clerk_user_id is UNIQUE, so this is a single indexed lookup.
export async function findUserByClerkId(clerkUserId) {
  const { rows } = await pool.query('SELECT * FROM users WHERE clerk_user_id = $1', [clerkUserId])
  return rows[0] ?? null
}
