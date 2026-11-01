import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../lib/db';
import {
  activateSubscription,
  previewActivation,
  ensureSubscription,
  registerEmailAccount,
  getLicenseServerUrl,
  getLocalSubscriptionState,
  getSubscriptionAccess,
  startTrialAfterCompanyCreation,
  previewAddonActivation,
  activateAddon,
} from '../lib/subscription';
import { getPlanCatalog } from '../lib/plan-entitlements';

const router = Router();

// Public commercial catalog used by the desktop Plans page. Pricing is kept
// server-side as the canonical source; the frontend may cache/display it but
// must not invent add-on rates.
router.get('/plans', (_req: Request, res: Response) => {
  res.json({ success: true, data: getPlanCatalog() });
});


// All customer accounts are authoritative on the PHP account server so the same
// credentials work on every PC through the Render account API proxy.
async function phpAccountRequest(action: 'register'|'login'|'company', payload: Record<string, any>) {
  const endpoint = String(process.env.BMAX_PHP_ACCOUNT_API_URL || '').trim();
  const token = String(process.env.BMAX_PHP_ACCOUNT_API_TOKEN || '').trim();
  if (!endpoint || !token) {
    const err: any = new Error('Central account server is not configured. Set BMAX_PHP_ACCOUNT_API_URL and BMAX_PHP_ACCOUNT_API_TOKEN in Render.');
    err.status = 503; throw err;
  }
  if (!/^https:\/\//i.test(endpoint)) {
    const err: any = new Error('Central account API must use HTTPS.'); err.status = 503; throw err;
  }
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bmax-api-token': token },
    body: JSON.stringify({ action, ...payload }),
    signal: AbortSignal.timeout(25000),
  });
  const data: any = await response.json().catch(() => ({}));
  if (!response.ok || data?.success !== true) {
    const err: any = new Error(data?.error || `Central account server returned HTTP ${response.status}.`);
    err.status = response.status >= 400 && response.status < 600 ? response.status : 502;
    if (typeof data?.requestId === 'string') err.requestId = data.requestId;
    console.error('[B-MAX central account API]', { action, httpStatus: response.status, requestId: err.requestId || null, error: String(err.message).slice(0, 160) });
    throw err;
  }
  return data.data || {};
}

router.post('/register', async (req: Request, res: Response) => {
  try {
    const name = String(req.body?.name || '').trim();
    const phone = String(req.body?.phone || '').replace(/\D/g, '');
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const confirmPassword = String(req.body?.confirmPassword || '');
    // Optional free-form referral code; preserve user-entered text, bounded for storage safety.
    const referralCode = String(req.body?.referralCode || '').trim().slice(0, 500);
    if (name.length < 2) return res.status(400).json({ success:false, error:'Please enter your full name.' });
    if (!/^\d{10,15}$/.test(phone)) return res.status(400).json({ success:false, error:'Please enter a valid mobile number with country code if required.' });
    if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ success:false, error:'Please enter a valid email address.' });
    if (password.length < 8) return res.status(400).json({ success:false, error:'Password must be at least 8 characters.' });
    if (password !== confirmPassword) return res.status(400).json({ success:false, error:'Passwords do not match.' });
    // PHP stores a password_hash() hash; plaintext is sent only over HTTPS and never logged.
    const account = await phpAccountRequest('register', { name, phone, email, password, referralCode });
    const id = String(account.id || uuidv4());
    const now = new Date().toISOString();
    const existing: any = db.prepare('SELECT id FROM users WHERE email=? LIMIT 1').get(email);
    if (!existing) {
      db.prepare('INSERT INTO users (id,name,email,phone,isActive,createdAt,updatedAt) VALUES (?,?,?,?,1,?,?)')
        .run(id, name, email, phone, now, now);
    } else {
      db.prepare('UPDATE users SET name=?,phone=?,updatedAt=? WHERE email=?').run(name, phone, now, email);
    }
    return res.status(201).json({ success:true, data:{ id, name, phone, email, registered:true, otpRequired:false } });
  } catch (err: any) {
    return res.status(Number(err?.status || 503)).json({ success:false, error:err?.message || 'Registration failed. Please try again.' });
  }
});

