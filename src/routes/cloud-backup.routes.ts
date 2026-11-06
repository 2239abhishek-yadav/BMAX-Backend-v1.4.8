import { Readable } from 'node:stream';
import { Router, Request, Response } from 'express';

const router = Router();

function hostingerEndpointAndToken() {
  const endpoint = String(process.env.BMAX_PHP_ACCOUNT_API_URL || '').trim();
  const token = String(process.env.BMAX_PHP_ACCOUNT_API_TOKEN || '').trim();
  if (!endpoint || !token || !/^https:\/\//i.test(endpoint)) {
    const e: any = new Error('Hostinger cloud backup is not configured. Set the private BMAX_PHP_ACCOUNT_API_URL and BMAX_PHP_ACCOUNT_API_TOKEN on Render.');
    e.status = 503; throw e;
  }
  return { endpoint, token };
}

async function callHostinger(payload: Record<string, any>) {
  const { endpoint, token } = hostingerEndpointAndToken();
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

// Forward the incoming SQLite request as a stream. This deliberately avoids
// Buffer.toString('base64') + JSON.stringify(), which creates multiple large
// heap allocations and caused Render's Node.js process to run out of memory.
async function callHostingerBackupStream(req: Request, session: ReturnType<typeof sessionDetails>, backupType: string, deviceName: string) {
  const { endpoint, token } = hostingerEndpointAndToken();
  const streamRequestInit = {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      'x-bmax-api-token': token,
      'x-bmax-backup-stream': '1',
      'x-bmax-account-session': session.accountSessionToken,
      'x-bmax-user-email': session.email,
      'x-bmax-firm-id': session.firmId,
      'x-bmax-backup-type': backupType,
      'x-bmax-device-name': deviceName,
      ...(req.headers['content-length'] ? { 'content-length': String(req.headers['content-length']) } : {}),
    },
    // Node 22 fetch supports streaming AsyncIterable bodies with duplex='half'.
    body: req as any,
    duplex: 'half',
    signal: AbortSignal.timeout(300000),
  } as RequestInit & { duplex: 'half' };
  const response = await fetch(endpoint, streamRequestInit);
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
    if (!req.is('application/x-bmax-cloud-backup')) return res.status(415).json({ success:false, error:'Cloud backup upload must use the binary backup content type.' });
    const contentLength = Number(req.headers['content-length'] || 0);
    if (contentLength > 0 && contentLength < 100) return res.status(400).json({ success:false, error:'A valid SQLite backup file is required.' });
    const backupType = String(req.headers['x-bmax-cloud-sync'] || '') === '1' ? 'autosync' : 'manual';
    const deviceName = String(req.headers['x-bmax-device-name'] || 'B-MAX desktop').slice(0,120);
    const data = await callHostingerBackupStream(req, session, backupType, deviceName);
    return res.status(201).json({ success:true, data });
  } catch (err:any) { return reportHostingerFailure('backup_upload', err, res); }
});

router.delete('/companies/:firmId', async (req: Request, res: Response) => {
  try {
    const session = sessionDetails(req, false);
    const firmId = String(req.params.firmId || '').trim();
    if (!/^[a-zA-Z0-9._:-]{1,100}$/.test(firmId)) return res.status(400).json({success:false,error:'A valid company ID is required.'});
    const data = await callHostinger({ action:'company_delete', ...session, firmId });
    return res.json({success:true,data});
  } catch (err:any) { return reportHostingerFailure('company_delete', err, res); }
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
    const backupId = String(req.params.backupId || '');
    if (!/^[a-f0-9]{32}$/.test(backupId)) return res.status(400).json({ success:false, error:'Valid backup ID is required.' });
    const { endpoint, token } = hostingerEndpointAndToken();
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type':'application/json', 'x-bmax-api-token':token, 'x-bmax-backup-download-stream':'1' },
      body: JSON.stringify({ action:'backup_download', accountSessionToken:session.accountSessionToken, email:session.email, firmId:session.firmId, backupId }),
      signal: AbortSignal.timeout(300000),
    });
    if (!response.ok) {
      const detail:any = await response.json().catch(()=>({}));
      const err:any = new Error(detail?.error || `Hostinger backup download returned HTTP ${response.status}`);
      err.status = response.status;
      if (typeof detail?.requestId === 'string') err.requestId = detail.requestId;
      throw err;
    }
    if (!response.body || !String(response.headers.get('content-type')||'').includes('application/vnd.sqlite3')) {
      throw new Error('Hostinger returned an invalid backup download response.');
    }
    const size = Number(response.headers.get('content-length') || 0);
    if (size && size < 100) throw new Error('Downloaded company backup is too small to be a valid SQLite database.');
    res.status(200);
    res.setHeader('Content-Type','application/vnd.sqlite3');
    if (size) res.setHeader('Content-Length',String(size));
    res.setHeader('Content-Disposition',`attachment; filename=\"BMAX-Cloud-Backup-${backupId}.db\"`);
    res.setHeader('X-BMAX-Backup-SHA256',String(response.headers.get('x-bmax-backup-sha256')||''));
    res.setHeader('X-BMAX-Backup-ID',backupId);
    Readable.fromWeb(response.body as any).pipe(res);
  } catch (err:any) {
    if (!res.headersSent) return reportHostingerFailure('backup_download', err, res);
    res.destroy(err);
  }
});

router.delete('/:backupId', async (req: Request, res: Response) => {
  try { return res.json({ success:true, data: await callHostinger({ action:'backup_delete', ...sessionDetails(req), backupId:String(req.params.backupId || '') }) }); }
  catch (err:any) { return reportHostingerFailure('backup_delete', err, res); }
});

export default router;
