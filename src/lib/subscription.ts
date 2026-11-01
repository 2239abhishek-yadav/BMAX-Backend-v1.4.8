import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { db } from './db';
import { verifyEmbeddedActivationCode } from './activation-codes';
import { verifyEmbeddedAddonCode } from './addon-codes';
import { PLAN_PRICING } from './plan-entitlements';

export type SubscriptionStatus = 'trial' | 'active' | 'expired' | 'inactive' | 'suspended' | 'revoked';

export interface SubscriptionState {
  installationId: string;
  deviceId: string;
  email?: string | null;
  customerId?: string | null;
  licenseKey?: string | null;
  planCode?: string | null;
  planName?: string | null;
  durationCode?: string | null;
  status: SubscriptionStatus;
  startsAt?: string | null;
  activatedAt?: string | null;
  expiresAt?: string | null;
  isLifetime: boolean;
  maxFirms?: number | null;
  maxUsers?: number | null;
  additionalUsers?: number | null;
  additionalFirms?: number | null;
  additionalGst?: number | null;
  lastVerifiedAt?: string | null;
  cachedUntil?: string | null;
  activationId?: string | null;
  serverVerified?: boolean;
}

const LICENSE_SERVER_URL = String(
  process.env.BMAX_LICENSE_SERVER_URL || 'https://bmax-backend-v1-4-8.onrender.com'
).replace(/\/$/, '');
// Current B-MAX desktop distribution uses the embedded backend registry.
// Central licensing is deliberately disabled in this offline-code build so a
// stale developer/host environment can never divert activation away from the
// 90-code registry. A future server build should use a separate source/config.
const CENTRAL_SERVER_ENV_REQUESTED = process.env.BMAX_USE_CENTRAL_LICENSE_SERVER !== '0' && !!LICENSE_SERVER_URL;
const USE_CENTRAL_LICENSE_SERVER = CENTRAL_SERVER_ENV_REQUESTED;
const OFFLINE_GRACE_HOURS = Math.max(0, Number(process.env.LICENSE_OFFLINE_GRACE_HOURS || 72));
const TRIAL_DAYS = 15;

function maskLicenseKey(value: unknown): string | null {
  const raw = String(value || '').trim().toUpperCase();
  if (!raw) return null;
  // Never persist or expose any portion of the real activation code.
  // The activation secret is used only for the one-time backend verification.
  return 'PROTECTED';
}


function dbDir() {
  return process.env.DB_PATH || path.join(process.cwd(), 'data');
}

function installationFile() {
  return path.join(dbDir(), 'bmax-installation.json');
}

function ensureStateTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS subscription_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      installationId TEXT NOT NULL,
      deviceId TEXT NOT NULL,
      email TEXT,
      customerId TEXT,
      licenseKey TEXT,
      planCode TEXT,
      planName TEXT,
      durationCode TEXT,
      status TEXT NOT NULL DEFAULT 'trial',
      startsAt TEXT,
      activatedAt TEXT,
      expiresAt TEXT,
      isLifetime INTEGER DEFAULT 0,
      maxFirms INTEGER,
      maxUsers INTEGER,
      additionalUsers INTEGER DEFAULT 0,
      additionalFirms INTEGER DEFAULT 0,
      additionalGst INTEGER DEFAULT 0,
      lastVerifiedAt TEXT,
      cachedUntil TEXT,
      activationId TEXT,
      serverVerified INTEGER DEFAULT 0,
      updatedAt TEXT NOT NULL
    );
  `);

  // Forward-compatible entitlement columns for add-ons. Existing databases are
  // migrated in place without losing subscription state.
  const columns = db.prepare('PRAGMA table_info(subscription_state)').all() as any[];
  const has = (name: string) => columns.some((c:any) => String(c.name) === name);
  if (!has('activatedAt')) db.exec('ALTER TABLE subscription_state ADD COLUMN activatedAt TEXT');
  if (!has('additionalUsers')) db.exec('ALTER TABLE subscription_state ADD COLUMN additionalUsers INTEGER DEFAULT 0');
  if (!has('additionalFirms')) db.exec('ALTER TABLE subscription_state ADD COLUMN additionalFirms INTEGER DEFAULT 0');
  if (!has('additionalGst')) db.exec('ALTER TABLE subscription_state ADD COLUMN additionalGst INTEGER DEFAULT 0');

  // Critical migration for databases created by older B-MAX builds.
  // Those builds could have subscription_state without activationId/serverVerified,
  // while current activation and add-on flows persist/read both fields.
  // Never assume CREATE TABLE IF NOT EXISTS upgrades an existing table.
  if (!has('activationId')) db.exec('ALTER TABLE subscription_state ADD COLUMN activationId TEXT');
  if (!has('serverVerified')) db.exec('ALTER TABLE subscription_state ADD COLUMN serverVerified INTEGER DEFAULT 0');
  if (!has('cachedUntil')) db.exec('ALTER TABLE subscription_state ADD COLUMN cachedUntil TEXT');
  if (!has('lastVerifiedAt')) db.exec('ALTER TABLE subscription_state ADD COLUMN lastVerifiedAt TEXT');

  // Security migration: older builds persisted the full activation code locally.
  // Replace any legacy plaintext value with a masked display value immediately.
  try {
    const row: any = db.prepare('SELECT licenseKey FROM subscription_state WHERE id = 1').get();
    const existing = String(row?.licenseKey || '').trim();
    if (existing && !existing.includes('••••') && existing.length >= 9) {
      db.prepare('UPDATE subscription_state SET licenseKey=?, updatedAt=? WHERE id=1')
        .run(maskLicenseKey(existing), new Date().toISOString());
    }
  } catch (_) {}
}

function readOrCreateInstallationId(): string {
  const file = installationFile();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed?.installationId) return String(parsed.installationId);
  } catch (_) {}

  fs.mkdirSync(path.dirname(file), { recursive: true });
  const installationId = crypto.randomUUID();
  fs.writeFileSync(file, JSON.stringify({ installationId, createdAt: new Date().toISOString() }, null, 2), 'utf8');
  return installationId;
}

function windowsMachineGuid(): string {
  if (process.platform !== 'win32') return '';
  try {
    const { execFileSync } = require('child_process');
    const output = execFileSync('reg', [
      'QUERY',
      'HKLM\\SOFTWARE\\Microsoft\\Cryptography',
      '/v',
      'MachineGuid',
    ], { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const match = String(output).match(/MachineGuid\s+REG_SZ\s+(.+)/i);
    return match?.[1]?.trim() || '';
  } catch (_) {
    return '';
  }
}

function linuxMachineId(): string {
  for (const file of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
    try {
      const value = fs.readFileSync(file, 'utf8').trim();
      if (value) return value;
    } catch (_) {}
  }
  return '';
}

export function getDeviceId(): string {
  const material = [
    windowsMachineGuid(),
    linuxMachineId(),
    os.hostname(),
    os.platform(),
    os.arch(),
    process.env.ComputerName || '',
    process.env.SystemDrive || '',
  ].filter(Boolean).join('|');

  return crypto.createHash('sha256').update(material).digest('hex');
}

export function getInstallationId(): string {
  return readOrCreateInstallationId();
}

function ensureLocalState(): void {
  ensureStateTable();
  const existing = db.prepare('SELECT id FROM subscription_state WHERE id = 1').get();
  if (!existing) {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO subscription_state
      (id, installationId, deviceId, status, isLifetime, updatedAt)
      VALUES (1, ?, ?, 'inactive', 0, ?)
    `).run(getInstallationId(), getDeviceId(), now);
  }
}

