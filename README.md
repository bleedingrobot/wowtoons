# Raid Loot Tracker

A lightweight World of Warcraft Classic companion app to track characters, raid lockouts, loot wishlists, and raid priority.

## Stack

- Frontend: React + Vite
- Auth: Firebase Authentication (Google)
- Database: Firestore
- Hosting: GitHub Pages (static)
- Icons: public WoW icon CDN (WowHead/Zamimg)

## Features Included

- Google sign-in and per-user data isolation
- Battle.net account and character management
- Raid lockout checkboxes with weekly reset date calculation
- Loot wishlist with priority and obtained status
- Urgency dashboard sorted by weighted loot + lockout penalty
- Mobile responsive dark fantasy UI

## Pages

- `/` dashboard
- `/characters` character and account management
- `/raids` raid lockout tracker
- `/loot` loot wishlist editor
- `/settings` auth and app setup

## Local Setup

1. Install dependencies:

```bash
npm install
```

2. Create `.env.local` from `.env.example` and add Firebase values.
3. Run dev server:

```bash
npm run dev
```

## Firebase Setup

1. Create a Firebase project.
2. Enable Authentication -> Google provider.
3. Create Firestore (production mode is fine if rules are set).
4. Apply `firestore.rules` from this repo.
5. Add web app config to `.env.local`.

Detailed data model and structure are in [docs/firebase-schema.md](docs/firebase-schema.md).

## GitHub Pages Deployment

1. This repo is configured with:

```json
"homepage": "https://bleedingrobot.github.io/wowtoons/"
```

2. Build and publish:

```bash
npm run deploy
```

This publishes `dist` to the `gh-pages` branch.

Live site URL after deploy:

[Live Site (GitHub Pages)](https://bleedingrobot.github.io/wowtoons/)

## Architecture Notes

See [docs/architecture.md](docs/architecture.md) for app flow and urgency algorithm details.
