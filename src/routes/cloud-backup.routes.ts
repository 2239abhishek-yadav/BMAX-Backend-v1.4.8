import { Router, Request, Response } from 'express';

const router = Router();
const MAX_BACKUP_BYTES = 100 * 1024 * 1024;

async function callHostinger(payload: Record<string, any>) {
  const endpoint = String(process.env.BMAX_PHP_ACCOUNT_API_URL || '').trim();
  const token = String(process.env.BMAX_PHP_ACCOUNT_API_TOKEN || '').trim();
  if (!endpoint || !token || !/^https:\/\//i.test(endpoint)) {
    const e: any = new Error('Hostinger cloud backup is not configured. Set the private BMAX_PHP_ACCOUNT_API_URL and BMAX_PHP_ACCOUNT_API_TOKEN on Render.');
    e.status = 503; throw e;
  }
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bmax-api-token': token },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(120000),
  });
  const responseText = await response.text();
  let result: any = {};
  try { result = responseText ? JSON.parse(responseText) : {}; }
  catch {
    const e: any = new Error(`Hostinger backup API returned a non-JSON response (HTTP ${response.status}).`);
    e.status = response.status >= 400 && response.status < 600 ? response.status : 502;
    e.action = String(payload.action || 'unknown');
    throw e;
  }
  if (!response.ok || result?.success !== true) {
    const e: any = new Error(result?.error || `Hostinger backup API returned HTTP ${response.status}`);
    e.status = response.status >= 400 && response.status < 600 ? response.status : 502;
    if (typeof result?.requestId === 'string') e.requestId = result.requestId;
    e.action = String(result?.action || payload.action || 'unknown');
    e.code = String(result?.errorCode || 'HOSTINGER_BACKUP_API_ERROR');
    throw e;
  }
  return result.data;
}

function sessionDetails(req: Request) {
  const token = String(req.headers['x-bmax-account-session'] || '').trim();
  const email = String(req.headers['x-bmax-user-email'] || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(token) || !/^\S+@\S+\.\S+$/.test(email)) {
    const e: any = new Error('Please sign in to your B-MAX account again before using cloud backup.');
    e.status = 401; throw e;
  }
  return { accountSessionToken: token, email };
}

router.get('/health', async (_req: Request, res: Response) => {
  try {
    const data:any = await callHostinger({ action:'backup_diagnostics' });
    return res.json({ success:true, data });
  } catch (err:any) {
    return res.status(Number(err?.status || 502)).json({ success:false, error:err?.message || 'Unable to check Hostinger backup configuration.', ...(err?.requestId ? { requestId:err.requestId } : {}), ...(err?.action ? { action:err.action } : {}), ...(err?.code ? { code:err.code } : {}) });
  }
});

router.post('/upload', async (req: Request, res: Response) => {
  try {
    const session = sessionDetails(req);
    if (!Buffer.isBuffer(req.body) || req.body.length < 100) return res.status(400).json({ success:false, error:'A valid SQLite backup file is required.' });
    if (req.body.length > MAX_BACKUP_BYTES) return res.status(413).json({ success:false, error:'Cloud backups are limited to 100 MB per file.' });
    if (req.body.subarray(0,16).toString('binary') !== 'SQLite format 3\u0000') return res.status(400).json({ success:false, error:'The selected file is not a valid SQLite database backup.' });
    const data = await callHostinger({
      action: 'backup_upload', ...session,
      deviceName: String(req.headers['x-bmax-device-name'] || 'B-MAX desktop').slice(0,120),
      backupBase64: req.body.toString('base64'),
    });
    return res.status(201).json({ success:true, data });
  } catch (err:any) { return res.status(Number(err?.status || 502)).json({ success:false, error:err?.message || 'Cloud backup upload failed.', ...(err?.requestId ? { requestId:err.requestId } : {}), ...(err?.action ? { action:err.action } : {}), ...(err?.code ? { code:err.code } : {}) }); }
});

router.get('/companies', async (req: Request, res: Response) => {
  try { return res.json({ success:true, data: await callHostinger({ action:'company_list', ...sessionDetails(req) }) }); }
  catch (err:any) { return res.status(Number(err?.status || 502)).json({ success:false, error:err?.message || 'Unable to list companies for this account.', ...(err?.requestId ? { requestId:err.requestId } : {}), ...(err?.action ? { action:err.action } : {}), ...(err?.code ? { code:err.code } : {}) }); }
});

router.get('/list', async (req: Request, res: Response) => {
  try { return res.json({ success:true, data: await callHostinger({ action:'backup_list', ...sessionDetails(req) }) }); }
  catch (err:any) { return res.status(Number(err?.status || 502)).json({ success:false, error:err?.message || 'Unable to list cloud backups.', ...(err?.requestId ? { requestId:err.requestId } : {}), ...(err?.action ? { action:err.action } : {}), ...(err?.code ? { code:err.code } : {}) }); }
});

router.get('/:backupId/download', async (req: Request, res: Response) => {
  try {
    const session = sessionDetails(req);
    const data:any = await callHostinger({ action:'backup_download', ...session, backupId:String(req.params.backupId || '') });
    const bytes = Buffer.from(String(data.backupBase64 || ''), 'base64');
    if (bytes.length < 100 || bytes.length > MAX_BACKUP_BYTES || bytes.subarray(0,16).toString('binary') !== 'SQLite format 3\u0000') {
      return res.status(502).json({ success:false, error:'Hostinger returned an invalid backup payload.' });
    }
    res.setHeader('Content-Type','application/vnd.sqlite3');
    res.setHeader('Content-Length',String(bytes.length));
    res.setHeader('Content-Disposition',`attachment; filename="BMAX-Cloud-Backup-${String(data.id || req.params.backupId)}.db"`);
    res.setHeader('X-BMAX-Backup-SHA256',String(data.sha256 || ''));
    return res.send(bytes);
  } catch (err:any) { return res.status(Number(err?.status || 502)).json({ success:false, error:err?.message || 'Cloud backup download failed.', ...(err?.requestId ? { requestId:err.requestId } : {}), ...(err?.action ? { action:err.action } : {}), ...(err?.code ? { code:err.code } : {}) }); }
});

router.delete('/:backupId', async (req: Request, res: Response) => {
  try { return res.json({ success:true, data: await callHostinger({ action:'backup_delete', ...sessionDetails(req), backupId:String(req.params.backupId || '') }) }); }
  catch (err:any) { return res.status(Number(err?.status || 502)).json({ success:false, error:err?.message || 'Cloud backup delete failed.', ...(err?.requestId ? { requestId:err.requestId } : {}), ...(err?.action ? { action:err.action } : {}), ...(err?.code ? { code:err.code } : {}) }); }
});

export default router;
