import { Router, Request, Response } from 'express';
import { db } from '../lib/db';
import { getSubscriptionAccess } from '../lib/subscription';

const router = Router();

router.get('/', (_req: Request, res: Response) => {
  try {
    const email = String(_req.query.email || '').trim().toLowerCase();
    const user = email ? db.prepare('SELECT id,name,email,phone,isActive,createdAt,updatedAt FROM users WHERE lower(email)=? LIMIT 1').get(email) as any : null;
    const subscription = getSubscriptionAccess().state;
    res.json({ success: true, data: { user: user || null, subscription, licenseNumber: subscription?.licenseKey || null } });
  } catch (err:any) { res.status(500).json({ error: err.message }); }
});

export default router;
