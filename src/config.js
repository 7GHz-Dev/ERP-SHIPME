import path from 'node:path';

const rootDir = path.resolve(import.meta.dirname, '..');
const bool = (value, fallback = false) => value == null || value === ''
  ? fallback
  : /^(1|true|yes|on)$/i.test(String(value));
const number = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;

export const config = Object.freeze({
  rootDir,
  host: process.env.HOST || '0.0.0.0',
  port: number(process.env.PORT, 8080),
  dataDir: path.resolve(rootDir, process.env.DATA_DIR || 'data'),
  sessionHours: number(process.env.SESSION_HOURS, 12),
  maxAccuracy: number(process.env.MAX_ACCURACY_METERS, 200),
  maxAccuracyDesktop: number(process.env.MAX_ACCURACY_METERS_DESKTOP, 5000),
  maxBodyBytes: Math.max(1, number(process.env.MAX_BODY_MB, 15)) * 1024 * 1024,
  trustProxy: bool(process.env.TRUST_PROXY),
  adminUsername: process.env.ADMIN_USERNAME || 'admin',
  adminPassword: process.env.ADMIN_PASSWORD || '1234',
  adminName: process.env.ADMIN_NAME || 'ผู้ดูแลระบบ',
  geocodeEndpoint: process.env.GEOCODE_ENDPOINT || '',
  ocrEndpoint: process.env.OCR_ENDPOINT || '',
  slipStrict: bool(process.env.SLIP_STRICT),
  slipAmountTolerance: number(process.env.SLIP_AMOUNT_TOLERANCE, 1)
});
