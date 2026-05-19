import { createGzip } from 'zlib'
import { createWriteStream, mkdirSync, existsSync, readdirSync, statSync } from 'fs'
import { pipeline } from 'stream/promises'
import { Readable } from 'stream'
import path from 'path'
import { fileURLToPath } from 'url'
import { Storage } from '@google-cloud/storage'
import { v2 as cloudinary } from 'cloudinary'
import { pool } from '../db.js'
import { acquireJobLock, releaseJobLock } from './jobLock.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BACKUP_DIR = process.env.BACKUP_DIR ?? path.join(__dirname, '../../backups')

// User-data tables to export — excludes USDA food catalog (foods/nutrients/food_nutrients)
// which is large, static, and re-seeded by migration on each deploy.
const PG_TABLES = [
  'users',
  'meals',
  'daily_logs',
  'fitbit_tokens',
  'coaching_conversations',
  'community_posts',
  'post_likes',
  'post_comments',
  'post_reactions',
  'comment_reactions',
  'notifications',
  'community_polls',
  'poll_options',
  'poll_votes',
  'progress_photos',
  'recipes',
  'recipe_ingredients',
  'workouts',
  'workout_exercises',
  'workout_logs',
  'activity_logs',
  'custom_foods',
  'weekly_checkins',
  'health_assessments',
  'user_xp',
  'xp_log',
  'user_streaks',
  'user_badges',
  'coach_assigned_habits',
  'habit_completions',
  'client_notes',
  'client_messages',
  'form_templates',
  'form_versions',
  'form_submissions',
  'form_assignments',
  'client_invites',
  'client_measurements',
  'comeback_events',
  'community_resources',
  'mindset_videos',
  'video_watch_progress',
]

// ── Google Cloud Storage helpers ──────────────────────────────────────────────

// Kept for backward-compatible /api/admin/backup/status shape. Drive is no
// longer the off-platform backup target.
const driveStatus = {
  configured:             false,
  last_pg_upload:         null,
  last_cloudinary_upload: null,
  last_error:             null,
}

// In-memory record of GCS upload outcomes for the status endpoint.
const gcsStatus = {
  configured:             false,
  last_pg_upload:         null,   // { file, bucket, object, uploaded_at }
  last_cloudinary_upload: null,
  last_error:             null,   // { message, bucket, object, at }
}

function getGcsConfig() {
  const bucket = process.env.GOOGLE_CLOUD_STORAGE_BUCKET
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL
  const key   = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY?.replace(/\\n/g, '\n')
  if (!bucket || !email || !key) return null
  return { bucket, email, key }
}

// Initialise configured once at module load so getBackupStatus()
// can report it without needing a live upload attempt first.
gcsStatus.configured = getGcsConfig() !== null

function createGcsClient(cfg) {
  return new Storage({
    credentials: {
      client_email: cfg.email,
      private_key:  cfg.key,
    },
  })
}

async function uploadToGcs(localPath, objectPath) {
  const cfg = getGcsConfig()
  if (!cfg) return null   // GCS not configured — caller logs the skip

  const storage = createGcsClient(cfg)
  console.log(
    `[backup:gcs] Preparing upload: local=${localPath} ` +
    `bucket=${cfg.bucket} object=${objectPath}`,
  )
  await storage.bucket(cfg.bucket).upload(localPath, {
    destination: objectPath,
    gzip: false,
    metadata: {
      contentType: 'application/gzip',
      metadata: {
        source: 'metacoach-backup',
      },
    },
  })
  return { bucket: cfg.bucket, object: objectPath }
}

// ── Shared upload-to-GCS step ─────────────────────────────────────────────────
// Call after the local .json.gz file has been written successfully.
// Never throws — a GCS failure must not undo a successful local backup.
async function gcsUpload(localPath, objectPrefix, logPrefix, statusKey) {
  const cfg = getGcsConfig()
  if (!cfg) {
    console.log(`${logPrefix} GCS not configured — local backup only`)
    return
  }
  const filename = path.basename(localPath)
  const objectPath = `${objectPrefix.replace(/\/+$/, '')}/${filename}`
  try {
    const uploaded = await uploadToGcs(localPath, objectPath)
    const now = new Date().toISOString()
    gcsStatus[statusKey] = {
      file:        filename,
      bucket:      uploaded.bucket,
      object:      uploaded.object,
      uploaded_at: now,
    }
    gcsStatus.last_error = null
    console.log(
      `[backup:gcs] Upload OK: local=${localPath} ` +
      `bucket=${uploaded.bucket} object=${uploaded.object} at=${now}`,
    )
  } catch (err) {
    gcsStatus.last_error = {
      message: err.message,
      bucket:  cfg.bucket,
      object:  objectPath,
      at:      new Date().toISOString(),
    }
    console.error(
      `[backup:gcs] Upload failed (local backup preserved): ${err.message} ` +
      `bucket=${cfg.bucket} object=${objectPath} local=${localPath}`,
    )
  }
}

// ── Filesystem helpers ────────────────────────────────────────────────────────
function ensureBackupDir() {
  if (!existsSync(BACKUP_DIR)) mkdirSync(BACKUP_DIR, { recursive: true })
}

function timestamp() {
  return new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')
}

