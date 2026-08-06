# Banjo Spirits

An interactive memorial forest and star sky, built around a playable banjo. Visitors
walk a 3D forest, plant dedication trees, dedicate stars in the night sky, and play a
banjo whose strings are synthesised live in the browser (Karplus–Strong, WebAudio).

## Pages

- `index.html` — the playable banjo landing page.
- `forest.html` — 3D forest walkthrough with the banjo playable in the clearing, plus a
  visitor tree-style toggle (realistic ⇄ simple).
- `plant.html` — the forest with plant-a-tree dedications (tiered trees, adopt existing).
- `sky.html` — the night sky with star dedications, colour tiers and a banner shooting star.
- `realistic.html` — side-by-side realistic vs stylised tree preview.

## Two ways it runs

- **Static preview (GitHub Pages):** everything works, and dedications save on each
  visitor's own device (demo mode).
- **Live site (with the backend):** accounts + a shared database, so every visitor sees
  the same forest and sky. The front-end auto-detects the backend (`bs-api.js`).

## Backend (accounts + shared database)

Node/Express + PostgreSQL.

```bash
npm install
DATABASE_URL=postgres://user@host:5432/dbname JWT_SECRET=some-long-random-string npm start
# serves the site + API on http://localhost:3000
```

Environment variables:

- `DATABASE_URL` — PostgreSQL connection string (provided automatically by the host's
  Postgres add-on). The schema is created on first boot.
- `JWT_SECRET` — any long random string, used to sign login sessions.

### Deploy (one click)

1. Create the project from this repo on your host (Railway recommended).
2. Add a **PostgreSQL** database to the project — it sets `DATABASE_URL` automatically.
3. Add a `JWT_SECRET` variable (any long random string).
4. Deploy. The app migrates the database on first start and serves the whole site.

Point your domain (e.g. `banjospirits.com`) at the deployed URL to go live.

## Files

- `index.html`, `forest.html`, `plant.html`, `sky.html`, `realistic.html` — the pages.
- `bs-api.js` — client that talks to the backend, with an on-device fallback.
- `server.js`, `db.js` — the Express server and database schema.
- `banjo.jpg` — the banjo/forest artwork.
