import { Router, Request, Response } from 'express';
import { db } from '../lib/db';
import { getSubscriptionAccess } from '../lib/subscription';

const router = Router();

router.get('/', (_req: Request, res: Response) => {
  try {
    // Render's app-level accessControl validates x-bmax-account-session with
    // Hostinger before this route. Bind the requested profile to that verified
    // account context; never permit email-only customer profile enumeration.
    const authenticatedEmail = String(_req.headers['x-bmax-user-email'] || '').trim().toLowerCase();
    const requestedEmail = String(_req.query.email || '').trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(authenticatedEmail) || !requestedEmail || requestedEmail !== authenticatedEmail) {
      return res.status(403).json({ success:false, error:'You can only view the profile for the signed-in account.' });
    }
    const email = authenticatedEmail;
    const user = email ? db.prepare('SELECT id,name,email,phone,isActive,createdAt,updatedAt FROM users WHERE lower(email)=? LIMIT 1').get(email) as any : null;
    const subscription = getSubscriptionAccess().state;
    res.json({ success: true, data: { user: user || null, subscription, licenseNumber: subscription?.licenseKey || null } });
  } catch (err:any) { res.status(500).json({ error: err.message }); }
});

export default router;
