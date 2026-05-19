import { createGzip } from 'zlib'
import { createReadStream, createWriteStream, mkdirSync, existsSync, readdirSync, statSync } from 'fs'
import { pipeline } from 'stream/promises'
import { Readable } from 'stream'
import path from 'path'
import { fileURLToPath } from 'url'
import { google } from 'googleapis'
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

// ── Google Drive helpers ──────────────────────────────────────────────────────

// In-memory record of Drive upload outcomes for the status endpoint.
const driveStatus = {
  configured:             false,
  last_pg_upload:         null,   // { file, drive_id, uploaded_at }
  last_cloudinary_upload: null,
  last_error:             null,   // { message, at }
}

function getDriveConfig() {
  const email  = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL
  const folder = process.env.GOOGLE_DRIVE_BACKUP_FOLDER_ID
  // Railway stores multi-line env vars with literal \n — unescape them.
  const key    = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY?.replace(/\\n/g, '\n')
  if (!email || !key || !folder) return null
  return { email, key, folder }
}

// Initialise driveStatus.configured once at module load so getBackupStatus()
// can report it without needing a live upload attempt first.
driveStatus.configured = getDriveConfig() !== null

async function uploadToDrive(localPath, filename) {
  const cfg = getDriveConfig()
  if (!cfg) return null   // Drive not configured — caller logs the skip

  const auth = new google.auth.JWT({
    email:  cfg.email,
    key:    cfg.key,
    scopes: ['https://www.googleapis.com/auth/drive.file'],
  })
  const drive = google.drive({ version: 'v3', auth })
  const resp  = await drive.files.create({
    requestBody: {
      name:    filename,
      parents: [cfg.folder],
    },
    media: {
      mimeType: 'application/gzip',
      body:     createReadStream(localPath),
    },
    fields: 'id,name,webViewLink',
  })
  return resp.data   // { id, name, webViewLink }
}

// ── Shared upload-to-Drive step ───────────────────────────────────────────────
// Call after the local .json.gz file has been written successfully.
// Never throws — a Drive failure must not undo a successful local backup.
async function driveUpload(localPath, logPrefix, statusKey) {
  if (!getDriveConfig()) {
    console.log(`${logPrefix} Drive not configured — local backup only`)
    return
  }
  try {
    const filename  = path.basename(localPath)
    const driveFile = await uploadToDrive(localPath, filename)
    driveStatus[statusKey] = {
      file:        filename,
      drive_id:    driveFile.id,
      uploaded_at: new Date().toISOString(),
    }
    console.log(`${logPrefix} ✓ Drive upload: ${driveFile.name} (id=${driveFile.id})`)
  } catch (err) {
    driveStatus.last_error = { message: err.message, at: new Date().toISOString() }
    console.error(`${logPrefix} Drive upload failed (local backup preserved):`, err.message)
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
// Exports all user-data tables to a gzipped JSON file, then uploads to Drive.
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

    await driveUpload(filename, '[backup:pg]', 'last_pg_upload')
  } catch (err) {
    console.error('[backup:pg] Failed:', err.message)
  } finally {
    await releaseJobLock('backup_postgres')
  }
}

// ── Cloudinary metadata backup ────────────────────────────────────────────────
// Exports asset metadata (public_id, URL, format, size, created_at) for all
// uploaded images, then uploads to Drive. Binary files stay in Cloudinary.
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

    await driveUpload(filename, '[backup:cloudinary]', 'last_cloudinary_upload')
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
