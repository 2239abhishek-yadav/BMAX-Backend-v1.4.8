import { Router, Request, Response } from 'express';

const router = Router();

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
  const result: any = await response.json().catch(() => ({}));
  if (!response.ok || result?.success !== true) {
    const e: any = new Error(result?.error || `Hostinger backup API returned HTTP ${response.status}`);
    e.status = response.status >= 400 && response.status < 600 ? response.status : 502;
    if (typeof result?.requestId === 'string') e.requestId = result.requestId;
    throw e;
  }
  return result.data;
}

function sessionDetails(req: Request, requireFirm = true) {
  const token = String(req.headers['x-bmax-account-session'] || '').trim();
  const email = String(req.headers['x-bmax-user-email'] || '').trim().toLowerCase();
  const firmId = String(req.headers['x-bmax-firm-id'] || '').trim();
  const firmName = String(req.headers['x-bmax-firm-name'] || '').trim().slice(0,200);
  if (!/^[a-f0-9]{64}$/.test(token) || !/^\S+@\S+\.\S+$/.test(email) || (requireFirm && !/^[a-zA-Z0-9._:-]{1,100}$/.test(firmId))) {
    const e: any = new Error('Please sign in to your B-MAX account again before using cloud backup.');
    e.status = 401; throw e;
  }
  return { accountSessionToken: token, email, firmId, firmName };
}


// Log failures from post-login company/backup calls. Previously these catches
// returned PHP errors to the desktop without any Render log entry.
function reportHostingerFailure(action: string, err: any, res: Response) {
  const status = Number(err?.status || 502);
  console.error('[B-MAX Hostinger account API]', {
    action,
    httpStatus: status,
    requestId: typeof err?.requestId === 'string' ? err.requestId : null,
    error: String(err?.message || 'Hostinger account API request failed').slice(0, 200),
  });
  return res.status(status >= 400 && status < 600 ? status : 502).json({
    success: false,
    error: err?.message || 'Hostinger account API request failed.',
    ...(typeof err?.requestId === 'string' ? { requestId: err.requestId } : {}),
  });
}

router.post('/upload', async (req: Request, res: Response) => {
  try {
    const session = sessionDetails(req);
    if (!Buffer.isBuffer(req.body) || req.body.length < 100) return res.status(400).json({ success:false, error:'A valid SQLite backup file is required.' });
    if (req.body.subarray(0,16).toString('binary') !== 'SQLite format 3\u0000') return res.status(400).json({ success:false, error:'The selected file is not a valid SQLite database backup.' });
    const data = await callHostinger({
      action: 'backup_upload', ...session,
      deviceName: String(req.headers['x-bmax-device-name'] || 'B-MAX desktop').slice(0,120),
      firmName: session.firmName,
      backupBase64: req.body.toString('base64'),
    });
    return res.status(201).json({ success:true, data });
  } catch (err:any) { return reportHostingerFailure('backup_upload', err, res); }
});

router.get('/companies', async (req: Request, res: Response) => {
  try { return res.json({ success:true, data: await callHostinger({ action:'company_list', ...sessionDetails(req, false) }) }); }
  catch (err:any) { return reportHostingerFailure('company_list', err, res); }
});

router.get('/list', async (req: Request, res: Response) => {
  try { return res.json({ success:true, data: await callHostinger({ action:'backup_list', ...sessionDetails(req) }) }); }
  catch (err:any) { return reportHostingerFailure('backup_list', err, res); }
});

router.get('/:backupId/download', async (req: Request, res: Response) => {
  try {
    const session = sessionDetails(req);
    const data:any = await callHostinger({ action:'backup_download', ...session, backupId:String(req.params.backupId || '') });
    const bytes = Buffer.from(String(data.backupBase64 || ''), 'base64');
    if (bytes.length < 100 || bytes.subarray(0,16).toString('binary') !== 'SQLite format 3\u0000') {
      return res.status(502).json({ success:false, error:'Hostinger returned an invalid backup payload.' });
    }
    res.setHeader('Content-Type','application/vnd.sqlite3');
    res.setHeader('Content-Length',String(bytes.length));
    res.setHeader('Content-Disposition',`attachment; filename="BMAX-Cloud-Backup-${String(data.id || req.params.backupId)}.db"`);
    res.setHeader('X-BMAX-Backup-SHA256',String(data.sha256 || ''));
    return res.send(bytes);
  } catch (err:any) { return reportHostingerFailure('backup_download', err, res); }
});

router.delete('/:backupId', async (req: Request, res: Response) => {
  try { return res.json({ success:true, data: await callHostinger({ action:'backup_delete', ...sessionDetails(req), backupId:String(req.params.backupId || '') }) }); }
  catch (err:any) { return reportHostingerFailure('backup_delete', err, res); }
});

export default router;