export function getLocalSubscriptionState(): SubscriptionState | null {
  ensureLocalState();
  const row: any = db.prepare('SELECT * FROM subscription_state WHERE id = 1').get();
  if (!row) return null;
  const additionalUsers = Number(row.additionalUsers || 0);
  const additionalFirms = Number(row.additionalFirms || 0);
  const additionalGst = Number(row.additionalGst || 0);
  let storedPlanCode = String(row.planCode || '').toUpperCase();
  const storedPlanName = String(row.planName || '').trim();
  const inferPlanCode = () => {
    if (storedPlanCode === 'STARTER' || storedPlanCode === 'BUSINESS' || storedPlanCode === 'PROFESSIONAL') return storedPlanCode;
    const name = storedPlanName.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (name.startsWith('STARTER')) return 'STARTER';
    if (name.startsWith('BUSINESS')) return 'BUSINESS';
    if (name.startsWith('PROFESSIONAL')) return 'PROFESSIONAL';
    // Legacy builds used a generic paid label. Infer the base tier from the
    // persisted base limits while keeping add-on counts separate.
    const firms = Number(row.maxFirms || 0) - additionalFirms;
    const users = Number(row.maxUsers || 0) - additionalUsers;
    if (firms <= 1 || users <= 1) return 'STARTER';
    if (firms <= 2 || users <= 3) return 'BUSINESS';
    if (firms >= 3 || users >= 5) return 'PROFESSIONAL';
    return '';
  };
  const inferredPlanCode = inferPlanCode();
  if (inferredPlanCode && inferredPlanCode !== storedPlanCode && row.status === 'active') {
    storedPlanCode = inferredPlanCode;
    try {
      const inferredName = inferredPlanCode === 'STARTER' ? 'Starter' : inferredPlanCode === 'BUSINESS' ? 'Business' : 'Professional';
      db.prepare('UPDATE subscription_state SET planCode=?, planName=?, updatedAt=? WHERE id=1')
        .run(inferredPlanCode, inferredName, new Date().toISOString());
    } catch (_) {}
  }
  const storedBase = storedPlanCode === 'STARTER' ? { firms: 1, users: 2 } : storedPlanCode === 'BUSINESS' ? { firms: 2, users: 5 } : storedPlanCode === 'PROFESSIONAL' ? { firms: 3, users: 5 } : null;
  return {
    installationId: row.installationId,
    deviceId: row.deviceId,
    email: row.email,
    customerId: row.customerId,
    licenseKey: maskLicenseKey(row.licenseKey),
    // IMPORTANT: return the normalized/inferred value, not row.planCode.
    // Legacy paid installs may need one request to migrate their planCode;
    // returning the stale row value here caused the renderer to hide modules
    // until a manual refresh.
    planCode: storedPlanCode,
    planName: storedPlanCode === 'STARTER' ? 'Starter' : storedPlanCode === 'BUSINESS' ? 'Business' : storedPlanCode === 'PROFESSIONAL' ? 'Professional' : row.planName,
    durationCode: row.durationCode,
    status: row.status,
    startsAt: row.startsAt,
    activatedAt: row.activatedAt || row.startsAt || null,
    expiresAt: row.expiresAt,
    isLifetime: !!row.isLifetime,
    maxFirms: storedBase ? storedBase.firms + additionalFirms : row.maxFirms,
    maxUsers: storedBase ? storedBase.users + additionalUsers : row.maxUsers,
    additionalUsers,
    additionalFirms,
    lastVerifiedAt: row.lastVerifiedAt,
    cachedUntil: row.cachedUntil,
    activationId: row.activationId || null,
    serverVerified: !!row.serverVerified,
  };
}

function saveState(data: Partial<SubscriptionState>) {
  ensureLocalState();
  const current = getLocalSubscriptionState()!;
  const next: SubscriptionState = {
    ...current,
    ...data,
    installationId: current.installationId,
    deviceId: current.deviceId,
  };
  db.prepare(`
    UPDATE subscription_state SET
      installationId=?, deviceId=?, email=?, customerId=?, licenseKey=?,
      planCode=?, planName=?, durationCode=?, status=?, startsAt=?, activatedAt=?, expiresAt=?,
      isLifetime=?, maxFirms=?, maxUsers=?, additionalUsers=?, additionalFirms=?, additionalGst=?, lastVerifiedAt=?, cachedUntil=?, activationId=?, serverVerified=?, updatedAt=?
    WHERE id=1
  `).run(
    next.installationId,
    next.deviceId,
    next.email ?? null,
    next.customerId ?? null,
    maskLicenseKey(next.licenseKey),
    next.planCode ?? null,
    next.planName ?? null,
    next.durationCode ?? null,
    next.status,
    next.startsAt ?? null,
    next.activatedAt ?? next.startsAt ?? null,
    next.expiresAt ?? null,
    next.isLifetime ? 1 : 0,
    next.maxFirms ?? null,
    next.maxUsers ?? null,
    Number(next.additionalUsers || 0),
    Number(next.additionalFirms || 0),
    Number(next.additionalGst || 0),
    next.lastVerifiedAt ?? null,
    next.cachedUntil ?? null,
    next.activationId ?? null,
    next.serverVerified ? 1 : 0,
    new Date().toISOString(),
  );
}

