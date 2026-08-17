# My Student Hub

## What it's for

It's meant to be the one place a student keeps everything school-related:
classes and their schedule, a calendar of due dates and events, a GPA
tracker, study tools, quick notes, and even a private password vault —
instead of juggling five different apps.

## How it works (the important part)

- **Everything is local.** All your data — profile, classes, calendar,
  notes, passwords, etc. — is saved in the browser's `localStorage` on
  your device. Nothing is sent to a server, and there's no login.
- That also means: **it's tied to one browser on one device.** Clearing
  your browser data will erase it, and it won't automatically show up on
  another device or browser unless you manually move it.
- It works offline for everything except two small external libraries
  (loaded from a CDN) used for the Notes tool — math rendering and
  markdown formatting.
- It's built mobile-first (fits a phone screen like an app, with a
  bottom nav bar), but works fine in a desktop browser too.
- It has a light/dark mode toggle.

## What's in it

### Home
A dashboard: greeting with your name/photo, today's classes, upcoming
calendar items, and quick-access links you can customize (school
portal, email, etc.).

### Classes
Add your classes with days/times, room, course code, and grade. Shows
what's currently in session and what's next.

### Calendar
A month/agenda view for assignments, tests, projects, and other events.
Events can be color-coded and linked to a specific class; individual
days can also be given a custom color (e.g., to mark breaks or
important dates).

### Tools
A hub of utilities:
- **Projects & To-Dos** — Kanban-style boards for tracking tasks.
- **Study Sets** — Flashcards and self-quizzes for studying.
- **GPA Calculator** — Add courses (name, credits, grade) to estimate
  your GPA. Optionally blends in your "Current GPA" (set in Settings)
  weighted by prior credit hours, so it can estimate your *cumulative*
  GPA rather than just the GPA of the courses you've entered.
- **Study Timer** — A Pomodoro-style focus/break timer with adjustable
  durations.
- **Quick Notes** — Simple sticky-note style notes.
- **Notes** — Richer notes supporting Markdown formatting, inline
  images, and math notation (rendered via LaTeX/KaTeX).
- **Checklists** — Basic checklist lists for packing, assignments, etc.
- **Passwords / Info Vault** — Store logins and other sensitive info
  (username, email, password, website, phone, notes) with a
  show/hide toggle for the password field. (Remember: since this isn't
  encrypted, it's only as secure as the device/browser it's stored on.)

### Settings / Profile
- Edit your name, birthday, MEID, email, phone, school, and current
  GPA.
- Upload a profile photo with a **crop/reposition tool** — drag to
  position and use a zoom slider to frame it exactly how you want
  before saving.
- Toggle dark mode.
- Reset all app data back to a blank slate.

## Bottom line
Think of it as a lightweight, private, offline-capable "student
dashboard" app — everything lives in one HTML file and one browser's
local storage, with no accounts and no cloud sync.
