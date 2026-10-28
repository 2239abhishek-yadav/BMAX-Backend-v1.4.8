# B-MAX Backend — Render deployment repository

This folder is the backend-only source for a NEW PRIVATE GitHub repository connected to Render. Upload the CONTENTS of this folder at repository root, not the containing folder.

## GitHub setup
1. Create a repository named `BMAX-Backend-Render` (Private).
2. Upload all files/folders in this directory so `package.json`, `tsconfig.json`, and `src/server.ts` are at the repository root / `src/`.
3. Do not upload `.env`, customer databases/backups, `node_modules`, `dist`, or credentials.

## Render setup
- Create a Web Service connected to that private repository and the intended branch (usually `main`).
- Runtime: Node.
- Build Command: `npm install && npm run build`
- Start Command: `npm start`
- Node version: 22 or later (`package.json` engines).
- Preserve the current environment variables. Copy them securely from the existing service; never put secrets into GitHub.
- If the backend needs a persistent disk, configure it and set `DB_PATH` to a path on that disk before using production data. Confirm persistence and backup/restore before moving live customers.

## Important
This is a source package, not a deployment confirmation. First deploy it to a staging/new service and verify health, login, trial, sales billing, and persistence. Do not delete the existing Render service or database until the new service has passed tests. The trial is still subject to the central account API/Hostinger configuration; a Render build alone cannot prove the 15-day trial works end-to-end.
