// SPDX-License-Identifier: GPL-3.0-or-later
import { randomBytes } from 'node:crypto';
import { exactOrigin } from './validation.js';
export function loadConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const publicBaseUrl = exactOrigin(env.PUBLIC_BASE_URL || 'http://127.0.0.1:8787', !production);
  const allowedOrigins = new Set((env.CORS_ORIGINS || 'http://127.0.0.1:8000,http://localhost:8000').split(',').filter(Boolean).map(s => exactOrigin(s.trim(), true)));
  allowedOrigins.add(publicBaseUrl);
  const sessionSecret = env.SESSION_SECRET || (production ? '' : randomBytes(32).toString('hex'));
  if (sessionSecret.length < 32 || /replace|placeholder|example/i.test(sessionSecret)) throw new Error('SESSION_SECRET 必须使用至少 32 字符的随机服务端 Secret');
  const redirectUri = env.DISCORD_REDIRECT_URI || `${publicBaseUrl}/api/auth/callback`;
  if (redirectUri !== `${publicBaseUrl}/api/auth/callback`) throw new Error('DISCORD_REDIRECT_URI 必须精确等于 PUBLIC_BASE_URL/api/auth/callback');
  const adminIds = new Set((env.MIEMIE_ADMIN_DISCORD_IDS || '').split(',').map(x => x.trim()).filter(Boolean));
  for (const id of adminIds) if (!/^\d{15,22}$/.test(id)) throw new Error('管理员 ID 格式无效');
  const ttl = Number(env.SESSION_TTL_SECONDS || 28800);
  if (!Number.isSafeInteger(ttl) || ttl < 60 || ttl > 86400) throw new Error('Session TTL 必须介于 60 与 86400 秒');
  const port = Number(env.PORT || 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 无效');
  return { production, publicBaseUrl, allowedOrigins, sessionSecret, redirectUri, adminIds, sessionTtlMs: ttl * 1000, clientId: env.DISCORD_CLIENT_ID || '', clientSecret: env.DISCORD_CLIENT_SECRET || '', databasePath: env.DATABASE_PATH || './data/registry.sqlite', host: env.HOST || '127.0.0.1', port };
}
