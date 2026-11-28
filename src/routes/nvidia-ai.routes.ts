import { Router, Request, Response } from 'express';

const router = Router();
const EMAIL_RE = /^\S+@\S+\.\S+$/;
const FIRM_RE = /^[a-zA-Z0-9._:-]{1,100}$/;
const TOKEN_RE = /^[a-f0-9]{64}$/i;

function accountContext(req: Request) {
  const email = String(req.headers['x-bmax-user-email'] || '').trim().toLowerCase();
  const token = String(req.headers['x-bmax-account-session'] || '').trim();
  const firmId = String(req.headers['x-bmax-firm-id'] || req.body?.firmId || '').trim();
  if (!EMAIL_RE.test(email) || !TOKEN_RE.test(token) || !FIRM_RE.test(firmId)) {
    const error: any = new Error('Please sign in again before using XERO AI or OCR.'); error.status = 401; throw error;
  }
  return { email, token, firmId };
}

async function verifyAccountFirm(ctx: ReturnType<typeof accountContext>) {
  const endpoint = String(process.env.BMAX_PHP_ACCOUNT_API_URL || '').trim();
  const apiToken = String(process.env.BMAX_PHP_ACCOUNT_API_TOKEN || '').trim();
  if (!endpoint || !apiToken || !/^https:\/\//i.test(endpoint)) {
    const error: any = new Error('Central account verification is not configured on the B-MAX server.'); error.status = 503; throw error;
  }
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bmax-api-token': apiToken },
    body: JSON.stringify({ action: 'company_list', email: ctx.email, accountSessionToken: ctx.token }),
    signal: AbortSignal.timeout(20000),
  });
  const payload: any = await response.json().catch(() => ({}));
  if (!response.ok || payload?.success !== true) {
    const error: any = new Error('Your B-MAX account session could not be verified. Please sign in again.'); error.status = response.status === 401 ? 401 : 503; throw error;
  }
  const companies = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.data?.companies) ? payload.data.companies : [];
  const ownsFirm = companies.some((company: any) => String(company?.firmId || company?.localFirmId || company?.id || '').trim() === ctx.firmId);
  if (!ownsFirm) { const error: any = new Error('This firm is not registered under the signed-in B-MAX account.'); error.status = 403; throw error; }
}

function safeError(err: any, res: Response) {
  const status = Number(err?.status);
  const code = Number.isInteger(status) && status >= 400 && status < 600 ? status : 502;
  return res.status(code).json({ success: false, error: code === 401 || code === 403 ? String(err?.message || 'Account verification failed.') : code === 503 ? String(err?.message || 'NVIDIA service is not configured.') : 'NVIDIA request failed. Please retry.', code: code === 401 ? 'ACCOUNT_SESSION_INVALID' : code === 403 ? 'FIRM_ACCESS_DENIED' : code === 503 ? 'AI_SERVICE_UNAVAILABLE' : 'NVIDIA_REQUEST_FAILED' });
}

function nvidiaKey() {
  const key = String(process.env.NVIDIA_API_KEY || '').trim();
  if (!key) { const error: any = new Error('NVIDIA_API_KEY is not configured on Render.'); error.status = 503; throw error; }
  return key;
}

router.get('/status', (_req, res) => {
  res.json({ success: true, data: { provider: 'NVIDIA', chatConfigured: Boolean(process.env.NVIDIA_API_KEY && process.env.NVIDIA_CHAT_MODEL), ocrConfigured: Boolean(process.env.NVIDIA_API_KEY && process.env.NVIDIA_OCR_URL), apiKeyStoredOnServer: true } });
});

router.post('/chat', async (req: Request, res: Response) => {
  try {
    const ctx = accountContext(req);
    await verifyAccountFirm(ctx);
    const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
    if (!messages.length || messages.length > 16) return res.status(400).json({ success: false, error: 'A valid chat message list is required.' });
    const clean = messages.map((m: any) => ({ role: ['system','user','assistant'].includes(m?.role) ? m.role : 'user', content: String(m?.content || '').slice(0, 12000) }));
    if (clean.some((m: any) => !m.content)) return res.status(400).json({ success: false, error: 'Chat messages cannot be empty.' });
    const base = String(process.env.NVIDIA_CHAT_BASE_URL || 'https://integrate.api.nvidia.com/v1').trim().replace(/\/$/, '');
    const model = String(process.env.NVIDIA_CHAT_MODEL || '').trim();
    if (!model) { const error: any = new Error('NVIDIA_CHAT_MODEL is not configured on Render.'); error.status = 503; throw error; }
    const upstream = await fetch(`${base}/chat/completions`, {
      method: 'POST', headers: { authorization: `Bearer ${nvidiaKey()}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ model, messages: clean, temperature: 0.2, max_tokens: Math.max(64, Math.min(1200, Number(req.body?.max_tokens) || 600)), stream: false }),
      signal: AbortSignal.timeout(75000),
    });
    const data: any = await upstream.json().catch(() => ({}));
    if (!upstream.ok) { console.error('[NVIDIA chat] upstream HTTP', upstream.status, String(data?.detail || data?.message || '').slice(0, 180)); return res.status(upstream.status === 429 ? 429 : 502).json({ success: false, error: upstream.status === 429 ? 'NVIDIA rate limit reached. Please wait and retry.' : 'NVIDIA Chat API could not complete the request.', code: upstream.status === 429 ? 'NVIDIA_RATE_LIMIT' : 'NVIDIA_CHAT_ERROR' }); }
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) return res.status(502).json({ success: false, error: 'NVIDIA Chat API returned an empty response.' });
    return res.json({ success: true, data: { content: content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim(), model: data.model || model } });
  } catch (err: any) { return safeError(err, res); }
});

router.post('/ocr', async (req: Request, res: Response) => {
  try {
    const ctx = accountContext(req);
    await verifyAccountFirm(ctx);
    const images = Array.isArray(req.body?.images) ? req.body.images : [];
    if (!images.length || images.length > 20) return res.status(400).json({ success: false, error: 'Upload between 1 and 20 invoice page images per request.' });
    for (const image of images) {
      const url = String(image?.url || '');
      if (!/^data:image\/(png|jpeg|jpg);base64,[A-Za-z0-9+/=]+$/i.test(url) || url.length > 181000) return res.status(413).json({ success: false, error: 'Each OCR page must be a JPEG/PNG image within the NVIDIA inline-image size limit.' });
    }
    const endpoint = String(process.env.NVIDIA_OCR_URL || 'https://ai.api.nvidia.com/v1/cv/nvidia/nemotron-ocr-v2').trim();
    const upstream = await fetch(endpoint, {
      method: 'POST', headers: { authorization: `Bearer ${nvidiaKey()}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ input: images.map((image: any) => ({ type: 'image_url', url: String(image.url) })), merge_levels: images.map(() => 'word') }),
      signal: AbortSignal.timeout(90000),
    });
    const data: any = await upstream.json().catch(() => ({}));
    if (!upstream.ok) { console.error('[NVIDIA OCR] upstream HTTP', upstream.status, String(data?.detail || data?.message || '').slice(0, 180)); return res.status(upstream.status === 429 ? 429 : 502).json({ success: false, error: upstream.status === 429 ? 'NVIDIA OCR rate limit reached. Please wait and retry.' : 'NVIDIA OCR could not process this invoice. Try a clearer image.', code: upstream.status === 429 ? 'NVIDIA_RATE_LIMIT' : 'NVIDIA_OCR_ERROR' }); }
    return res.json({ success: true, data });
  } catch (err: any) { return safeError(err, res); }
});

export default router;
