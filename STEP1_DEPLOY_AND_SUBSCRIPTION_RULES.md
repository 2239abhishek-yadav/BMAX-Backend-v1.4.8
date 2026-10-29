# B-MAX v1.4.0 — Step 1: registration route diagnostics

## Customer trial and paid plan rule
- Customer trial should begin automatically only after the first company is successfully created.
- Registering or logging in must not start or reset the trial.
- A paid plan must not be self-granted by the desktop app. The admin (B-MAX owner) must issue/approve the license from the server/admin side; the customer app only submits the issued license key for activation.
- The current desktop backend uses a 15-day trial, beginning only after the first company is successfully created. The Render source bundle must match the desktop backend trial policy.

## Step 1 diagnostic route
After deploying the backend, open:
`https://YOUR-RENDER-SERVICE/__bmax/diagnostics`

Expected JSON includes the registered POST route paths and boolean configuration status only. It must never expose secret values.

The account endpoints are expected at both:
- `POST /subscription/register`
- `POST /api/subscription/register`

The browser address bar uses GET and is not a valid way to test the registration POST; use the app or an HTTP client for the actual registration flow.

## Important
This patch adds safe route diagnostics to help identify which backend build is deployed. It does not claim that a full admin license-management panel or live Hostinger/Render integration has been end-to-end tested. Do not reset the production database or replace credentials as part of this step.
