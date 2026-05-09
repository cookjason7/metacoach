\# Meta Coach App — Codex Instructions



Act autonomously. Do not stop to ask for confirmation unless the task would delete data, change production auth, change billing/payment logic, require unknown credentials, or run destructive database commands.



Make all code changes, test locally when possible, commit with a descriptive message, and push to GitHub at the end.



Every feature must be built for desktop and mobile from the start.



Do not rewrite the app unless explicitly asked. Make targeted changes only.



\## Project



Meta Coach is an AI-powered nutrition and coaching app for Life Warrior Coaching.



Target user:

\- Women 40-55

\- Struggling with weight loss, metabolic health, consistency, and confidence



Brand:

\- Life Warrior Coaching

\- Navy blue: #1e2a3a

\- Orange accent: #f97316

\- Logo: public/logo.png

\- Clean, premium, simple design



\## Live URLs



\- App: https://app.lwcvip.com

\- Backend API: https://app.lwcvip.com/api

\- Marketing site: https://lwcvip.com



\## Tech Stack



Frontend:

\- React + Vite

\- Tailwind CSS

\- Clerk v5

\- React Router



Backend:

\- Node.js + Express

\- PostgreSQL

\- Clerk Express auth middleware

\- Cloudinary

\- Nodemailer

\- Anthropic API



Hosting:

\- Railway

\- Single service on port 8080

\- GitHub auto-deploys on push to main



\## Critical Rules



\- ClerkProvider must never use clerkJSUrl

\- VITE\_API\_URL must be https://app.lwcvip.com

\- Frontend and backend run as one Railway service

\- Express serves React build and handles /api routes

\- Vite env vars are baked at build time

\- Do not break mobile layout

\- Do not remove existing working features

\- Do not change production environment variables unless explicitly requested



\## Current Build Status



Completed:

\- Clerk auth

\- Mobile sidebar drawer

\- Bottom nav

\- PWA manifest

\- Food logging

\- Food unit selector

\- Log ahead up to 7 days

\- AI photo food analysis

\- Barcode scanner

\- Community feed

\- Workout generation

\- Workout mobile layout

\- Journal with AI

\- Calendar placeholder

\- Dashboard macros

\- Water, steps, weight

\- Onboarding

\- Polls hidden from non-admin users



Pending / Build Queue:

1\. Verified Food Database

2\. Micronutrient Tracking

3\. Coach Katie Proactive Push Notifications

4\. Gamification

5\. Health Integrations

6\. Admin Messaging

7\. Habit Coaching Calendar

8\. Exercise Video Library

9\. Admin Client Dashboard

10\. Community Enhancement

11\. Cycle/Hormone Tracking

12\. Voice Logging

13\. GLP-1 Support

14\. Triple R Daily Lessons



\## Mobile Rule



Every page and feature must work on desktop and mobile.



Mobile expectations:

\- Sidebar hidden on mobile

\- Drawer overlay for menu

\- Bottom nav fixed

\- 44px tap targets where possible

\- No desktop-only layouts

\- No horizontal overflow



\## AI Coaching Philosophy



Coach Katie should become proactive, not reactive.



Future Katie behaviors:

\- Morning insight

\- Weekly pattern detection

\- Re-engagement nudges

\- Tomorrow’s Plan

\- Low protein alerts

\- Poor sleep correlation

\- Missed log nudges



Brain Mapping currently means weekly trainings, not AI chat.



\## Git Rules



Before making meaningful changes:

\- Inspect relevant files first



After making changes:

\- Run tests/build if available

\- Commit with a descriptive message

\- Push to GitHub main



Use descriptive commit messages.

