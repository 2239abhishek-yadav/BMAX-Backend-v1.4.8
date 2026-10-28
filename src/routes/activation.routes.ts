import { Router, Request, Response } from 'express';
import {
  activateSubscription,
  previewActivation,
  getLocalSubscriptionState,
  previewAddonActivation,
  activateAddon,
} from '../lib/subscription';

/**
 * Dedicated activation endpoint.
 *
 * This is intentionally separate from the general subscription router so the
 * desktop renderer has a stable, unambiguous activation contract even when a
 * packaged build is served with a different API base path.
 */
const router = Router();

const invalidCodeMessage = 'Invalid activation code. Please check the code and try again.';

router.get('/health', (_req: Request, res: Response) => {
  res.json({ success: true, service: 'activation', version: require('../../package.json').version });
});

router.post('/preview', (_req: Request, res: Response) => {
  try {
    const licenseKey = String(_req.body?.licenseKey || '').trim().toUpperCase();
    if (!licenseKey) return res.status(400).json({ success: false, error: 'License key is required.' });
    const preview = previewActivation(licenseKey);
    return res.json({ success: true, data: preview });
  } catch (err: any) {
    const status = Number(err?.status || 0);
    return res.status(status >= 400 && status < 600 ? status : 400).json({
      success: false,
      error: err?.code === 'INVALID_ACTIVATION_CODE' || status === 400
        ? invalidCodeMessage
        : (err?.message || 'Unable to preview the activation. Please try again.'),
    });
  }
});


router.post('/preview-addon', (req: Request, res: Response) => {
  try {
    const addonCode = String(req.body?.addonCode || '').trim().toUpperCase();
    const addonType = String(req.body?.addonType || 'ADDITIONAL_USER').trim().toUpperCase();
    if (!addonCode) return res.status(400).json({ success: false, error: 'Add-on activation code is required.' });
    return res.json({ success: true, data: previewAddonActivation(addonCode, addonType) });
  } catch (err:any) {
    const status=Number(err?.status||0);
    return res.status(status>=400&&status<600?status:400).json({success:false,error:err?.message||'Unable to preview the add-on activation.'});
  }
});

router.post('/activate-addon', (req: Request, res: Response) => {
  try {
    const addonCode = String(req.body?.addonCode || '').trim().toUpperCase();
    const addonType = String(req.body?.addonType || 'ADDITIONAL_USER').trim().toUpperCase();
    if (!addonCode) return res.status(400).json({ success: false, error: 'Add-on activation code is required.' });
    if (req.body?.confirmApply !== true) return res.status(409).json({ success: false, error: 'Please confirm the add-on activation before applying it.', code:'CONFIRM_ADDON_REQUIRED' });
    return res.json({ success: true, data: activateAddon(addonCode, addonType) });
  } catch (err:any) {
    const status=Number(err?.status||0);
    return res.status(status>=400&&status<600?status:400).json({success:false,error:err?.message||'Unable to activate the add-on.'});
  }
});

router.post('/activate', async (req: Request, res: Response) => {
  try {
    const licenseKey = String(req.body?.licenseKey || '').trim().toUpperCase();
    const email = String(req.body?.email || '').trim().toLowerCase();
    const confirmReplace = req.body?.confirmReplace === true;
    if (!licenseKey) return res.status(400).json({ success: false, error: 'License key is required.' });
    const state = await activateSubscription(licenseKey, email || undefined, confirmReplace);
    return res.json({ success: true, data: state });
  } catch (err: any) {
    const status = Number(err?.status || 0);
    return res.status(status >= 400 && status < 600 ? status : 400).json({
      success: false,
      error: err?.code === 'INVALID_ACTIVATION_CODE' || status === 400
        ? invalidCodeMessage
        : (err?.message || 'Unable to activate the plan. Please try again.'),
      data: getLocalSubscriptionState(),
    });
  }
});

export default router;
