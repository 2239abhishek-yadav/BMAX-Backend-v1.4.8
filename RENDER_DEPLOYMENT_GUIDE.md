# B-MAX v1.4.0 — Private backend deployment package for Render

This archive is **backend-only**. Its contents are intended to be placed at the ROOT of the existing private source repository connected to the existing Render web service. Do not upload this as a nested `backend/` folder.

## Before uploading
1. Confirm the connected source repository is private and is not publicly accessible.
2. Keep a copy of the currently deployed source and do not delete the Render service.
3. Do not upload `.env`, credentials, database files, customer backups, `node_modules`, or `dist`.
4. Upload the CONTENTS of this archive to the repository root so `package.json`, `tsconfig.json`, and `src/server.ts` are at root / `src/`.

## Existing Render service
A new commit on the connected private source branch can trigger Auto-Deploy. Do not make the source repository public or create a second Render service.

The backend package commands are:
- Build Command: `npm install && npm run build`
- Start Command: `npm start`

If these are already configured in the existing service, leave them unchanged. Confirm the service's connected repository and branch before committing.

## Port binding
On Render, `src/server.ts` binds to `0.0.0.0` when `RENDER=true` or `RENDER_SERVICE_ID` is present. In local/packaged desktop mode it stays bound to `127.0.0.1`. The port is read from `process.env.PORT` with a local fallback.

If the Render service does not provide `RENDER_SERVICE_ID`, add the environment variable `RENDER=true` in the Render service settings.

## After commit
1. Wait for the existing Render service's deploy to finish.
2. Confirm logs show `B-MAX Server running at http://0.0.0.0:<port>` and no port scan timeout.
3. Open the service's root URL; it should return JSON with `name: B-MAX`, `status: running`, and `version: 1.4.0`.
4. Test a safe health endpoint first. Do not test restore/backup or real customer writes until database persistence and backups are confirmed.

## Important database note
The backend currently uses SQLite and a local `data` path by default. A successful deploy does **not** prove the database is persistent across restarts. Before using production customer data, confirm a persistent Render disk is mounted and `DB_PATH` points into that mount; do not commit the database into source control.

## Validation status
Archive structure, package JSON, required backend source, and port-binding logic were checked. This archive has not been deployed to Render from this environment, so live deployment and data persistence must be verified after upload.