router.post('/login', async (req: Request, res: Response) => {
  let stage = 'validate';
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ success:false, error:'Please enter a valid email address.' });
    if (!password) return res.status(400).json({ success:false, error:'Password is required.' });
    stage = 'hostinger_authentication';
    const account = await phpAccountRequest('login', { email, password });
    stage = 'render_local_user_sync';
    const now = new Date().toISOString();
    const id = String(account.id || uuidv4());
    const name = String(account.name || email.split('@')[0]);
    const phone = String(account.phone || '');
    let user: any = db.prepare('SELECT * FROM users WHERE email=? LIMIT 1').get(email);
    if (!user) {
      db.prepare('INSERT INTO users (id,name,email,phone,isActive,createdAt,updatedAt) VALUES (?,?,?,?,1,?,?)')
        .run(id, name, email, phone || null, now, now);
      user = db.prepare('SELECT * FROM users WHERE id=?').get(id);
    } else {
      db.prepare('UPDATE users SET name=?,phone=COALESCE(?,phone),updatedAt=? WHERE id=?').run(name, phone || null, now, user.id);
      user = db.prepare('SELECT * FROM users WHERE id=?').get(user.id);
    }
    res.json({ success:true, data:{ ...account, localUser:user, subscription:account?.subscription || getLocalSubscriptionState() } });
  } catch (err: any) {
    console.error('[B-MAX account login]', {
      stage,
      httpStatus: Number(err?.status || 503),
      requestId: typeof err?.requestId === 'string' ? err.requestId : null,
      error: String(err?.message || 'Sign-in failed').slice(0, 200),
    });
    res.status(Number(err?.status || 503)).json({
      success:false,
      error:err?.message || 'Sign-in failed. Check your email and password.',
      ...(typeof err?.requestId === 'string' ? { requestId: err.requestId } : {}),
    });
  }
});

router.post('/company-created', async (req: Request, res: Response) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const firmId = String(req.body?.firmId || '').trim();
    const firmName = String(req.body?.firmName || '').trim();
    if (!/^\S+@\S+\.\S+$/.test(email) || !firmId || !firmName) {
      return res.status(400).json({ success:false, error:'Customer email, company ID and company name are required.' });
    }
    const data = await phpAccountRequest('company', {
      email, firmId, firmName,
      company: req.body?.company && typeof req.body.company === 'object' ? req.body.company : {},
    });
    return res.json({ success:true, data });
  } catch (err: any) {
    return res.status(Number(err?.status || 503)).json({ success:false, error:err?.message || 'Unable to sync company details to the central account server.' });
  }
});

router.post('/bootstrap', async (req: Request, res: Response) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const state = await ensureSubscription(email || undefined);
    res.json({ success: true, data: state, licenseServerUrl: getLicenseServerUrl() });
  } catch (err: any) {
    const state = getLocalSubscriptionState();
    res.status(503).json({
      success: false,
      error: err?.message || 'Unable to verify B-MAX subscription.',
      code: err?.code || 'SUBSCRIPTION_ERROR',
      data: state,
    });
  }
});

router.get('/status', async (req: Request, res: Response) => {
  // Refresh the authoritative central license before returning status. Prefer the
  // currently signed-in account from the request header over a stale local cached
  // email; otherwise switching accounts can keep showing the previous account's trial.
  const local = getLocalSubscriptionState();
  const requestEmail = String(req.headers['x-bmax-user-email'] || '').trim().toLowerCase();
  const email = requestEmail || String(local?.email || '').trim().toLowerCase();
  try {
    const refreshed = await ensureSubscription(email || undefined);
    const access = getSubscriptionAccess();
    return res.json({
      success: true,
      data: access.state || refreshed,
      allowed: access.allowed,
      readOnly: access.readOnly,
      reason: access.reason,
      licenseServerUrl: getLicenseServerUrl(),
    });
  } catch (err: any) {
    const access = getSubscriptionAccess();
    return res.status(503).json({
      success: false,
      error: err?.message || 'Unable to refresh the central B-MAX license.',
      data: access.state,
      allowed: access.allowed,
      readOnly: access.readOnly,
      reason: access.reason,
      licenseServerUrl: getLicenseServerUrl(),
    });
  }
});