function normalizeRemote(payload: any, email?: string): SubscriptionState {
  const remoteStatus = String(payload?.status || '').trim().toLowerCase();
  const status: SubscriptionStatus = remoteStatus === 'active' ? 'active' : remoteStatus === 'trial' ? 'trial' : remoteStatus === 'expired' ? 'expired' : remoteStatus === 'suspended' ? 'suspended' : remoteStatus === 'revoked' ? 'revoked' : 'inactive';
  const verifiedAt = new Date();
  const cachedUntil = status === 'active'
    ? new Date(verifiedAt.getTime() + OFFLINE_GRACE_HOURS * 3600_000).toISOString()
    : verifiedAt.toISOString();

  return {
    installationId: String(payload.installationId || getInstallationId()),
    deviceId: getDeviceId(),
    email: email ?? payload.email ?? null,
    customerId: payload.customerId ? String(payload.customerId) : null,
    licenseKey: payload.licenseKey || null,
    planCode: payload.planCode || null,
    planName: payload.planName || null,
    durationCode: payload.durationCode || null,
    status,
    startsAt: payload.startsAt || null,
    activatedAt: payload.activatedAt || payload.startsAt || null,
    expiresAt: payload.expiresAt || null,
    isLifetime: !!payload.isLifetime,
    maxFirms: Number.isFinite(Number(payload.maxFirms)) ? Number(payload.maxFirms) : null,
    maxUsers: Number.isFinite(Number(payload.maxUsers)) ? Number(payload.maxUsers) : null,
    additionalUsers: Number.isFinite(Number(payload.additionalUsers)) ? Number(payload.additionalUsers) : 0,
    additionalFirms: Number.isFinite(Number(payload.additionalFirms)) ? Number(payload.additionalFirms) : 0,
    additionalGst: Number.isFinite(Number(payload.additionalGst)) ? Number(payload.additionalGst) : 0,
    lastVerifiedAt: verifiedAt.toISOString(),
    cachedUntil,
    activationId: payload.activationId ? String(payload.activationId) : null,
    serverVerified: true,
  };
}

