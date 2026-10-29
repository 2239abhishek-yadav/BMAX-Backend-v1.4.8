B-MAX v1.4.8 company-preservation Render backend patch

Deploy this ZIP only to the new dedicated Render backend GitHub repository that serves https://bmax-backend-v1-4-8.onrender.com.
Keep Runtime Node, Build Command `npm install && npm run build`, Start Command `npm start` (or existing equivalent `npm run start`).
Keep existing environment variables; do not upload secrets or config.php.
The companion Hostinger PHP API must also be updated to the matching company_list action before using the desktop build.
This patch adds authenticated GET /api/cloud-backup/companies. It does not provide real-time live data synchronization; it supports safe company recovery using the latest cloud snapshot.
