// Factual "how to use the app" reference for Katie's app-mechanics answers.
//
// Every line here was confirmed against the actual UI/routes (Layout.jsx's
// floating Quick Log sheet, Journal.jsx, Settings.jsx, Calendar.jsx,
// Workouts.jsx, and server/routes/dailyLogs.js) — not assumed. Katie has
// previously guessed at app mechanics and been wrong (e.g. hedging on
// whether water entries add or replace, describing a "Water tile" and a
// "calendar icon" that don't exist in the app). Keep this file accurate as
// the app changes — a wrong answer here is worse than Katie saying she's
// not sure.

const SECTIONS = {
  food_logging: {
    keywords: [
      /\blog(ging)?\s*(a\s*|my\s*)?(meal|food|lunch|breakfast|dinner|snack)\b/i,
      /\bjournal\b/i,
      /\bfood\s*photo\b/i,
      /\bscan(ning)?\s*(a\s*)?barcode\b/i,
      /\bsearch(ing)?\s*(for\s*)?(a\s*)?food\b/i,
      /\b(edit|delete|remove|fix|change)\s*(a\s*|my\s*)?(meal|food\s*log)\b/i,
    ],
    content: `FOOD LOGGING ("Journal" page)
The food log lives on the Journal page — that's the same thing a client might call "the journal," there is no separate diary/journal feature.
To log a meal: tap the orange "+" Quick Log button (bottom right on mobile), then pick a Food option: Text Entry (type what you ate), Search Food (search a food database), Scan Barcode, or Food Photo (snap/upload a photo). Then pick which meal it's for: Breakfast, Lunch, Dinner, or Snack. That opens the Journal page to finish logging.
To log for a past day: in that same Quick Log sheet, before picking the meal, there's a "Log date" field (defaults to today, can go back up to 90 days, not into the future) — set it there first.
To edit or delete a meal you already logged: open the Journal page, find the meal entry, tap it to open it, then edit the fields or tap Delete.`,
  },

  water_logging: {
    keywords: [/\bwater\b/i, /\bhydrat/i, /\boz\b.*\bdrink/i],
    content: `WATER LOGGING — confirmed add vs. replace behavior
Log water via the orange "+" Quick Log button → "Log Water."
FOR TODAY: the number you enter is a DELTA, not a total. There are preset buttons (+8 oz, +16 oz, +24 oz) or a custom amount, plus two separate buttons: "Add" and "Subtract." Whatever you type gets added to (or subtracted from) today's existing total — it does NOT replace it. So if a client already has 32 oz logged and drinks another 16 oz, she should enter 16 and tap Add, not enter 48.
FOR A PAST DAY (selected via the Date field in that same sheet, up to 90 days back): there is no add/subtract toggle. The number typed there SETS the day's total directly — the field is literally labeled "Total oz for this day." So for a past day, she should enter the full correct total for that day, not a delta.
Summary: today = add/subtract a delta. Past day = type the day's full total.`,
  },

  quick_log_metrics: {
    keywords: [
      /\bweight\b/i,
      /\bsteps?\b/i,
      /\bsleep\b/i,
      /\b(edit|fix|change|correct)\s*(a\s*|my\s*)?(past|yesterday'?s?|previous)\s*(day'?s?\s*)?log\b/i,
      /\blog\s*(a\s*)?past\s*day\b/i,
    ],
    content: `WEIGHT / STEPS / SLEEP LOGGING AND EDITING PAST DAYS
Log via the orange "+" Quick Log button → Log Weight, Log Steps, or Sleep. Unlike water, these always take a direct value (not add/subtract) — whatever number is entered replaces that day's stored value.
To log or fix any of these (or water, or a Progress Photo, or a non-program Activity) for a PAST day: open the same Quick Log sheet, pick the metric, then use the "Date" field at the top of that form (defaults to today, can go back up to 90 days, never a future date) to pick the day before saving.
Manual step/sleep entries can be cleared so automatic sync can fill them back in — that's a backend behavior, not something a client does directly in the UI; if she wants a manual entry cleared, point her to support@lwcvip.com.`,
  },

  calendar_habits: {
    keywords: [/\bhabit(s)?\b/i, /\bcalendar\b/i, /\bstreak\b/i, /\bcheck.?off\b/i, /\bcomplete.*habit\b/i],
    content: `CALENDAR / HABIT COMPLETION
The Calendar page shows each day with the client's assigned habits.
Checkbox-style habits (things like "drink water" as a yes/no habit): tap the circle next to the habit on any day, including past days, to mark it complete or incomplete.
Numeric/progress habits (e.g. a water-oz or steps target): these are read-only on the Calendar — they're calculated automatically from her actual logged data. To fix one of these, correct the underlying log (water, steps, etc.) for that day using Quick Log, not the Calendar itself.`,
  },

  messaging: {
    keywords: [/\bmessag(e|ing)\b/i, /\btext\s*(my\s*)?coach\b/i, /\bdm\b/i, /\bcontact\s*(my\s*)?coach\b/i],
    content: `MESSAGING
VIP (human-coached) clients see a "Messages" page — chat directly with their coach and team.
AI/Hybrid clients see the same page labeled "Support" — messages there go to the support team, not a 1:1 human coach.
Either way: open the page, type in the message box, and send.`,
  },

  workouts: {
    keywords: [/\bworkout(s)?\b/i, /\bexercise(s)?\b/i, /\btraining\s*program\b/i, /\bset(s)?\s*(and|&)?\s*reps?\b/i, /\bmark.*complete\b/i, /\bactivity\b.*\blog\b/i],
    content: `WORKOUTS
The Workouts page shows the client's assigned training program, with exercises grouped by day.
To log a workout day as done: open that day in the program and tap "Log Workout Complete," add optional notes, then "Mark Complete."
For cardio or other activity outside the structured program (a walk, a run, a class): use the orange "+" Quick Log button → "Activity" — pick a type, optional duration and notes, and it can be logged to a past date the same way as other Quick Log metrics.`,
  },

  health_sync: {
    keywords: [
      /\bsteps?\b.*\bsync/i, /\bsync.*\bsteps?\b/i, /\bnot\s*sync/i, /\bwon'?t\s*sync/i, /\bisn'?t\s*sync/i,
      /\bgoogle\s*health\b/i, /\bfitbit\b/i, /\bapple\s*health\b/i, /\bhealth\s*connect\b/i,
      /\bconnect(ed)?\s*(my\s*)?(steps?|health|fitbit|watch)\b/i, /\bpull.?to.?refresh\b/i,
      /\bdisconnect(ed)?\b/i, /\breconnect\b/i,
    ],
    content: `GOOGLE HEALTH / FITBIT AND APPLE HEALTH — CONNECT, SYNC, TROUBLESHOOT
All of this lives in Settings → Connected Apps. There is no pull-to-refresh gesture anywhere in the app — never tell a client to pull to refresh.

Google Health (this is Fitbit under the hood, but the app always shows it to clients as "Google Health"):
- Not connected: tap "Connect Google Health" to start Google sign-in.
- Connected: shows last-synced time and the connected Google account email, plus:
  - "Sync Now" — runs an on-demand sync right now.
  - "Reconnect" — re-runs Google sign-in; use this if the wrong Google account got linked, or the connection needs re-authorizing.
  - "Disconnect" — removes the connection entirely.
  - "Refresh" — only reloads the displayed status/timestamp on screen, it does NOT trigger a new sync. For an actual new sync, use "Sync Now."
- The app also auto-syncs Google Health/Fitbit data in the background roughly once an hour, so steps often show up without a manual sync.
- If a sync is failing, Settings shows a plain-language reason under the connection (e.g. "Connection needs to be reconnected," or a missing-permissions notice telling her to reconnect and allow steps/sleep access).

Apple Health (iOS app only):
- "Connect Apple Health" (shown as "Manage Apple Health Access" once connected) requests HealthKit permissions.
- "Sync Now" appears once connected — pulls today's steps and sleep into her daily log.
- Apple Health has NO background auto-sync (Apple's HealthKit can't push data to our server on its own) — it only updates when she opens Settings and taps "Sync Now." If her steps look stale, that's the fix: open Settings, tap Sync Now.

If steps still aren't showing up after Sync Now / Reconnect, or the error shown doesn't match anything above, don't guess further — point her to support@lwcvip.com.`,
  },

  progress_photos: {
    keywords: [/\bprogress\s*photo(s)?\b/i, /\bprogress\s*pic(ture)?s?\b/i, /\bbefore.*after\s*photo/i],
    content: `PROGRESS PHOTOS
Log via the orange "+" Quick Log button → "Progress Photo." It walks through three angles in order — Front, Side, Back — one photo at a time, saving each as she goes.
Can be logged for a past date using the same Date field the other Quick Log metrics use.
To delete an uploaded progress photo, that's done from the Settings page.`,
  },
}