async function callLicenseServer(pathname: string, body: any): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(`${LICENSE_SERVER_URL}${pathname}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let payload: any = {};
    try { payload = text ? JSON.parse(text) : {}; } catch (_) { payload = { error: 'License server returned an invalid response.' }; }
    if (!response.ok || payload.success === false) {
      const error: any = new Error(payload.error || `License server request failed (${response.status})`);
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

export async function registerEmailAccount(email: string): Promise<any> {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedEmail || !normalizedEmail.includes('@')) {
    throw Object.assign(new Error('A valid email address is required.'), { status: 400 });
  }

  ensureLocalState();
  const local = getLocalSubscriptionState()!;

  // LOGIN/ACCOUNT REGISTRATION MUST NEVER START OR RESET A TRIAL.
  // The central trial begins on the first successful account login and lasts 15 days.
  // This keeps the login page completely independent from subscription expiry.
  if (local.email && local.email !== normalizedEmail) {
    throw Object.assign(new Error('This installation is already registered with another account.'), { status: 409 });
  }
  if (!local.email) saveState({ email: normalizedEmail });
  const state = getLocalSubscriptionState()!;
  return {
    success: true,
    email: normalizedEmail,
    customerId: state.customerId || null,
    subscription: state,
  };
}

export async function startTrialAfterCompanyCreation(email?: string): Promise<SubscriptionState> {
  ensureLocalState();
  const local = getLocalSubscriptionState()!;
  const normalizedEmail = String(email || local.email || '').trim().toLowerCase() || undefined;

  // Never restart/reset an existing trial, active plan, or expired subscription.
  if (local.status !== 'inactive') return local;

  if (!USE_CENTRAL_LICENSE_SERVER) {
    const startsAt = new Date();
    const expiresAt = new Date(startsAt.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000);
    saveState({
      email: normalizedEmail || null,
      status: 'trial',
      startsAt: startsAt.toISOString(),
      activatedAt: startsAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      isLifetime: false,
      planCode: 'TRIAL',
      planName: `B-MAX ${TRIAL_DAYS}-Day Free Trial`,
      durationCode: `${TRIAL_DAYS}D`,
      maxFirms: null,
      maxUsers: null,
      lastVerifiedAt: startsAt.toISOString(),
      cachedUntil: expiresAt.toISOString(),
    });
    return getLocalSubscriptionState()!;
  }

  const payload = await callLicenseServer('/api/license/bootstrap', {
    installationId: local.installationId,
    deviceFingerprint: local.deviceId,
    email: normalizedEmail,
    signup: true,
    trialDaysRequested: TRIAL_DAYS,
    trialStart: 'first_login',
  });
  const state = normalizeRemote(payload, normalizedEmail);
  saveState(state);
  return getLocalSubscriptionState()!;
}


export async function ensureSubscription(email?: string): Promise<SubscriptionState> {
  ensureLocalState();
  const local = getLocalSubscriptionState()!;
  const now = new Date();

  // Current desktop builds use the embedded backend activation registry unless
  // central licensing is explicitly enabled with BMAX_USE_CENTRAL_LICENSE_SERVER=1.
  if (!USE_CENTRAL_LICENSE_SERVER) {
    // Migrate an already-started legacy 7-day trial to the 15-day policy,
    // measured from the ORIGINAL start timestamp. Never restart the clock.
    if (local.status === 'trial' && local.startsAt) {
      const startedAt = new Date(local.startsAt);
      const currentExpiry = local.expiresAt ? new Date(local.expiresAt) : null;
      if (Number.isFinite(startedAt.getTime())) {
        const policyExpiry = new Date(startedAt.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000);
        if (policyExpiry > now && (!currentExpiry || !Number.isFinite(currentExpiry.getTime()) || currentExpiry.getTime() !== policyExpiry.getTime())) {
          saveState({
            status: 'trial',
            startsAt: startedAt.toISOString(),
            activatedAt: local.activatedAt || startedAt.toISOString(),
            expiresAt: policyExpiry.toISOString(),
            planCode: 'TRIAL',
            planName: 'B-MAX 15-Day Free Trial',
            durationCode: '15D',
            cachedUntil: policyExpiry.toISOString(),
          });
          return getLocalSubscriptionState()!;
        }
        if (policyExpiry <= now) {
          saveState({ status: 'expired', startsAt: startedAt.toISOString(), expiresAt: policyExpiry.toISOString(), planCode: null, planName: null, durationCode: null, cachedUntil: now.toISOString() });
          return getLocalSubscriptionState()!;
        }
      }
    }
    return local;
  }

  // The licensing server is authoritative. Never manufacture a paid entitlement
  // locally: doing so would allow a patched EXE to grant itself a subscription.
  try {
    const payload = await callLicenseServer('/api/license/bootstrap', {
      installationId: local.installationId,
      deviceFingerprint: local.deviceId,
      email: String(email || local.email || '').trim().toLowerCase() || undefined,
    });

    const state = normalizeRemote(payload, email || local.email || undefined);
    saveState(state);
    return getLocalSubscriptionState()!;
  } catch (err: any) {
    // Offline use is allowed only for a previously server-verified active
    // subscription and only until its short grace window expires.
    const cached = getLocalSubscriptionState();
    if (
      cached?.status === 'active' &&
      cached.expiresAt &&
      new Date(cached.expiresAt) > now &&
      cached.cachedUntil &&
      new Date(cached.cachedUntil) > now
    ) {
      return cached;
    }

    throw err;
  }
}

function resolveEmbeddedActivation(licenseKey: string) {
  const normalizedKey = String(licenseKey || '').trim().toUpperCase();
  if (!normalizedKey) {
    throw Object.assign(new Error('Invalid activation code. Please check the code and try again.'), { status: 400, code: 'INVALID_ACTIVATION_CODE' });
  }
  const verifiedCode = verifyEmbeddedActivationCode(normalizedKey);
  if (!verifiedCode) {
    throw Object.assign(new Error('Invalid activation code. Please check the code and try again.'), { status: 400, code: 'INVALID_ACTIVATION_CODE' });
  }
  const planName = verifiedCode.planCode === 'STARTER' ? 'Starter' : verifiedCode.planCode === 'BUSINESS' ? 'Business' : 'Professional';
  const durationMonths = verifiedCode.durationCode === '1Y' ? 12 : verifiedCode.durationCode === '3Y' ? 36 : 60;
  const durationName = verifiedCode.durationCode === '1Y' ? '1 Year' : verifiedCode.durationCode === '3Y' ? '3 Years' : '5 Years';
  const baseMaxFirms = verifiedCode.planCode === 'STARTER' ? 1 : verifiedCode.planCode === 'BUSINESS' ? 2 : 3;
  const baseMaxUsers = verifiedCode.planCode === 'STARTER' ? 2 : 5;
  return { normalizedKey, ...verifiedCode, planName, durationMonths, durationName, baseMaxFirms, baseMaxUsers };
}

export function previewActivation(licenseKey: string) {
  ensureLocalState();
  const current = getLocalSubscriptionState()!;
  if (USE_CENTRAL_LICENSE_SERVER) {
    throw Object.assign(new Error('Central licensing preview is not enabled in this desktop build.'), { status: 503, code: 'LICENSE_SERVER_UNAVAILABLE' });
  }
  const candidate = resolveEmbeddedActivation(licenseKey);
  const currentIsActive = current.status === 'active' && (current.isLifetime || !current.expiresAt || new Date(current.expiresAt) > new Date());
  const currentPlan = String(current.planCode || '').toUpperCase();
  const currentDuration = String(current.durationCode || '').toUpperCase();
  const samePlan = currentIsActive && currentPlan === candidate.planCode;
  const sameDuration = currentIsActive && currentDuration === candidate.durationCode;
  const action = !currentIsActive ? 'activate' : (samePlan && sameDuration ? 'renew' : 'upgrade');
  const startsAt = new Date();
  const expiresAt = new Date(startsAt);
  expiresAt.setMonth(expiresAt.getMonth() + candidate.durationMonths);
  return {
    action,
    current: {
      planCode: current.planCode || null,
      planName: current.planName || (current.status === 'trial' ? '15-Day Free Trial' : null),
      durationCode: current.durationCode || null,
      startsAt: current.startsAt || null,
      activatedAt: current.activatedAt || current.startsAt || null,
      expiresAt: current.expiresAt || null,
      status: current.status,
    },
    next: {
      planCode: candidate.planCode,
      planName: candidate.planName,
      durationCode: candidate.durationCode,
      durationName: candidate.durationName,
      startsAt: startsAt.toISOString(),
      activatedAt: startsAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      maxFirms: candidate.baseMaxFirms,
      maxUsers: candidate.baseMaxUsers,
    },
    replacesCurrent: currentIsActive,
    startsFromActivationDate: true,
  };
}

export async function activateSubscription(licenseKey: string, email?: string, allowOverride = false): Promise<SubscriptionState> {
  ensureLocalState();
  const current = getLocalSubscriptionState()!;
  const normalizedKey = String(licenseKey || '').trim().toUpperCase();
  if (!normalizedKey) {
    throw Object.assign(new Error('Invalid activation code. Please check the code and try again.'), { status: 400, code: 'INVALID_ACTIVATION_CODE' });
  }
  const currentIsActive = current.status === 'active' && (current.isLifetime || !current.expiresAt || new Date(current.expiresAt) > new Date());
  if (currentIsActive && !allowOverride) {
    throw Object.assign(new Error('An active B-MAX subscription is already present. Please review the renewal/upgrade details before applying the new code.'), { status: 409, code: 'CONFIRM_RENEWAL_UPGRADE_REQUIRED' });
  }

  // The B-MAX backend is authoritative for the current desktop build.
  // The fixed registry contains the supplied activation codes; the frontend
  // never verifies codes. A central licensing server is opt-in only.
  if (!USE_CENTRAL_LICENSE_SERVER) {
    const verifiedCode = resolveEmbeddedActivation(normalizedKey);
    const startsAt = new Date();
    const expiresAt = new Date(startsAt);
    expiresAt.setMonth(expiresAt.getMonth() + verifiedCode.durationMonths);
    const planName = verifiedCode.planName;
    const maxFirms = verifiedCode.baseMaxFirms;
    const maxUsers = verifiedCode.baseMaxUsers;
    saveState({
      email: email || current.email || null,
      licenseKey: normalizedKey,
      planCode: verifiedCode.planCode,
      planName,
      durationCode: verifiedCode.durationCode,
      status: 'active',
      startsAt: startsAt.toISOString(),
      activatedAt: startsAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      isLifetime: false,
      maxFirms,
      maxUsers,
      additionalUsers: 0,
      additionalFirms: 0,
      additionalGst: 0,
      lastVerifiedAt: startsAt.toISOString(),
      cachedUntil: expiresAt.toISOString(),
      activationId: crypto.randomUUID(),
      serverVerified: false,
    });
    return getLocalSubscriptionState()!;
  }

  let payload: any;
  try {
    payload = await callLicenseServer('/api/license/activate', {
      licenseKey: normalizedKey,
      installationId: current.installationId,
      deviceFingerprint: current.deviceId,
      email: String(email || current.email || '').trim().toLowerCase() || undefined,
    });
  } catch (err: any) {
    const status = Number(err?.status || 0);
    if (status >= 400 && status < 500) {
      throw Object.assign(new Error('Invalid activation code. Please check the code and try again.'), { status: 400, code: 'INVALID_ACTIVATION_CODE' });
    }
    throw Object.assign(new Error('Unable to verify the activation code. Please try again when the B-MAX licensing server is available.'), { status: 503, code: 'LICENSE_SERVER_UNAVAILABLE' });
  }

  const remoteStatus = String(payload?.status || '').toLowerCase();
  const hasPlan = Boolean(payload?.planCode || payload?.planName);
  const hasDuration = Boolean(payload?.durationCode || payload?.duration);
  const hasExpiry = Boolean(payload?.isLifetime || payload?.expiresAt);
  const verified = payload?.verified === true || payload?.success === true || remoteStatus === 'active';
  if (!verified || remoteStatus !== 'active' || !hasPlan || !hasDuration || !hasExpiry) {
    throw Object.assign(new Error('Invalid activation code. Please check the code and try again.'), { status: 400, code: 'INVALID_ACTIVATION_CODE' });
  }

  const state = normalizeRemote(payload, email || current.email || undefined);
  if (state.status !== 'active' || !state.planCode || !state.durationCode || (!state.isLifetime && !state.expiresAt)) {
    throw Object.assign(new Error('Invalid activation code. Please check the code and try again.'), { status: 400, code: 'INVALID_ACTIVATION_CODE' });
  }
  saveState({ ...state, serverVerified: true });
  return getLocalSubscriptionState()!;
}


function baseLimitsForPlan(planCode: string | null | undefined) {
  const code = String(planCode || '').toUpperCase();
  if (code === 'STARTER') return { firms: 1, users: 2 };
  if (code === 'BUSINESS') return { firms: 2, users: 5 };
  if (code === 'PROFESSIONAL') return { firms: 3, users: 5 };
  return { firms: 0, users: 0 };
}

function durationNameFromCode(code: string) {
  return code === '1Y' ? '1 Year' : code === '3Y' ? '3 Years' : code === '5Y' ? '5 Years' : code;
}

export function previewAddonActivation(addonCode: string, addonType = 'ADDITIONAL_USER') {
  ensureLocalState();
  const current = getLocalSubscriptionState()!;
  const requestedType = String(addonType || '').trim().toUpperCase();
  const allowedTypes = new Set(['ADDITIONAL_USER','ADDITIONAL_COMPANY']);
  if (current.status !== 'active' || !current.planCode || !current.durationCode) {
    throw Object.assign(new Error('An active paid B-MAX plan is required before an add-on can be activated.'), { status: 409, code: 'ADDON_REQUIRES_ACTIVE_PLAN' });
  }
  const verified = verifyEmbeddedAddonCode(addonCode);
  if (!verified || !allowedTypes.has(verified.addonType)) {
    throw Object.assign(new Error('Invalid add-on activation code. Please check the code and try again.'), { status: 400, code: 'INVALID_ADDON_CODE' });
  }
  // The code itself determines the add-on type. UI selection is only a convenience.
  const resolvedType = verified.addonType;
  if (verified.durationCode !== current.durationCode) {
    throw Object.assign(new Error(`This add-on code is for ${durationNameFromCode(verified.durationCode)}. Your current plan is ${durationNameFromCode(current.durationCode)}. Please use a matching-duration add-on code.`), { status: 409, code: 'ADDON_DURATION_MISMATCH' });
  }

  const planPrice = (PLAN_PRICING as any)?.[current.planName || '']?.[durationNameFromCode(verified.durationCode)]?.final;
  const percent = resolvedType === 'ADDITIONAL_USER' ? 10 : 30;
  const addonPrice = Number.isFinite(Number(planPrice)) ? Math.round(Number(planPrice) * percent) / 100 : null;
  const currentUsers = Number(current.maxUsers || 0);
  const currentFirms = Number(current.maxFirms || 0);
  const nextUsers = resolvedType === 'ADDITIONAL_USER' ? currentUsers + 1 : currentUsers;
  const nextFirms = resolvedType === 'ADDITIONAL_COMPANY' ? currentFirms + 1 : currentFirms;
  const name = resolvedType === 'ADDITIONAL_USER' ? 'Additional User' : 'Additional Company';
  return {
    addonType: resolvedType,
    addonName: name,
    durationCode: verified.durationCode,
    durationName: durationNameFromCode(verified.durationCode),
    current: { planName: current.planName, durationCode: current.durationCode, maxUsers: currentUsers, maxFirms: currentFirms, additionalUsers: Number(current.additionalUsers || 0), additionalFirms: Number(current.additionalFirms || 0) },
    next: { planName: current.planName, durationCode: current.durationCode, maxUsers: nextUsers, maxFirms: nextFirms, additionalUsers: Number(current.additionalUsers || 0) + (resolvedType === 'ADDITIONAL_USER' ? 1 : 0), additionalFirms: Number(current.additionalFirms || 0) + (resolvedType === 'ADDITIONAL_COMPANY' ? 1 : 0), expiresAt: current.expiresAt },
    startsAt: new Date().toISOString(),
    expiresAt: current.expiresAt,
    costRule: `${percent}% of the selected plan's final amount for the matching duration`,
    price: addonPrice,
    gstExtra: true,
    replacesCurrent: false,
  };
}

