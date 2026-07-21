import pg from 'pg'
import { pathToFileURL } from 'url'

const { Pool } = pg

// Every tenant-scoped table that gets an org_id column. Tables that don't
// exist in this environment (e.g. main_lift, resources, gamification_profiles
// — not present anywhere in this codebase as of this migration) are silently
// skipped by the existence check inside migrateTableOrgId, so this list is
// safe to run against any environment regardless of which optional tables
// have been created.
const TENANT_TABLES = [
  'users',
  'meals',
  'daily_logs',
  'coaching_conversations',
  'community_posts',
  'community_polls',
  'poll_options',
  'poll_votes',
  'post_likes',
  'post_comments',
  'post_reactions',
  'comment_reactions',
  'notifications',
  'progress_photos',
  'workouts',
  'workout_exercises',
  'workout_logs',
  'custom_foods',
  'recipes',
  'recipe_ingredients',
  'health_assessments',
  'coach_assigned_habits',
  'habit_completions',
  'client_messages',
  'client_notes',
  'comeback_events',
  'gamification_profiles',
  'user_traits',
  'team_challenges',
  'team_challenge_progress',
  'push_devices',
  'exercise_library',
  'program_templates',
  'program_day_patterns',
  'volume_rules',
  'main_lift',
  'katie_corrections',
  'mindset_videos',
  'resources',
  'staff_channels',
]

