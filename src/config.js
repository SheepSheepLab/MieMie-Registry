// SPDX-License-Identifier: GPL-3.0-or-later
import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { exactOrigin } from './validation.js';
export function loadConfig(env = process.env) {
  if (env.NODE_ENV && !['development', 'test', 'production'].includes(env.NODE_ENV)) throw new Error('NODE_ENV 必须为 development、test 或 production');
  const production = env.NODE_ENV === 'production';
  if (production && !env.PUBLIC_BASE_URL?.trim()) throw new Error('生产环境必须明确配置 PUBLIC_BASE_URL');
  if (production && !env.CORS_ORIGINS?.trim()) throw new Error('生产环境必须明确配置 CORS_ORIGINS');
  const publicBaseUrl = exactOrigin(env.PUBLIC_BASE_URL || 'http://127.0.0.1:8787', !production);
  const publicHostname = new URL(publicBaseUrl).hostname.replace(/\.$/, '').replace(/^\[|\]$/g, '');
  if (production && (isIP(publicHostname) || !publicHostname.includes('.') || /(^|\.)(localhost|local|internal|lan|home|example|example\.(com|org|net)|invalid|test)$/.test(publicHostname))) throw new Error('生产 PUBLIC_BASE_URL 必须使用实际公网 HTTPS 域名，不能使用 IP、示例或本机域名');
  const allowedOrigins = new Set((env.CORS_ORIGINS || 'http://127.0.0.1:8000,http://localhost:8000').split(',').filter(Boolean).map(s => exactOrigin(s.trim(), true)));
  if (production && !allowedOrigins.size) throw new Error('生产 CORS_ORIGINS 必须至少包含一个明确 Origin');
  allowedOrigins.add(publicBaseUrl);
  const sessionSecret = env.SESSION_SECRET || (production ? '' : randomBytes(32).toString('hex'));
  if (sessionSecret.length < 32 || /\s|replace|placeholder|example/i.test(sessionSecret)) throw new Error('SESSION_SECRET 必须使用至少 32 字符的随机服务端 Secret');
  const clientId = env.DISCORD_CLIENT_ID || '', clientSecret = env.DISCORD_CLIENT_SECRET || '';
  if (production && (!/^\d{15,22}$/.test(clientId) || clientSecret.length < 16 || clientSecret.length > 512 || /\s|replace|placeholder|example/i.test(clientSecret))) throw new Error('生产环境必须配置 Discord Client ID 和服务器 Client Secret');
  const redirectUri = env.DISCORD_REDIRECT_URI || `${publicBaseUrl}/api/auth/callback`;
  if (redirectUri !== `${publicBaseUrl}/api/auth/callback`) throw new Error('DISCORD_REDIRECT_URI 必须精确等于 PUBLIC_BASE_URL/api/auth/callback');
  const adminIds = new Set((env.MIEMIE_ADMIN_DISCORD_IDS || '').split(',').map(x => x.trim()).filter(Boolean));
  for (const id of adminIds) if (!/^\d{15,22}$/.test(id)) throw new Error('管理员 ID 格式无效');
  const ownerId = (env.MIEMIE_OWNER_DISCORD_ID || '').trim();
  if (ownerId && !/^\d{15,22}$/.test(ownerId)) throw new Error('Owner ID 格式无效');
  const ttl = Number(env.SESSION_TTL_SECONDS || 28800);
  if (!Number.isSafeInteger(ttl) || ttl < 60 || ttl > 86400) throw new Error('Session TTL 必须介于 60 与 86400 秒');
  const port = Number(env.PORT || 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 无效');
  const databasePath = env.DATABASE_PATH || './data/registry.sqlite';
  if (production && databasePath === ':memory:') throw new Error('生产环境必须使用持久 SQLite 文件');
  return { production, publicBaseUrl, allowedOrigins, sessionSecret, redirectUri, adminIds, ownerId, sessionTtlMs: ttl * 1000, clientId, clientSecret, databasePath, host: env.HOST || '127.0.0.1', port };
}