function ensureAddonTable(): void {
  db.exec(`CREATE TABLE IF NOT EXISTS subscription_addons (
    id TEXT PRIMARY KEY,
    activationId TEXT,
    addonType TEXT NOT NULL,
    durationCode TEXT NOT NULL,
    activatedAt TEXT NOT NULL,
    expiresAt TEXT,
    quantity INTEGER NOT NULL DEFAULT 1,
    codeHash TEXT NOT NULL,
    createdAt TEXT NOT NULL
  )`);
  const columns = db.prepare('PRAGMA table_info(subscription_addons)').all() as any[];
  const has = (name: string) => columns.some((c:any) => String(c.name) === name);
  if (!has('activationId')) db.exec('ALTER TABLE subscription_addons ADD COLUMN activationId TEXT');
  if (!has('expiresAt')) db.exec('ALTER TABLE subscription_addons ADD COLUMN expiresAt TEXT');
  if (!has('quantity')) db.exec('ALTER TABLE subscription_addons ADD COLUMN quantity INTEGER DEFAULT 1');
  if (!has('codeHash')) db.exec('ALTER TABLE subscription_addons ADD COLUMN codeHash TEXT');
  if (!has('createdAt')) db.exec('ALTER TABLE subscription_addons ADD COLUMN createdAt TEXT');
}

