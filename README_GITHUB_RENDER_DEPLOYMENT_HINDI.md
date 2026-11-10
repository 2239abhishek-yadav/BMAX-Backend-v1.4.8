# B-MAX v1.4.11 — Render Backend (GitHub deployment package)

This ZIP contains ONLY the backend source intended for the existing private GitHub repository connected to the existing Render Web Service.

## Upload location

Extract this ZIP locally. Upload the **contents** of the extracted folder to the ROOT of the existing private backend repository (so `package.json`, `tsconfig.json`, `src/`, and `scripts/` are at repository root). Do NOT upload this as a nested `deployment/render-backend/` folder unless your existing Render Root Directory is explicitly configured to that path.

Before replacing files, make a branch or backup of the currently deployed commit. Do not delete the Render service or change its connected repository/branch.

## Included change

`src/routes/batches.routes.ts` requires the selected `firmId` for batch history, verifies that the batch belongs to that firm, and scopes document/manufacturing history to that firm. The desktop client must send `firmId` as query parameter or `x-bmax-firm-id` header.

## Excluded intentionally

No `.env`, credentials, API tokens, `config.php`, private keys, customer databases/backups, `node_modules/`, or compiled `dist/` are included. Never commit secrets or customer data.

## Existing Render service settings

Keep the existing service and its current environment variables. If the existing settings already work, do not change them. The package scripts are:

- Build: `npm install && npm run build`
- Start: `npm start`
- Node.js: `>=22.0.0`

If the service uses a Root Directory, set it to the repository root for this package (blank/root in the usual Render configuration). Do not blindly change settings on a working service.

## After push

1. Wait for deployment to finish in the existing Render service.
2. Inspect deploy logs for TypeScript/build/start errors.
3. Confirm the service health/root response and version.
4. Test batch history with two test firms: firm A can only see A's batch transactions; firm B can only see B's. Missing firm context must be rejected. Do not test against live customer data until a backup is verified.
5. Confirm the desktop client is sending the selected `firmId` on batch-history requests. Backend deployment alone cannot fix a client that omits it.

## Validation boundary

This archive was extracted from the reviewed B-MAX v1.4.11 source package and ZIP integrity was checked. It has not been pushed to GitHub or deployed to Render from this environment. Live deployment, database persistence, and two-firm integration still require verification.