// Adds org_id (FK -> organizations, ON DELETE CASCADE) to tableName and backs
// fills existing rows to org_id = 1, all inside one existence-guarded DO block
// so it's a no-op when the table doesn't exist in this environment, and a
// no-op on the column/backfill when re-run.
async function migrateTableOrgId(pool, tableName) {
  await pool.query(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = '${tableName}') THEN
        BEGIN
          ALTER TABLE ${tableName} ADD COLUMN org_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE;
        EXCEPTION WHEN duplicate_column THEN NULL;
        END;
        EXECUTE format('UPDATE %I SET org_id = 1 WHERE org_id IS NULL', '${tableName}');
      END IF;
    END $$;
  `)
}

export default async function runMigration(pool) {
  // ─── 2A. organizations ─────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS organizations (
      id                    SERIAL PRIMARY KEY,
      name                  VARCHAR(255) NOT NULL,
      slug                  VARCHAR(100) NOT NULL UNIQUE,
      owner_user_id         INTEGER REFERENCES users(id) ON DELETE SET NULL,
      logo_url              TEXT,
      primary_color         VARCHAR(7) DEFAULT '#f97316',
      brand_name            VARCHAR(255),
      ai_coach_name         VARCHAR(100) DEFAULT 'Katie',
      subscription_tier     VARCHAR(50) DEFAULT 'starter',
      subscription_status   VARCHAR(50) DEFAULT 'active',
      stripe_customer_id    VARCHAR(255),
      stripe_subscription_id VARCHAR(255),
      max_clients           INTEGER DEFAULT 50,
      is_active             BOOLEAN DEFAULT TRUE,
      trial_ends_at         TIMESTAMPTZ,
      created_at            TIMESTAMPTZ DEFAULT NOW(),
      updated_at            TIMESTAMPTZ DEFAULT NOW()
    )
  `)

  // ─── 2B. org_ai_config ─────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_ai_config (
      id                    SERIAL PRIMARY KEY,
      org_id                INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      coach_name            VARCHAR(100) DEFAULT 'Katie',
      coaching_philosophy   TEXT,
      tone_instructions     TEXT,
      system_prompt_override TEXT,
      focus_areas           TEXT[],
      restricted_topics     TEXT[],
      custom_greeting       TEXT,
      is_active             BOOLEAN DEFAULT TRUE,
      created_at            TIMESTAMPTZ DEFAULT NOW(),
      updated_at            TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(org_id)
    )
  `)

  // ─── 2C. Seed Life Warrior Coaching as org_id = 1 ─────────────────────────
  await pool.query(`
    INSERT INTO organizations (id, name, slug, brand_name, ai_coach_name, subscription_tier, subscription_status, max_clients, is_active)
    VALUES (1, 'Life Warrior Coaching', 'lwc', 'Life Warrior Coaching', 'Katie', 'enterprise', 'active', 9999, TRUE)
    ON CONFLICT (id) DO NOTHING
  `)
  // Keep the id=1 sequence ahead of the seeded row so the next INSERT without
  // an explicit id (a new org signing up) doesn't collide with SERIAL default.
  await pool.query(`SELECT setval(pg_get_serial_sequence('organizations', 'id'), (SELECT MAX(id) FROM organizations))`)

  await pool.query(`
    INSERT INTO org_ai_config (org_id, coach_name, coaching_philosophy, tone_instructions, focus_areas)
    VALUES (
      1,
      'Katie',
      'Triple R Method: Reset, Release, Rewire. 80/20 consistency over perfection. Identity transformation, not just weight loss. Help women over 40 rebuild self-trust and metabolic health.',
      'Warm, direct, proactive. Never shame. Use language like: small wins stack, rebuild momentum, you showed up and that matters, stop starting over. Reach out before the user spirals.',
      ARRAY['weight_loss','metabolic_health','mindset','self_trust','consistency']
    )
    ON CONFLICT (org_id) DO NOTHING
  `)

  // ─── 2D/2E. Add + backfill org_id on every tenant-scoped table ────────────
  for (const tableName of TENANT_TABLES) {
    await migrateTableOrgId(pool, tableName)
  }

  // ─── 2F. Performance indexes ───────────────────────────────────────────────
  const indexStatements = [
    `CREATE INDEX IF NOT EXISTS idx_users_org_id ON users(org_id)`,
    `CREATE INDEX IF NOT EXISTS idx_meals_org_id ON meals(org_id)`,
    `CREATE INDEX IF NOT EXISTS idx_daily_logs_org_id ON daily_logs(org_id)`,
    `CREATE INDEX IF NOT EXISTS idx_coaching_conversations_org_id ON coaching_conversations(org_id)`,
    `CREATE INDEX IF NOT EXISTS idx_community_posts_org_id ON community_posts(org_id)`,
    `CREATE INDEX IF NOT EXISTS idx_client_messages_org_id ON client_messages(org_id)`,
    `CREATE INDEX IF NOT EXISTS idx_coach_assigned_habits_org_id ON coach_assigned_habits(org_id)`,
    `CREATE INDEX IF NOT EXISTS idx_habit_completions_org_id ON habit_completions(org_id)`,
    `CREATE INDEX IF NOT EXISTS idx_workouts_org_id ON workouts(org_id)`,
    `CREATE INDEX IF NOT EXISTS idx_notifications_org_id ON notifications(org_id)`,
    `CREATE INDEX IF NOT EXISTS idx_progress_photos_org_id ON progress_photos(org_id)`,
    `CREATE INDEX IF NOT EXISTS idx_push_devices_org_id ON push_devices(org_id)`,
  ]
  for (const stmt of indexStatements) {
    await pool.query(stmt)
  }

  // ─── 2G. updated_at trigger for organizations / org_ai_config ─────────────
  await pool.query(`
    CREATE OR REPLACE FUNCTION update_updated_at_column()
    RETURNS TRIGGER AS $$
    BEGIN
      NEW.updated_at = NOW();
      RETURN NEW;
    END;
    $$ language 'plpgsql'
  `)

  await pool.query(`DROP TRIGGER IF EXISTS update_organizations_updated_at ON organizations`)
  await pool.query(`
    CREATE TRIGGER update_organizations_updated_at
      BEFORE UPDATE ON organizations
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()
  `)

  await pool.query(`DROP TRIGGER IF EXISTS update_org_ai_config_updated_at ON org_ai_config`)
  await pool.query(`
    CREATE TRIGGER update_org_ai_config_updated_at
      BEFORE UPDATE ON org_ai_config
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()
  `)
}

// Standalone execution: `node server/migrations/001_multi_tenancy.js`
// (e.g. via `railway run npm run migrate`). Compares file:// URLs rather than
// require.main === module since this codebase is ESM ("type": "module").
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  })
  runMigration(pool)
    .then(() => {
      console.log('[migrate] 001_multi_tenancy applied successfully')
      return pool.end()
    })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[migrate] 001_multi_tenancy failed:', err)
      pool.end().finally(() => process.exit(1))
    })
}