// Account-level live usage for the Plans overview. Counts active companies and
// distinct active users across the account so the UI can show used/available
// capacity without guessing from a single selected company.
router.get('/usage', (_req: Request, res: Response) => {
  try {
    const access = getSubscriptionAccess();
    const usedFirms = Number((db.prepare('SELECT COUNT(*) AS c FROM firms').get() as any)?.c || 0);
    const usedUsers = Number((db.prepare(`SELECT COUNT(DISTINCT fu.userId) AS c FROM firm_users fu JOIN users u ON u.id=fu.userId WHERE fu.isActive=1 AND u.isActive=1`).get() as any)?.c || 0);
    const maxFirms = Number(access.state?.maxFirms || 0);
    const maxUsers = Number(access.state?.maxUsers || 0);
    res.json({ success: true, data: {
      usedFirms, usedUsers, maxFirms, maxUsers,
      remainingFirms: Math.max(0, maxFirms - usedFirms),
      remainingUsers: Math.max(0, maxUsers - usedUsers),
      additionalFirms: Number(access.state?.additionalFirms || 0),
      additionalUsers: Number(access.state?.additionalUsers || 0),
      planName: access.state?.planName || null,
      durationCode: access.state?.durationCode || null,
      activatedAt: access.state?.activatedAt || null,
      expiresAt: access.state?.expiresAt || null,
      status: access.state?.status || null,
    }});
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || 'Unable to load subscription usage.' });
  }
});

router.post('/start-trial-after-company', async (req: Request, res: Response) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase() || undefined;
    const state = await startTrialAfterCompanyCreation(email);
    res.json({ success: true, data: state });
  } catch (err: any) {
    res.status(err?.status && Number(err.status) >= 400 ? Number(err.status) : 503).json({
      success: false,
      error: err?.message || 'Unable to start the B-MAX trial.',
      data: getLocalSubscriptionState(),
    });
  }
});

router.post('/preview-activation', async (req: Request, res: Response) => {
  try {
    const licenseKey = String(req.body?.licenseKey || '').trim().toUpperCase();
    if (!licenseKey) return res.status(400).json({ success: false, error: 'License key is required.' });
    const preview = previewActivation(licenseKey);
    res.json({ success: true, data: preview });
  } catch (err: any) {
    res.status(err?.status && Number(err.status) >= 400 ? Number(err.status) : 400).json({
      success: false,
      error: err?.code === 'INVALID_ACTIVATION_CODE' || Number(err?.status) === 400
        ? 'Invalid activation code. Please check the code and try again.'
        : (err?.message || 'Unable to preview the activation. Please try again.'),
    });
  }
});


router.post('/preview-addon', (_req: Request, res: Response) => {
  try {
    const addonCode = String(_req.body?.addonCode || '').trim().toUpperCase();
    const addonType = String(_req.body?.addonType || 'ADDITIONAL_USER').trim().toUpperCase();
    if (!addonCode) return res.status(400).json({ success: false, error: 'Add-on activation code is required.' });
    const preview = previewAddonActivation(addonCode, addonType);
    return res.json({ success: true, data: preview });
  } catch (err: any) {
    const status = Number(err?.status || 0);
    return res.status(status >= 400 && status < 600 ? status : 400).json({ success: false, error: err?.message || 'Unable to preview the add-on activation.' });
  }
});

router.post('/activate-addon', (_req: Request, res: Response) => {
  try {
    const addonCode = String(_req.body?.addonCode || '').trim().toUpperCase();
    const addonType = String(_req.body?.addonType || 'ADDITIONAL_USER').trim().toUpperCase();
    if (!addonCode) return res.status(400).json({ success: false, error: 'Add-on activation code is required.' });
    if (_req.body?.confirmApply !== true) return res.status(409).json({ success: false, error: 'Please confirm the add-on activation before applying it.', code: 'CONFIRM_ADDON_REQUIRED' });
    const state = activateAddon(addonCode, addonType);
    return res.json({ success: true, data: state });
  } catch (err: any) {
    const status = Number(err?.status || 0);
    return res.status(status >= 400 && status < 600 ? status : 400).json({ success: false, error: err?.message || 'Unable to activate the add-on.' });
  }
});

router.post('/activate', async (req: Request, res: Response) => {
  try {
    const licenseKey = String(req.body?.licenseKey || '').trim().toUpperCase();
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!licenseKey) return res.status(400).json({ success: false, error: 'License key is required.' });
    const state = await activateSubscription(licenseKey, email || undefined, req.body?.confirmReplace === true);
    res.json({ success: true, data: state });
  } catch (err: any) {
    res.status(err?.status && Number(err.status) >= 400 ? Number(err.status) : 400).json({
      success: false,
      error: err?.code === 'INVALID_ACTIVATION_CODE' || Number(err?.status) === 400
        ? 'Invalid activation code. Please check the code and try again.'
        : (err?.message || 'Unable to verify the activation code. Please try again.'),
      data: getLocalSubscriptionState(),
    });
  }
});

export default router;



