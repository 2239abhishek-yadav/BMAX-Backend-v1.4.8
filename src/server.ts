import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import packageJson from '../package.json';
import { initializeDatabase, db } from './lib/db';
import router from './routes';
import subscriptionRouter from './routes/subscription.routes';
import licenseRouter from './routes/license.routes';
import activationRouter from './routes/activation.routes';
import addonRouter from './routes/addon.routes';
import profileRouter from './routes/profile.routes';
import cloudBackupRouter from './routes/cloud-backup.routes';
import { ensureCrmSchema } from './lib/crm';
import { accessControl } from './middleware/access-control';
import { previewAddonActivation, activateAddon } from './lib/subscription';

import { phoneGuard } from './middleware/phone-guard';

const app = express();
const PORT = Number(process.env.PORT || 4100);

// Middleware
const allowedCorsOrigins = new Set(['http://127.0.0.1:3000', 'http://localhost:3000', 'http://127.0.0.1:4100', 'http://localhost:4100', 'null']);
app.use(cors({ origin: (origin, callback) => {
  // B-MAX is a loopback desktop backend. Allow the packaged file:// renderer
  // (Origin: null) and local development only; never expose API CORS to arbitrary websites.
  if (!origin || allowedCorsOrigins.has(origin)) return callback(null, true);
  return callback(new Error('CORS origin not allowed'));
} }));
app.use(express.raw({ type: 'application/x-bmax-cloud-backup', limit: '100mb' }));
app.use(express.json({ limit: '30mb' }));
app.use(express.urlencoded({ limit: '30mb', extended: true }));
app.use(phoneGuard);

// Uploads directory
const uploadDir = process.env.UPLOADS_DIR || path.join(process.env.DB_PATH || path.join(process.cwd(), 'data'), 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
app.use('/uploads', express.static(uploadDir));

// API Routes
// Exact add-on activation endpoints are declared at server level as a hard
// contract. This prevents a packaged/legacy router mount mismatch from ever
// turning a valid add-on request into the global 404 response.
const handleAddonPreview = (req: express.Request, res: express.Response) => {
  try {
    const addonCode = String(req.body?.addonCode || '').trim().toUpperCase();
    const addonType = String(req.body?.addonType || 'ADDITIONAL_USER').trim().toUpperCase();
    if (!addonCode) return res.status(400).json({ success:false, error:'Add-on activation code is required.' });
    return res.json({ success:true, data: previewAddonActivation(addonCode, addonType) });
  } catch (err:any) {
    const status=Number(err?.status||0);
    return res.status(status>=400&&status<600?status:400).json({success:false,error:err?.message||'Unable to verify the add-on activation code.',code:err?.code||undefined});
  }
};
const handleAddonActivate = (req: express.Request, res: express.Response) => {
  try {
    const addonCode = String(req.body?.addonCode || '').trim().toUpperCase();
    const addonType = String(req.body?.addonType || 'ADDITIONAL_USER').trim().toUpperCase();
    if (!addonCode) return res.status(400).json({ success:false, error:'Add-on activation code is required.' });
    if (req.body?.confirmApply !== true) return res.status(409).json({success:false,error:'Please confirm the add-on activation before applying it.',code:'CONFIRM_ADDON_REQUIRED'});
    return res.json({success:true,data:activateAddon(addonCode, addonType)});
  } catch (err:any) {
    const status=Number(err?.status||0);
    return res.status(status>=400&&status<600?status:400).json({success:false,error:err?.message||'Unable to activate the add-on.',code:err?.code||undefined});
  }
};
app.post('/api/addon/preview', handleAddonPreview);
app.post('/api/addon/activate', handleAddonActivate);
app.post('/api/addon/preview-addon', handleAddonPreview);
app.post('/api/addon/activate-addon', handleAddonActivate);

app.use('/api/subscription', subscriptionRouter);
// Central licensing proxy: desktop -> Render -> Hostinger PHP/MySQL.
app.use('/api/license', licenseRouter);
// Stable dedicated activation API for packaged desktop builds.
app.use('/api/activation', activationRouter);
// Canonical add-on activation root for packaged builds.
app.use('/api/addon', addonRouter);
app.use('/api/addons', activationRouter);
// Extra stable compatibility mounts for packaged renderers and legacy builds.
app.use('/api/bmax/activation', activationRouter);
app.use('/bmax/activation', activationRouter);
// Compatibility mount for packaged/static renderers whose API base omits /api.
// Canonical API remains /api/subscription.
app.use('/subscription', subscriptionRouter);
app.use('/activation', activationRouter);
app.use('/addon', addonRouter);
app.use('/addons', activationRouter);
app.use('/api/profile', profileRouter);
// Customer cloud backups are authorized by a short-lived Hostinger account session.
app.use('/api/cloud-backup', cloudBackupRouter);
app.use(accessControl);
app.use('/api', router);


// Health check
app.get('/', (req, res) => {
  res.json({
    name: 'B-MAX',
    status: 'running',
    version: packageJson.version,
    time: new Date().toISOString(),
  });
});

// Safe diagnostics endpoint for deployment checks. Never return tokens, passwords, or DB credentials.
app.get('/__bmax/diagnostics', (_req: express.Request, res: express.Response) => {
  res.json({
    name: 'B-MAX',
    status: 'running',
    version: packageJson.version,
    routes: {
      registration: ['POST /subscription/register', 'POST /api/subscription/register'],
      login: ['POST /subscription/login', 'POST /api/subscription/login'],
      companyCreated: ['POST /subscription/company-created', 'POST /api/subscription/company-created'],
      plans: ['GET /subscription/plans', 'GET /api/subscription/plans'],
    },
    accountServerConfigured: Boolean(String(process.env.BMAX_PHP_ACCOUNT_API_URL || '').trim() && String(process.env.BMAX_PHP_ACCOUNT_API_TOKEN || '').trim()),
    centralLicenseServerEnabled: String(process.env.BMAX_USE_CENTRAL_LICENSE_SERVER || '') === '1',
    time: new Date().toISOString(),
  });
});

// 404 handler
app.use((req: express.Request, res: express.Response) => {
  res.status(404).json({ error: 'Route not found' });
});

// Error handler
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('[Error]', err);
  res.status(err.status || 500).json({ error: err.message || 'Internal Server Error' });
});

// Initialize DB and start
try {
  initializeDatabase();
  // Preserve customer document-format settings across startup and upgrades.
  ensureCrmSchema();
  // Render public web services must bind to 0.0.0.0.
  // Keep the packaged Electron/local backend bound to loopback.
  const HOST =
    process.env.RENDER === 'true' || Boolean(process.env.RENDER_SERVICE_ID)
      ? '0.0.0.0'
      : '127.0.0.1';

  const server = app.listen(PORT, HOST, () => {
    const address = server.address();
    const actualPort = typeof address === 'object' && address ? address.port : PORT;
    console.log(`BMAX_BACKEND_READY:${actualPort}`);
    console.log(`✅ B-MAX Server running at http://${HOST}:${actualPort}`);
  });
  server.on('error', (err) => {
    console.error('❌ B-MAX Server listen error:', err);
    // Let Electron's startup handler surface the real error instead of
    // silently terminating the entire packaged application.
    throw err;
  });
} catch (err) {
  console.error('❌ Failed to initialize:', err);
  // This backend is loaded in-process by Electron in packaged builds.
  // Throw so the main process can show a visible startup error and log it.
  throw err;
}

export default app;



