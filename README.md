<div align="center">
  <img src="assets/nexo-wordmark.svg" alt="Nexo" width="180" />
  <h1>Nexo — Clinic Booking Assistant</h1>
  <p>A shared workspace for physical therapy clinics.<br />Natural-language booking, coordinated schedules and connected calendars.</p>
  <p>
    <a href="https://www.tella.tv/video/vid_cmw5how9u000008jmct6rcsgl/view"><strong>Watch the demo ↗</strong></a>
    &nbsp;·&nbsp; English & Spanish interface
  </p>
  <p>
    <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white" />
    <img alt="React" src="https://img.shields.io/badge/React-161D22?style=flat-square&logo=react&logoColor=61DAFB" />
    <img alt="Node.js" src="https://img.shields.io/badge/Node.js-417E38?style=flat-square&logo=nodedotjs&logoColor=white" />
    <img alt="Supabase" src="https://img.shields.io/badge/Supabase-161D22?style=flat-square&logo=supabase&logoColor=3FCF8E" />
  </p>
</div>

<a href="https://www.tella.tv/video/vid_cmw5how9u000008jmct6rcsgl/view">
  <img src="assets/nexo-dashboard-en.jpg" alt="Nexo’s English dashboard in Obsidian dark mode, showing a weekly calendar, therapist filters and upcoming appointments with sample patient data." width="100%" />
</a>

<p align="center"><sub>English dashboard · Sample data · The video walkthrough is in Spanish.</sub></p>

## Features

- **Book through Telegram.** Patients request appointments in natural language, choose a therapist or time window, and confirm using guided buttons. The assistant can book a full week, reschedule or cancel appointments.
- **Manage a shared calendar.** Weekly and daily views, flexible patient and therapist search, manual bookings, rescheduling, cancellations and recovery of removed appointments.
- **Keep patient details together.** Shared records with required name and phone, plus optional insurance, patient-reported diagnosis and additional notes.
- **Bring a person into the conversation.** A reception inbox with persistent chat history, human handoff, staff replies and the option to resume the assistant.
- **Give therapists their own workspace.** Role-based access for administrators, reception and therapists; professional profiles, working hours, breaks, session duration and time off.
- **Connect Google Calendar and Gmail.** Each therapist connects their own account. Nexo syncs appointments, changes and cancellations, sets a 30-minute reminder and emails new booking notifications.
- **Stay informed.** Appointment activity feed, browser notifications, sound preferences and quick actions.
- **Choose your interface.** English or Spanish, light or Obsidian dark mode, responsive layouts and reduced-motion support.

## Tech stack

| Layer | Technologies |
| :--- | :--- |
| Frontend | React, TypeScript, Vite, Lucide |
| Backend | Node.js, Fastify, Zod |
| Data & authentication | Supabase Auth, PostgreSQL, SQL migrations; optional local PGlite storage |
| AI | OpenRouter, GPT-6 Luna; backend-controlled availability and booking |
| Messaging | Telegram Bot API, long polling, persistent delivery queue |
| Integrations | Google Calendar API, Gmail API, OAuth 2.0 |
| Dates & time zones | Temporal |
| Quality | Vitest, TypeScript checks, GitHub Actions |
