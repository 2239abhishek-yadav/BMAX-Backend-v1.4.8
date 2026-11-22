# B-MAX v1.4.12 — Private backend deployment package for Render

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

## Important database and product-image persistence note
The backend stores SQLite data under `DB_PATH` and uploaded product photos under `UPLOADS_DIR` (default: `<DB_PATH>/uploads`). Render's ordinary service filesystem is ephemeral. Before using production customer data or uploading item photos, attach a persistent disk to the existing service (commonly mounted at `/var/data`) and set both environment variables:
- `DB_PATH=/var/data`
- `UPLOADS_DIR=/var/data/uploads`

Keep both paths on the same persistent disk so item records and their `/uploads/items/<filename>` photos survive deploys/restarts. Do not commit the database, uploaded photos, customer backups, or secrets into source control. A successful deploy alone does **not** prove persistence; verify the mounted disk and environment values in the existing Render service before production use.

## Validation status
Archive structure, package JSON, required backend source, and port-binding logic were checked. This archive has not been deployed to Render from this environment, so live deployment and data persistence must be verified after upload.
