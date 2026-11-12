import type { Express, Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';

const SAFE_ERROR = "We couldn't complete this request. Please try again. If the problem continues, contact B-MAX Support.";
const INTERNAL_KEYS = /^(stack|cause|sql|query|file|filepath|path|filename|debug|trace|internal|exception|originalerror|rawerror)$/i;
const INTERNAL_TEXT = /(SQLITE_[A-Z_]+|\bSELECT\b.+\bFROM\b|\bINSERT\s+INTO\b|\bUPDATE\s+.+\bSET\b|\bDELETE\s+FROM\b|\b(node_modules|\.ts:\d+:\d+|\.js:\d+:\d+|at\s+\S+\s*\(|ERR_[A-Z_]+|ECONN[A-Z]+|ENOTFOUND|EACCES|ENOENT|ETIMEDOUT)\b|[A-Za-z]:\\[^\s]+|(?:\/home\/|\/var\/www\/|\/usr\/|\/opt\/|\/mnt\/)[^\s]+)/i;

function hasInternalText(value: string): boolean {
  return INTERNAL_TEXT.test(value) || value.length > 1200;
}

function sanitize(value: any, key = ''): any {
  if (INTERNAL_KEYS.test(key)) return undefined;
  if (typeof value === 'string') {
  const isBase64Field = key.toLowerCase() === 'base64';
  if (isBase64Field && /^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    return value;
  }
  return hasInternalText(value) ? '[redacted]' : value;
}
  if (Array.isArray(value)) return value.map((item) => sanitize(item)).filter((item) => item !== undefined);
  if (value && typeof value === 'object') {
    const out: Record<string, any> = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      const cleaned = sanitize(childValue, childKey);
      if (cleaned !== undefined) out[childKey] = cleaned;
    }
    return out;
  }
  return value;
}

/** Install before application routes. Never serialize internal 5xx details to clients. */
export function installSafeErrorResponses(app: Express): void {
  app.disable('x-powered-by');
  app.use((req: Request, res: Response, next: NextFunction) => {
    const referenceId = randomUUID();
    res.locals.bmaxReferenceId = referenceId;
    res.setHeader('X-BMAX-Reference', referenceId);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');

    const originalJson = res.json.bind(res);
    res.json = ((body?: any) => {
      if (res.statusCode >= 500) {
        return originalJson({
          success: false,
          error: SAFE_ERROR,
          code: 'INTERNAL_ERROR',
          referenceId,
        });
      }
      return originalJson(sanitize(body));
    }) as Response['json'];
    next();
  });
}

export function safeErrorHandler(err: any, req: Request, res: Response, _next: NextFunction): void {
  const referenceId = String(res.locals.bmaxReferenceId || randomUUID());
  const rawStatus = Number(err?.status || err?.statusCode || 500);
  const status = rawStatus >= 400 && rawStatus < 500 ? rawStatus : 500;
  // Detailed diagnostics stay in server-side logs only. Never return stack, path, SQL or raw exception text.
  console.error(`[B-MAX:${referenceId}] request failed`, {
    method: req.method,
    route: req.path,
    status,
    name: String(err?.name || 'Error').slice(0, 100),
    message: String(err?.message || 'Unknown error').slice(0, 2000),
    stack: String(err?.stack || '').slice(0, 8000),
  });
  if (res.headersSent) return;
  if (status >= 500) {
    res.status(500).json({ success: false, error: SAFE_ERROR, code: 'INTERNAL_ERROR', referenceId });
    return;
  }
  const publicMessage = typeof err?.publicMessage === 'string' && !hasInternalText(err.publicMessage)
    ? err.publicMessage
    : 'The request could not be completed. Please check the information and try again.';
  res.status(status).json({ success: false, error: publicMessage, code: 'REQUEST_REJECTED', referenceId });
}
