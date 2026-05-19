# MetaCoach Backup System

## Overview

Automatic backups run on a schedule using the same job-lock mechanism as other
background jobs. Multiple Railway instances will never run duplicate backups
because each job acquires a PostgreSQL row-level lock before executing.

After each backup file is written locally, it is automatically uploaded to a
Google Drive folder via a service account.

Two backup types:

| Type | What | Schedule | File prefix |
|---|---|---|---|
| Postgres (data) | All user-data tables as gzipped JSON | Daily | `pg_YYYY-MM-DD-HH-MM-SS.json.gz` |
| Cloudinary (metadata) | Asset catalog: public_id, URL, format, size | Weekly | `cloudinary_YYYY-MM-DD-HH-MM-SS.json.gz` |

---

## Required Environment Variables

| Variable | Required for | Notes |
|---|---|---|
| `DATABASE_URL` | Postgres backup | Already set on Railway |
| `CLOUDINARY_CLOUD_NAME` | Cloudinary backup | Already set on Railway |
| `CLOUDINARY_API_KEY` | Cloudinary backup | Already set on Railway |
| `CLOUDINARY_API_SECRET` | Cloudinary backup | Already set on Railway |
| `BACKUP_DIR` | Both (optional) | Defaults to `backups/` in project root; set to `/data/backups` on Railway Volume |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | Drive upload | Service account email from GCP |
| `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` | Drive upload | Full PEM private key (Railway escapes newlines automatically) |
| `GOOGLE_DRIVE_BACKUP_FOLDER_ID` | Drive upload | Google Drive folder ID from the folder URL |

If Drive env vars are missing, local backups still run and a clean skip is logged.
If Drive upload fails, the local backup is preserved and the error is logged — the
server does not crash.

---

## Google Drive Setup

### 1. Create a service account

