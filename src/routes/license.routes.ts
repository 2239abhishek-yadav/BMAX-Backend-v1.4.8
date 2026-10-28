import { Router, Request, Response } from 'express';
const router = Router();
async function phpRequest(action: string, payload: Record<string, unknown>) {
  const endpoint = String(process.env.BMAX_PHP_ACCOUNT_API_URL || '').trim();
  const token = String(process.env.BMAX_PHP_ACCOUNT_API_TOKEN || '').trim();
  if (!endpoint || !token || !/^https:\/\//i.test(endpoint)) {
    const e: any = new Error('Central licensing is not configured. Set BMAX_PHP_ACCOUNT_API_URL and BMAX_PHP_ACCOUNT_API_TOKEN in Render.'); e.status = 503; throw e;
  }
  const response = await fetch(endpoint, { method:'POST', headers:{'content-type':'application/json','x-bmax-api-token':token}, body:JSON.stringify({action,...payload}), signal:AbortSignal.timeout(20000) });
  const json: any = await response.json().catch(()=>({}));
  if (!response.ok || json?.success !== true) { const e: any = new Error(json?.error || `Hostinger API returned HTTP ${response.status}`); e.status = response.status; throw e; }
  return json.data || {};
}
router.post('/bootstrap', async (req: Request, res: Response) => {
  try {
    const email=String(req.body?.email||'').trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({success:false,error:'Valid account email is required.'});
    const d:any=await phpRequest('license_bootstrap',{email});
    return res.json({success:true,...d, data:d});
  } catch(e:any) { return res.status(Number(e?.status||503)).json({success:false,error:e?.message||'Central license verification failed.'}); }
});
router.post('/activate', async (req: Request, res: Response) => {
  try {
    const licenseKey=String(req.body?.licenseKey||'').trim().toUpperCase();
    if (!licenseKey) return res.status(400).json({success:false,error:'License key is required.'});
    const d:any=await phpRequest('license_verify',{licenseKey});
    const email=String(d.email||'');
    const requestedEmail=String(req.body?.email||'').trim().toLowerCase();
    if (requestedEmail && email.toLowerCase()!==requestedEmail) return res.status(403).json({success:false,error:'This license belongs to a different account.'});
    return res.json({success:true,verified:true,...d,data:d,status:d.status});
  } catch(e:any) { return res.status(Number(e?.status||503)).json({success:false,error:e?.message||'Central license activation failed.'}); }
});
export default router;
