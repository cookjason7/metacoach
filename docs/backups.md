# MetaCoach Backup System

## Overview

Automatic backups run on a schedule using the same job-lock mechanism as other
background jobs. Multiple Railway instances will never run duplicate backups
because each job acquires a PostgreSQL row-level lock before executing.

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
| `BACKUP_DIR` | Both (optional) | Defaults to `backups/` in project root |

If any required variable is missing the job logs `backup skipped` and exits cleanly — it will not crash the server.

---

## Where Backups Are Stored

Backups are written to `backups/` at the project root (or `$BACKUP_DIR` if set).

**Important — Railway filesystem is ephemeral:** files written to disk are lost
on redeploy. Two practical options:

1. **Download before redeploying** — use the admin status endpoint to confirm
   the backup ran, then `railway run cat backups/pg_<timestamp>.json.gz > local.json.gz`
   to pull it down.

2. **Set `BACKUP_DIR` to a mounted volume** — if you add a Railway Volume to the
   service, set `BACKUP_DIR=/data/backups`. Files then persist across deploys.

The Cloudinary backup is metadata only (public_ids + URLs). The actual image
binaries live permanently in Cloudinary's storage and do not need to be
downloaded separately.

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

Returns JSON with last backup file for each type, file sizes, and full file list.

Example response:

```json
{
  "backup_dir": "/app/backups",
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
  "all_files": [...]
}
```

---

## How to Manually Trigger a Backup

**Option 1 — Restart the server.** Both jobs run at startup. The job_lock
prevents duplicates if a backup ran recently. To force a fresh backup, delete
the lock rows first:

```sql
DELETE FROM job_locks WHERE job_name IN ('backup_postgres', 'backup_cloudinary');
```

Then restart (or redeploy) the server.

**Option 2 — Run the script directly:**

```bash
node -e "
import('./server/jobs/backup.js').then(async m => {
  await m.runPostgresBackup()
  await m.runCloudinaryBackup()
  process.exit(0)
})
"
```

Or from Railway CLI:

```bash
railway run node -e "import('./server/jobs/backup.js').then(m => m.runPostgresBackup().then(() => process.exit(0)))"
```

---

## What the Postgres Backup Contains

All user-data tables exported as raw row arrays. Tables excluded:

- `foods`, `nutrients`, `food_nutrients` — USDA food catalog; large and
  re-seeded automatically by `migrate()` on every deploy.
- `job_locks` — ephemeral scheduler state.

---

## Restore Notes

The Postgres backup is a JSON dump of row data, not a pg_dump binary. To
restore:

1. Spin up a fresh Postgres instance with `DATABASE_URL` pointing to it.
2. Run the app once to let `migrate()` recreate all tables and indexes.
3. Write a restore script that reads the JSON and INSERTs rows in dependency
   order (users first, then everything that FK-references users, etc.).

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

For a full disaster recovery, Railway's Postgres service also has its own
point-in-time recovery (PITR) available on paid plans — check Railway dashboard
under the database service settings.

---

## Future Enhancements

- [ ] Auto-upload backup files to Google Drive or S3 after writing
- [ ] Email admin a backup success/failure summary each run
- [ ] Add a `/api/admin/backup/download` endpoint to stream the latest file
- [ ] Prune old backup files (keep last N)
