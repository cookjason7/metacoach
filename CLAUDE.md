# CLAUDE.md — Global Rules for Meta Coach

## Execution Rules
- Act autonomously on every task. Never stop to ask for confirmation.
- Complete ALL items in the prompt. Do not skip any item.
- If you are unsure about something, make your best decision and keep going.
- Push to GitHub when all tasks are done.

## Task Completion
- Work through each numbered item in order.
- Check off each item as complete before moving to the next.
- Do not mark a task done unless the code change is actually made.
- If a file does not exist where expected, search the codebase for it before giving up.

## Code Standards
- Every component must work on desktop AND mobile (test at 375px).
- Minimum tap target size on mobile: 44px.
- No horizontal scroll on mobile.

## Stack
- React + Vite frontend
- Node.js + Express backend
- PostgreSQL database
- Clerk v5 for auth (never set clerkJSUrl prop on ClerkProvider)
- Tailwind CSS
- Port 8080, single Railway service

## Brand
- Sidebar: #1e2a3a (navy)
- Accent: #f97316 (orange)
