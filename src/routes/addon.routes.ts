import { Router, Request, Response } from 'express';
import { previewAddonActivation, activateAddon } from '../lib/subscription';

/**
 * Canonical add-on activation API.
 *
 * This route is intentionally independent from the base subscription router.
 * The desktop renderer calls /api/addon/* so the add-on contract cannot be
 * confused with the older /subscription/* compatibility routes.
 */
const router = Router();

router.get('/health', (_req: Request, res: Response) => {
  res.json({ success: true, service: 'addon-activation', version: '1.16.85' });
});

router.post('/preview', (req: Request, res: Response) => {
  try {
    const addonCode = String(req.body?.addonCode || '').trim().toUpperCase();
    const addonType = String(req.body?.addonType || 'ADDITIONAL_USER').trim().toUpperCase();
    if (!addonCode) return res.status(400).json({ success: false, error: 'Add-on activation code is required.' });
    return res.json({ success: true, data: previewAddonActivation(addonCode, addonType) });
  } catch (err: any) {
    const status = Number(err?.status || 0);
    return res.status(status >= 400 && status < 600 ? status : 400).json({
      success: false,
      error: err?.message || 'Unable to verify the add-on activation code.',
      code: err?.code || undefined,
    });
  }
});

router.post('/activate', (req: Request, res: Response) => {
  try {
    const addonCode = String(req.body?.addonCode || '').trim().toUpperCase();
    const addonType = String(req.body?.addonType || 'ADDITIONAL_USER').trim().toUpperCase();
    if (!addonCode) return res.status(400).json({ success: false, error: 'Add-on activation code is required.' });
    if (req.body?.confirmApply !== true) {
      return res.status(409).json({
        success: false,
        error: 'Please confirm the add-on activation before applying it.',
        code: 'CONFIRM_ADDON_REQUIRED',
      });
    }
    return res.json({ success: true, data: activateAddon(addonCode, addonType) });
  } catch (err: any) {
    const status = Number(err?.status || 0);
    return res.status(status >= 400 && status < 600 ? status : 400).json({
      success: false,
      error: err?.message || 'Unable to activate the add-on.',
      code: err?.code || undefined,
    });
  }
});

// Compatibility aliases for older packaged renderers. They intentionally call
// the same canonical handlers so there is only one verification implementation.
router.post('/preview-addon', (req: Request, res: Response) => {
  const addonCode = String(req.body?.addonCode || '').trim().toUpperCase();
  const addonType = String(req.body?.addonType || 'ADDITIONAL_USER').trim().toUpperCase();
  if (!addonCode) return res.status(400).json({ success: false, error: 'Add-on activation code is required.' });
  try { return res.json({ success: true, data: previewAddonActivation(addonCode, addonType) }); }
  catch (err: any) { const status=Number(err?.status||0); return res.status(status>=400&&status<600?status:400).json({success:false,error:err?.message||'Unable to verify the add-on activation code.',code:err?.code||undefined}); }
});

router.post('/activate-addon', (req: Request, res: Response) => {
  const addonCode = String(req.body?.addonCode || '').trim().toUpperCase();
  const addonType = String(req.body?.addonType || 'ADDITIONAL_USER').trim().toUpperCase();
  if (!addonCode) return res.status(400).json({ success: false, error: 'Add-on activation code is required.' });
  if (req.body?.confirmApply !== true) return res.status(409).json({success:false,error:'Please confirm the add-on activation before applying it.',code:'CONFIRM_ADDON_REQUIRED'});
  try { return res.json({ success: true, data: activateAddon(addonCode, addonType) }); }
  catch (err: any) { const status=Number(err?.status||0); return res.status(status>=400&&status<600?status:400).json({success:false,error:err?.message||'Unable to activate the add-on.',code:err?.code||undefined}); }
});

export default router;
