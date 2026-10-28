import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

function storageDir() {
  const configured = process.env.DB_PATH || path.join(process.cwd(), 'data');
  return configured;
}

export function getDeviceIdentity() {
  const dir = storageDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'bmax-device.json');
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (saved.deviceId && saved.installationId) return saved;
  } catch (_) {}
  const identity = {
    deviceId: `BMAX-${crypto.randomUUID()}`,
    installationId: crypto.randomUUID(),
    deviceName: process.env.BMAX_DEVICE_NAME || require('os').hostname(),
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(file, JSON.stringify(identity, null, 2), { mode: 0o600 });
  return identity;
}



