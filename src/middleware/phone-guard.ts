import { Request, Response, NextFunction } from 'express';
import { validateMobile } from '../lib/validators';

const PHONE_KEY = /(phone|mobile|telephone|whatsapp)(number|no)?$/i;

function walk(value: any, path = ''): string | null {
  if (!value || typeof value !== 'object') return null;
  for (const key of Object.keys(value)) {
    const nextPath = path ? `${path}.${key}` : key;
    const v = value[key];
    if (PHONE_KEY.test(key) && (typeof v === 'string' || typeof v === 'number')) {
      if (String(v).trim() === '') continue;
      const check = validateMobile(v);
      if (!check.valid) return `${nextPath}: ${check.error}`;
      value[key] = check.value || '';
      continue;
    }
    if (v && typeof v === 'object') {
      const error = walk(v, nextPath);
      if (error) return error;
    }
  }
  return null;
}

export function phoneGuard(req: Request, res: Response, next: NextFunction) {
  const error = walk(req.body);
  if (error) return res.status(400).json({ success: false, error: `Invalid phone number. ${error}` });
  next();
}