// General "this is about how the app works" signal — how-to phrasing, "where is X",
// or a troubleshooting complaint (not working / won't sync / can't find, etc.).
// This alone doesn't pull in a section; it just gates whether we bother checking
// topic keywords at all, so a coaching question like "how do I stop snacking at
// night" doesn't match any SECTION keyword and gets nothing appended.
const APP_MECHANICS_SIGNAL = /\b(how (do|can|would) i|how to|where (do|can|is|are)|can'?t (find|log|edit|see|connect|sync|save|open)|(is|are|was|were)n'?t (work|sync|sav|load|show)ing?|not (work|sync|sav|load|show)ing|won'?t (sync|work|save|load|open)|didn'?t (sync|save)|not showing up|trouble (logging|syncing|connecting|saving|finding)|stuck on|pull.?to.?refresh|glitch(y|ing)?|\bbug\b|\bbroken\b)/i

// Returns an app-help context block to append to Katie's system prompt for this
// turn only, or '' if the message doesn't look like an app-usage question.
// Only the matched section(s) are included — never the whole reference.
//
// priorUserMessage (optional): the client's previous message, if any. Folded into
// the classifier text alongside the current message so a short follow-up reply
// to Katie's own clarifying question (e.g. "Android, using Google Health" after
// she asked "which device?") still resolves to the right section, instead of
// losing app-help context on turn two of a troubleshooting exchange.
export function getAppHelpContext(message, priorUserMessage = '') {
  if (!message || typeof message !== 'string') return ''
  const classifierText = [priorUserMessage, message].filter(Boolean).join(' ')
  if (!APP_MECHANICS_SIGNAL.test(classifierText)) return ''

  const matched = Object.values(SECTIONS).filter(section =>
    section.keywords.some(re => re.test(classifierText)),
  )
  if (matched.length === 0) return ''

  const body = matched.map(s => s.content.trim()).join('\n\n---\n\n')

  return `

APP HELP REFERENCE (only relevant if the client's CURRENT message is asking how to use the app — ignore for nutrition/coaching questions)
The following is accurate, current information about how MetaCoach actually works, confirmed against the app's real code. Use it to answer precisely and concretely. Do not guess, hedge, or describe buttons/screens not listed here.
If her app-mechanics question isn't answered by this reference, say you're not sure and point her to support@lwcvip.com. Never guess at app mechanics.

${body}`
}