export function activateAddon(addonCode: string, addonType = 'ADDITIONAL_USER') {
  ensureLocalState();
  const preview = previewAddonActivation(addonCode, addonType);
  const current = getLocalSubscriptionState()!;
  const resolvedType = String(preview.addonType || '').toUpperCase();
  const additionalUsers = Number(current.additionalUsers || 0) + (resolvedType === 'ADDITIONAL_USER' ? 1 : 0);
  const additionalFirms = Number(current.additionalFirms || 0) + (resolvedType === 'ADDITIONAL_COMPANY' ? 1 : 0);
  const limits = baseLimitsForPlan(current.planCode);
  const activationId = crypto.randomUUID();
  saveState({
    additionalUsers,
    maxFirms: limits.firms + additionalFirms,
    maxUsers: limits.users + additionalUsers,
    additionalFirms,
    activationId,
    lastVerifiedAt: new Date().toISOString(),
    cachedUntil: current.expiresAt || null,
  });
  try {
    ensureAddonTable();
    db.prepare('INSERT INTO subscription_addons (id,activationId,addonType,durationCode,activatedAt,expiresAt,quantity,codeHash,createdAt) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(crypto.randomUUID(), activationId, preview.addonType, preview.durationCode, new Date().toISOString(), current.expiresAt || null, 1, crypto.createHash('sha256').update(String(addonCode || '').trim().toUpperCase()).digest('hex'), new Date().toISOString());
  } catch (_) {}
  return getLocalSubscriptionState()!;
}

export function getSubscriptionAccess(): { allowed: boolean; readOnly: boolean; reason?: string; state: SubscriptionState | null } {
  ensureLocalState();
  const state = getLocalSubscriptionState();
  if (state && state.status === 'active' && state.planCode) {
    const limits = baseLimitsForPlan(state.planCode);
    state.maxFirms = limits.firms + Number(state.additionalFirms || 0);
    state.maxUsers = limits.users + Number(state.additionalUsers || 0);
  }
  if (!state) {
    return { allowed: false, readOnly: true, reason: 'A valid B-MAX subscription is required.', state: null };
  }

  const now = new Date();

  if (state.status === 'active') {
    if (state.isLifetime) return { allowed: true, readOnly: false, state };
    if (state.expiresAt && new Date(state.expiresAt) > now) {
      return { allowed: true, readOnly: false, state };
    }
    // Persist the expired state so every subsequent request is consistently read-only.
    saveState({ status: 'expired', cachedUntil: now.toISOString() });
    return {
      allowed: false,
      readOnly: true,
      reason: 'Your B-MAX subscription has expired. Please renew your subscription to create or modify data.',
      state: getLocalSubscriptionState(),
    };
  }

  if (state.status === 'trial') {
    if (state.expiresAt && new Date(state.expiresAt) > now) {
      return { allowed: true, readOnly: false, state };
    }
    saveState({ status: 'expired', cachedUntil: now.toISOString() });
    return {
      allowed: false,
      readOnly: true,
      reason: `Your 15-day B-MAX free trial has expired. Please renew your subscription to create or modify data.`,
      state: getLocalSubscriptionState(),
    };
  }

  const blockedStatus = String(state.status || '').toLowerCase();
  const blockedReason = blockedStatus === 'revoked'
    ? 'This B-MAX license has been revoked by the administrator.'
    : blockedStatus === 'suspended'
      ? 'This B-MAX license is suspended by the administrator.'
      : blockedStatus === 'inactive'
        ? 'No active B-MAX license is assigned to this account.'
        : 'This B-MAX subscription does not permit new transactions.';
  return { allowed: false, readOnly: true, reason: blockedReason, state };
}

export function getLicenseServerUrl() {
  return USE_CENTRAL_LICENSE_SERVER ? LICENSE_SERVER_URL : '';
}



