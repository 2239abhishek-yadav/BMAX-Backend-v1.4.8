import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { randomBytes } from 'crypto';
import { db, seedDefaultData } from '../lib/db';
import { validateGSTIN, validateMobile } from '../lib/validators';
import { startTrialAfterCompanyCreation } from '../lib/subscription';

const router = Router();

// Destructive company deletion is a two-step server-authorized operation.
// Tokens are short-lived and bound to a firm, so the UI cannot bypass the confirmation flow.
const deleteChallenges = new Map<string, { firmId: string; expiresAt: number }>();
const DELETE_CHALLENGE_TTL_MS = 5 * 60 * 1000;
function issueDeleteChallenge(firmId: string): string {
  const token = randomBytes(24).toString('hex');
  deleteChallenges.set(token, { firmId, expiresAt: Date.now() + DELETE_CHALLENGE_TTL_MS });
  return token;
}
function consumeDeleteChallenge(token: string, firmId: string): boolean {
  const row = deleteChallenges.get(token);
  deleteChallenges.delete(token);
  return !!row && row.firmId === firmId && row.expiresAt > Date.now();
}

// GET all firms
router.get('/', (req: Request, res: Response) => {
  try {
    const firms = db.prepare('SELECT * FROM firms ORDER BY createdAt DESC').all();
    res.json({ success: true, data: firms });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET firm by id
router.get('/:id', (req: Request, res: Response) => {
  try {
    const firm = db.prepare('SELECT * FROM firms WHERE id = ?').get(req.params.id);
    if (!firm) return res.status(404).json({ error: 'Firm not found' });
    res.json({ success: true, data: firm });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST create firm
router.post('/', async (req: Request, res: Response) => {
  try {
    // Company creation is intentionally independent from transaction entitlements.
    // Users may create additional company profiles even when their plan only licenses
    // a smaller number of companies for transactions. The transaction middleware
    // enforces which companies may post bills/payments/stock movements.
    const now = new Date().toISOString();
    const id = uuidv4();
    let {
      name, legalName, tradeName, phone, alternatePhone, email, alternateEmail, address, city, state, pincode, country,
      gstin, gstType = 'regular', vatRate = 5, pan, tan, currency, financialYear, invoicePrefix, logoUrl, foodLicenseNumber, dlNumber
    } = req.body;

    if (!String(state||'').trim()) return res.status(400).json({ error: 'State is required' });
    gstType = ['regular','composition','vat','none'].includes(String(gstType)) ? String(gstType) : 'regular';
    vatRate = Math.max(0, Math.min(100, Number(vatRate) || 0));
    if (gstType === 'vat' || gstType === 'none') gstin = null;

    if (gstin) {
      const gstinCheck = validateGSTIN(gstin);
      if (!gstinCheck.valid) return res.status(400).json({ error: gstinCheck.error });
      gstin = gstinCheck.value;
    }

    const mobileCheck = validateMobile(phone);
    if (!mobileCheck.valid) return res.status(400).json({ error: mobileCheck.error });
    phone = mobileCheck.value;

    const altMobileCheck = validateMobile(alternatePhone);
    if (!altMobileCheck.valid) return res.status(400).json({ error: altMobileCheck.error });
    alternatePhone = altMobileCheck.value;

    const createFirm = db.transaction(() => {
      db.prepare(`
        INSERT INTO firms (id, name, legalName, tradeName, phone, alternatePhone, email, alternateEmail, address, city, state, pincode, country,
          gstin, gstType, vatRate, pan, tan, currency, financialYear, invoicePrefix, logoUrl, foodLicenseNumber, dlNumber, invoiceNumber, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      `).run(id, name, legalName, tradeName || null, phone, alternatePhone || null, email, alternateEmail || null, address, city, state, pincode, country || 'India',
        gstin, gstType, vatRate, pan, tan, currency || 'INR', financialYear || '2024-25', invoicePrefix || 'INV', logoUrl || null, foodLicenseNumber || null, dlNumber || null, now, now);
    });
    createFirm();

    // Seed default data (units, categories)
    seedDefaultData(id);
    if (gstin) {
      const gstId = uuidv4();
      db.prepare(`INSERT OR IGNORE INTO gst_registrations (id,firmId,gstin,legalName,tradeName,state,address,pincode,isPrimary,isActive,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,1,?,?)`)
        .run(gstId,id,gstin,legalName||null,name||null,state||null,address||null,pincode||null,1,now,now);
    }

    const firm = db.prepare('SELECT * FROM firms WHERE id = ?').get(id);

    // Trial fallback is idempotent. The central Hostinger account API starts the
    // authoritative 15-day trial on first successful login; company creation must
    // never reset an existing trial or license state.
    let subscription:any = null;
    try {
      const email = String(req.headers['x-bmax-user-email'] || req.body?.email || '').trim().toLowerCase() || undefined;
      subscription = await startTrialAfterCompanyCreation(email);
    } catch (trialErr:any) {
      console.error('[BMAX] Trial start after company creation failed:', trialErr?.message || trialErr);
    }

    res.status(201).json({ success: true, data: firm, subscription });
  } catch (err: any) {
    const status = Number(err?.status || 0);
    if (status >= 400 && status < 600) return res.status(status).json({ success:false, error:err?.message || 'Unable to create company.', code:err?.code || undefined, data:err?.data || undefined });
    res.status(500).json({ error: err.message });
  }
});

// PUT update firm
router.put('/:id', (req: Request, res: Response) => {
  try {
    const firmId = String(req.params.id || '');
    const existing = db.prepare('SELECT id FROM firms WHERE id = ?').get(firmId);
    if (!existing) return res.status(404).json({ error: 'Firm not found' });
    const now = new Date().toISOString();
    let {
      name, legalName, tradeName, phone, alternatePhone, email, alternateEmail, address, city, state, pincode, country,
      gstin, gstType = 'regular', vatRate = 5, pan, tan, currency, financialYear, invoicePrefix, logoUrl, foodLicenseNumber, dlNumber
    } = req.body;
    if (!String(state||'').trim()) return res.status(400).json({ error: 'State is required' });
    gstType = ['regular','composition','vat','none'].includes(String(gstType)) ? String(gstType) : 'regular';
    vatRate = Math.max(0, Math.min(100, Number(vatRate) || 0));
    if (gstType === 'vat' || gstType === 'none') gstin = null;

    if (gstin) {
      const gstinCheck = validateGSTIN(gstin);
      if (!gstinCheck.valid) return res.status(400).json({ error: gstinCheck.error });
      gstin = gstinCheck.value;
    } else {
      gstin = null;
    }

    const mobileCheck = validateMobile(phone);
    if (!mobileCheck.valid) return res.status(400).json({ error: mobileCheck.error });
    phone = mobileCheck.value;
    const altMobileCheck = validateMobile(alternatePhone);
    if (!altMobileCheck.valid) return res.status(400).json({ error: altMobileCheck.error });
    alternatePhone = altMobileCheck.value;

    db.prepare(`
      UPDATE firms SET name=?, legalName=?, tradeName=?, phone=?, alternatePhone=?, email=?, alternateEmail=?, address=?, city=?, state=?,
        pincode=?, country=?, gstin=?, gstType=?, vatRate=?, pan=?, tan=?, currency=?, financialYear=?, invoicePrefix=?,
        logoUrl=?, foodLicenseNumber=?, dlNumber=?, updatedAt=? WHERE id=?
    `).run(name, legalName, tradeName || null, phone, alternatePhone || null, email, alternateEmail || null, address, city, state, pincode, country || 'India',
      gstin, gstType, vatRate, pan, tan, currency || 'INR', financialYear || '2024-25', invoicePrefix || 'INV', logoUrl || null, foodLicenseNumber || null, dlNumber || null, now, firmId);

    const firm = db.prepare('SELECT * FROM firms WHERE id = ?').get(firmId);
    res.json({ success: true, data: firm });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST delete challenge
// Step 1: the server issues a short-lived one-time token after the user requests deletion.
router.post('/:id/delete-challenge', (req: Request, res: Response) => {
  try {
    const firmId = String(req.params.id || '');
    const firm = db.prepare('SELECT id, name FROM firms WHERE id = ?').get(firmId) as any;
    if (!firm) return res.status(404).json({ error: 'Firm not found' });
    const token = issueDeleteChallenge(firmId);
    res.json({ success: true, data: { token, firmId, firmName: firm.name, expiresInSeconds: DELETE_CHALLENGE_TTL_MS / 1000 } });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE firm
// Hard rule: a valid server challenge + exact "Sure" + final "Yes" are required.
router.delete('/:id', (req: Request, res: Response) => {
  try {
    const firmId = String(req.params.id || '');
    const confirmationText = String(req.body?.confirmationText || '');
    const finalConfirmation = String(req.body?.finalConfirmation || '');
    const token = String(req.body?.challengeToken || '');
    const firm = db.prepare('SELECT id, name FROM firms WHERE id = ?').get(firmId) as any;
    if (!firm) return res.status(404).json({ error: 'Firm not found' });
    if (confirmationText !== 'Sure') return res.status(400).json({ error: 'Type Sure exactly to authorize company deletion.' });
    if (finalConfirmation !== 'Yes') return res.status(400).json({ error: 'Final confirmation must be Yes.' });
    if (!consumeDeleteChallenge(token, firmId)) return res.status(403).json({ error: 'Delete confirmation expired or invalid. Start the confirmation again.' });

    const deleteFirm = db.transaction(() => {
      // Foreign keys are enabled globally; dependent firm data is removed through ON DELETE CASCADE.
      db.prepare('DELETE FROM firms WHERE id = ?').run(firmId);
    });
    deleteFirm();
    res.json({ success: true, message: 'Firm deleted', data: { id: firmId, name: firm.name } });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
