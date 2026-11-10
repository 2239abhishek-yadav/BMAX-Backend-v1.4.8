# Render deployment correction — v1.4.11

The Render build failed with TS2307 because `src/lib/db.ts` imports
`../backup/database-restore`, but that module was missing from the GitHub deployment bundle.

This package adds the matching backend source file at:
`src/backup/database-restore.ts`

Do not remove or stub this module. It validates pending SQLite restore files, preserves a rollback snapshot, and applies a staged restore before the database connection opens.

## Apply
1. Extract this ZIP.
2. In the existing private Render backend GitHub repository, add `src/backup/database-restore.ts` at the exact path shown above.
3. Commit and push.
4. In Render, keep the existing service and environment variables. Re-deploy the new commit.
5. Confirm the TypeScript build succeeds and check runtime logs.

Do not upload `.env`, credentials, customer databases, or private keys.

## Runtime version
The failed Render log also shows Node.js 20.13.0, while this backend declares Node.js >=22.
This corrected package includes `.node-version` set to `22.22.1`. Ensure Render detects this file
from the configured Root Directory. If it does not, set the Render service Node version to 22.22.1
using the service's supported runtime setting, then redeploy.
