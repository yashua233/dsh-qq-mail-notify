// Settings resolution: patch config > $DSH_HOME/qq-mail-notify.json > environment.
// The plugin's tool writes the JSON file, so a user can configure the mailbox
// from a conversation without editing the profile patch by hand.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { providerPreset } from './presets.js';

export const DEFAULTS = Object.freeze({
  enabled: true,
  smtpHost: 'smtp.qq.com',
  smtpPort: 465,
  secure: true,
  user: '',
  authCode: '',
  to: '',
  fromName: 'DeepSeek Harness',
  subjectPrefix: '[DSH]',
  idleDelayMs: 0,
  progressEveryMs: 2_400_000,
  /**
   * 审批邮件：把「工具在等你授权」转发到邮箱，回信决定放行或拒绝。
   *
   * 默认关。开了之后邮箱就变成一条授权通道——信任等级比单纯的通知高一个量级，
   * 而且必须同时装了接收侧（dsh-mail-command）才有意义，所以不默认启用。
   */
  approvalMailEnabled: false,
  /** 等回信的时长；超时后把决定权交回界面，不会替你拒绝。 */
  approvalMailTimeoutMs: 600_000,

  maxBatchMs: 1_800_000,
  maxBatchTurns: 20,
  minTurnMs: 0,
  skipSubagents: true,
  notifyOnAbort: false,
  quietHours: '',
  includePreview: true,
  previewChars: 1_200,
});

const ENV_KEYS = {
  user: 'DSH_QQ_MAIL_USER',
  authCode: 'DSH_QQ_MAIL_AUTH_CODE',
  to: 'DSH_QQ_MAIL_TO',
  smtpHost: 'DSH_QQ_MAIL_HOST',
  smtpPort: 'DSH_QQ_MAIL_PORT',
  secure: 'DSH_QQ_MAIL_SECURE',
};

export function dshHome() {
  const fromEnv = process.env.DSH_HOME?.trim();
  if (fromEnv) return fromEnv;
  const profileDir = process.env.DSH_PROFILE_DIR?.trim();
  if (profileDir) return path.dirname(profileDir);
  return path.join(homedir(), '.dsh');
}

export function settingsFile() {
  return path.join(dshHome(), 'qq-mail-notify.json');
}

/** Per-session overrides decide how each conversation reports back. */
export function sessionsFile() {
  return path.join(dshHome(), 'qq-mail-notify-sessions.json');
}

const MAX_SESSION_ENTRIES = 300;

function isSet(value) {
  return value !== undefined && value !== null && value !== '';
}

function coerce(key, value) {
  switch (key) {
    case 'smtpPort':
    case 'idleDelayMs':
    case 'progressEveryMs':
    case 'approvalMailTimeoutMs':
    case 'maxBatchMs':
    case 'maxBatchTurns':
    case 'minTurnMs':
    case 'previewChars': {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : undefined;
    }
    case 'secure':
    case 'enabled':
    case 'approvalMailEnabled':
    case 'skipSubagents':
    case 'notifyOnAbort':
    case 'includePreview':
      if (typeof value === 'boolean') return value;
      if (typeof value === 'string') {
        if (/^(true|1|yes|on)$/i.test(value)) return true;
        if (/^(false|0|no|off)$/i.test(value)) return false;
      }
      return undefined;
    default:
      return typeof value === 'string' ? value : String(value);
  }
}

export async function readStored() {
  try {
    const raw = await readFile(settingsFile(), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export async function writeStored(patch) {
  const current = await readStored();
  const next = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in DEFAULTS)) continue;
    if (value === null || value === '') delete next[key];
    else {
      const coerced = coerce(key, value);
      if (coerced !== undefined) next[key] = coerced;
    }
  }
  const file = settingsFile();
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return next;
}

export async function readSessions() {
  try {
    const raw = await readFile(sessionsFile(), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Merges one session's overrides into the sessions file and returns its record. */
export async function writeSessionOverride(sessionId, patch) {
  const all = await readSessions();
  const key = String(sessionId);
  const next = { ...(all[key] ?? {}) };
  for (const [field, value] of Object.entries(patch ?? {})) {
    if (!(field in DEFAULTS)) continue;
    if (value === null || value === '') delete next[field];
    else {
      const coerced = coerce(field, value);
      if (coerced !== undefined) next[field] = coerced;
    }
  }
  next.updatedAt = Date.now();
  all[key] = next;

  const keys = Object.keys(all);
  if (keys.length > MAX_SESSION_ENTRIES) {
    keys
      .sort((left, right) => (all[left]?.updatedAt ?? 0) - (all[right]?.updatedAt ?? 0))
      .slice(0, keys.length - MAX_SESSION_ENTRIES)
      .forEach((stale) => delete all[stale]);
  }

  const file = sessionsFile();
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(all, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return next;
}

/**
 * Resolves the effective settings and records where every field came from, so
 * `status` can explain why a value looks the way it does. Priority:
 * session override > config (patch) > file > environment > default.
 */
export function resolveSettings({ config = {}, stored = {}, env = process.env, session = null } = {}) {
  const settings = { ...DEFAULTS };
  const sources = {};
  for (const key of Object.keys(DEFAULTS)) {
    const candidates = [
      ['config', config?.[key]],
      ['file', stored?.[key]],
      ['env', ENV_KEYS[key] ? env?.[ENV_KEYS[key]] : undefined],
    ];
    let resolved;
    for (const [source, raw] of candidates) {
      if (!isSet(raw)) continue;
      const coerced = coerce(key, raw);
      if (coerced === undefined) continue;
      settings[key] = coerced;
      sources[key] = source;
      resolved = true;
      break;
    }
    if (!resolved) sources[key] = 'default';
  }

  const override = session && typeof session === 'object' ? session : {};
  for (const key of Object.keys(DEFAULTS)) {
    if (!isSet(override[key])) continue;
    const coerced = coerce(key, override[key]);
    if (coerced === undefined) continue;
    settings[key] = coerced;
    sources[key] = 'session';
  }

  if (!settings.to) settings.to = settings.user;

  // 服务商推断：只在主机仍是默认值、且地址明确属于另一家时才替换端点。
  // QQ 是主路径——@qq.com / @foxmail.com / @vip.qq.com 都推断回 QQ，
  // 与 DEFAULTS 里的主机相同，所以零配置的行为与加预设表之前完全一致。
  if (sources.smtpHost === 'default') {
    const preset = providerPreset(settings.user);
    if (preset !== undefined && preset.smtp.host !== DEFAULTS.smtpHost) {
      settings.smtpHost = preset.smtp.host;
      sources.smtpHost = `preset:${preset.id}`;
      if (sources.smtpPort === 'default') {
        settings.smtpPort = preset.smtp.port;
        sources.smtpPort = `preset:${preset.id}`;
      }
      if (sources.secure === 'default') {
        settings.secure = preset.smtp.secure;
        sources.secure = `preset:${preset.id}`;
      }
    }
  }

  return { settings, sources };
}

export function maskSecret(value) {
  const text = String(value ?? '');
  if (!text) return '';
  if (text.length <= 6) return `${text.slice(0, 1)}***`;
  return `${text.slice(0, 4)}***${text.slice(-2)}`;
}

export function describeSettings({ settings, sources }) {
  const safe = { ...settings };
  if (safe.authCode) safe.authCode = maskSecret(safe.authCode);
  const missing = [];
  if (!settings.user) missing.push('user');
  if (!settings.authCode) missing.push('authCode');
  return {
    settings: safe,
    sources,
    ready: missing.length === 0,
    missing,
    file: settingsFile(),
  };
}