// ── Postgres JSON backup ──────────────────────────────────────────────────────
// Exports all user-data tables to a gzipped JSON file, then uploads to GCS.
// Schema is NOT included — migrate() in db.js handles schema recreation.
export async function runPostgresBackup() {
  const locked = await acquireJobLock('backup_postgres', 23 * 60 * 60 * 1000)
  if (!locked) {
    console.log('[backup:pg] Lock held — skipping (already ran in last 23h)')
    return
  }
  try {
    if (!process.env.DATABASE_URL) {
      console.log('[backup:pg] DATABASE_URL not set — skipping')
      await releaseJobLock('backup_postgres')
      return
    }
    ensureBackupDir()
    const ts       = timestamp()
    const filename = path.join(BACKUP_DIR, `pg_${ts}.json.gz`)
    const backup   = { backed_up_at: new Date().toISOString(), tables: {}, skipped: [] }

    for (const table of PG_TABLES) {
      try {
        const { rows } = await pool.query(`SELECT * FROM ${table}`)
        backup.tables[table] = rows
      } catch (err) {
        backup.skipped.push({ table, reason: err.message })
      }
    }

    const json           = JSON.stringify(backup)
    const uncompressedMB = (Buffer.byteLength(json) / 1_048_576).toFixed(1)
    await pipeline(Readable.from([json]), createGzip(), createWriteStream(filename))
    console.log(
      `[backup:pg] ✓ ${filename} | ${uncompressedMB} MB uncompressed | ` +
      `${Object.keys(backup.tables).length} tables | ` +
      `${backup.skipped.length} skipped`,
    )
    if (backup.skipped.length > 0) {
      console.warn('[backup:pg] Skipped tables:', backup.skipped.map(s => s.table).join(', '))
    }

    await gcsUpload(filename, 'backups/postgres', '[backup:pg]', 'last_pg_upload')
  } catch (err) {
    console.error('[backup:pg] Failed:', err.message)
  } finally {
    await releaseJobLock('backup_postgres')
  }
}

// ── Cloudinary metadata backup ────────────────────────────────────────────────
// Exports asset metadata (public_id, URL, format, size, created_at) for all
// uploaded images, then uploads to GCS. Binary files stay in Cloudinary.
export async function runCloudinaryBackup() {
  const locked = await acquireJobLock('backup_cloudinary', Math.floor(6.5 * 24 * 60 * 60 * 1000))
  if (!locked) {
    console.log('[backup:cloudinary] Lock held — skipping (already ran in last 6.5 days)')
    return
  }
  try {
    const { CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET } = process.env
    if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
      console.log('[backup:cloudinary] Cloudinary env vars not set — skipping')
      await releaseJobLock('backup_cloudinary')
      return
    }
    cloudinary.config({ cloud_name: CLOUDINARY_CLOUD_NAME, api_key: CLOUDINARY_API_KEY, api_secret: CLOUDINARY_API_SECRET })
    ensureBackupDir()
    const ts       = timestamp()
    const filename = path.join(BACKUP_DIR, `cloudinary_${ts}.json.gz`)

    const allResources = []
    let nextCursor = undefined
    do {
      const opts = { type: 'upload', max_results: 500, resource_type: 'image' }
      if (nextCursor) opts.next_cursor = nextCursor
      const result = await cloudinary.api.resources(opts)
      for (const r of result.resources) {
        allResources.push({
          public_id:  r.public_id,
          url:        r.secure_url,
          format:     r.format,
          bytes:      r.bytes,
          folder:     r.folder ?? '',
          created_at: r.created_at,
        })
      }
      nextCursor = result.next_cursor
    } while (nextCursor)

    const backup = {
      backed_up_at:    new Date().toISOString(),
      total_resources: allResources.length,
      resources:       allResources,
    }
    const json = JSON.stringify(backup)
    await pipeline(Readable.from([json]), createGzip(), createWriteStream(filename))
    console.log(`[backup:cloudinary] ✓ ${filename} | ${allResources.length} assets catalogued`)

    await gcsUpload(filename, 'backups/cloudinary', '[backup:cloudinary]', 'last_cloudinary_upload')
  } catch (err) {
    console.error('[backup:cloudinary] Failed:', err.message)
  } finally {
    await releaseJobLock('backup_cloudinary')
  }
}

// ── Status helper (used by admin endpoint) ────────────────────────────────────
export function getBackupStatus() {
  try {
    ensureBackupDir()
    const files = readdirSync(BACKUP_DIR)
      .filter(f => f.endsWith('.json.gz'))
      .map(f => {
        const full = path.join(BACKUP_DIR, f)
        const { size, mtime } = statSync(full)
        return { file: f, size_bytes: size, modified: mtime.toISOString() }
      })
      .sort((a, b) => b.modified.localeCompare(a.modified))

    const lastPg  = files.find(f => f.file.startsWith('pg_'))
    const lastCdn = files.find(f => f.file.startsWith('cloudinary_'))
    return {
      backup_dir:             BACKUP_DIR,
      last_postgres:          lastPg  ?? null,
      last_cloudinary:        lastCdn ?? null,
      total_backup_files:     files.length,
      gcs_configured:         gcsStatus.configured,
      gcs_last_pg_upload:     gcsStatus.last_pg_upload,
      gcs_last_cdn_upload:    gcsStatus.last_cloudinary_upload,
      gcs_last_error:         gcsStatus.last_error,
      drive_configured:       driveStatus.configured,
      drive_last_pg_upload:   driveStatus.last_pg_upload,
      drive_last_cdn_upload:  driveStatus.last_cloudinary_upload,
      drive_last_error:       driveStatus.last_error,
      all_files:              files,
    }
  } catch (err) {
    return { error: err.message }
  }
}