1. Go to [console.cloud.google.com](https://console.cloud.google.com) → IAM & Admin → Service Accounts.
2. Create a new service account (e.g. `metacoach-backups@your-project.iam.gserviceaccount.com`).
3. On the Keys tab, add a JSON key. Download the file.
4. From the JSON key file, copy:
   - `client_email` → `GOOGLE_SERVICE_ACCOUNT_EMAIL`
   - `private_key` → `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`

### 2. Enable the Drive API

In GCP, search for "Google Drive API" and enable it for your project.

### 3. Create the backup folder in Drive

1. Create a folder in Google Drive named e.g. `MetaCoach Backups`.
2. Share it with the service account email (Editor access).
3. Copy the folder ID from the URL:
   `https://drive.google.com/drive/folders/THIS_IS_THE_ID`
4. Set this as `GOOGLE_DRIVE_BACKUP_FOLDER_ID`.

### 4. Set Railway env vars

In Railway → your service → Variables:

```
GOOGLE_SERVICE_ACCOUNT_EMAIL   = metacoach-backups@your-project.iam.gserviceaccount.com
GOOGLE_DRIVE_BACKUP_FOLDER_ID  = 1AbCdEf...yourFolderId
GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY = -----BEGIN RSA PRIVATE KEY-----\nMIIEo...
```

Railway stores multi-line strings with `\n` literals. The backup code automatically
converts `\n` → real newlines when reading the key, so paste the full key as-is.

---

## Where Backups Are Stored

### Local (Railway Volume)

Backups are written to `BACKUP_DIR` (set to `/data/backups` on the Railway Volume).
Files persist across deploys because the Volume is mounted at that path.

### Google Drive

After each successful local write, the `.json.gz` file is uploaded to the
configured Drive folder. Each backup run creates a new file in Drive — old
files are not overwritten or deleted automatically.

The Cloudinary backup is metadata only (public_ids + URLs). Actual image
binaries live permanently in Cloudinary and are not uploaded to Drive.

---

## Schedule

Jobs run at server startup, then on a timer:

- **Postgres**: every 24 hours. The job_lock TTL is 23 hours, so at most one
  backup runs per day across all instances.
- **Cloudinary**: every 7 days. The job_lock TTL is 6.5 days.

---

## Admin Status Endpoint

```
GET /api/admin/backup/status
Authorization: Clerk session (admin role required)
```

Returns local file info plus Drive upload status.

Example response:

```json
{
  "backup_dir": "/data/backups",
  "last_postgres": {
    "file": "pg_2026-05-19-02-00-00.json.gz",
    "size_bytes": 184320,
    "modified": "2026-05-19T02:00:12.000Z"
  },
  "last_cloudinary": {
    "file": "cloudinary_2026-05-18-02-00-00.json.gz",
    "size_bytes": 12800,
    "modified": "2026-05-18T02:00:05.000Z"
  },
  "total_backup_files": 9,
  "drive_configured": true,
  "drive_last_pg_upload": {
    "file": "pg_2026-05-19-02-00-00.json.gz",
    "drive_id": "1XyZ...",
    "uploaded_at": "2026-05-19T02:00:15.000Z"
  },
  "drive_last_cdn_upload": {
    "file": "cloudinary_2026-05-18-02-00-00.json.gz",
    "drive_id": "1AbC...",
    "uploaded_at": "2026-05-18T02:00:08.000Z"
  },
  "drive_last_error": null,
  "all_files": [...]
}
```

`drive_configured: false` means Drive env vars are not set — local-only mode.
`drive_last_error` is non-null if the most recent Drive upload failed.

---

## How to Manually Trigger a Backup

**Option 1 — Clear locks and restart.** Both jobs run at startup. To force a
fresh run before the lock expires, clear the lock rows:

```sql
DELETE FROM job_locks WHERE job_name IN ('backup_postgres', 'backup_cloudinary');
```

Then redeploy (or restart the server via Railway dashboard).

**Option 2 — Railway CLI:**

```bash
railway run node -e "
  import('./server/jobs/backup.js').then(async m => {
    await m.runPostgresBackup()
    await m.runCloudinaryBackup()
    process.exit(0)
  })
"
```

---

## What to Check After a Backup Run

1. **Server logs** — look for:
   ```
   [backup:pg] ✓ /data/backups/pg_<ts>.json.gz | X.X MB | 40 tables | 0 skipped
   [backup:pg] ✓ Drive upload: pg_<ts>.json.gz (id=1AbC...)
   [backup:cloudinary] ✓ /data/backups/cloudinary_<ts>.json.gz | N assets catalogued
   [backup:cloudinary] ✓ Drive upload: cloudinary_<ts>.json.gz (id=1XyZ...)
   ```

2. **Status endpoint** — `GET /api/admin/backup/status` — confirm `drive_configured: true`
   and both `drive_last_pg_upload` / `drive_last_cdn_upload` are non-null.

3. **Google Drive folder** — the backup files should appear directly in the shared folder.

---

## What the Postgres Backup Contains

All user-data tables exported as raw row arrays. Tables excluded:

- `foods`, `nutrients`, `food_nutrients` — USDA food catalog; large and
  re-seeded automatically by `migrate()` on every deploy.
- `job_locks` — ephemeral scheduler state.

---

## Restore Notes

The Postgres backup is a JSON dump of row data, not a pg_dump binary. To restore:

1. Spin up a fresh Postgres instance with `DATABASE_URL` pointing to it.
2. Run the app once to let `migrate()` recreate all tables and indexes.
3. Write a restore script that reads the JSON and INSERTs rows in dependency order.

**Restore order (safe sequence):**

```
users → meals, daily_logs, fitbit_tokens, coaching_conversations,
        progress_photos, recipes, recipe_ingredients,
        workouts, workout_exercises, workout_logs, activity_logs,
        custom_foods, weekly_checkins, health_assessments,
        user_xp, xp_log, user_streaks, user_badges,
        coach_assigned_habits, habit_completions,
        client_notes, client_messages, client_invites,
        client_measurements, comeback_events,
        community_posts → post_likes, post_comments, post_reactions,
        comment_reactions, notifications, community_polls → poll_options → poll_votes,
        form_templates → form_versions → form_submissions, form_assignments,
        community_resources, mindset_videos, video_watch_progress
```

For full disaster recovery, Railway's Postgres service also has point-in-time
recovery (PITR) on paid plans — check Railway dashboard under the database service.

---

## Future Enhancements

- [x] Auto-upload backup files to Google Drive
- [ ] Prune old Drive files (keep last N)
- [ ] Email admin a backup success/failure summary each run
- [ ] Add a `/api/admin/backup/download` endpoint to stream the latest local file
