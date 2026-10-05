// Public error fields are deliberately allowlisted; never attach upstream errors or bodies.
const safeErrors = new WeakSet();
export function githubError(code, message, status = 502, retryAt) {
  const error = Object.assign(new Error(message), {code, status});
  if (retryAt) error.retryAt = new Date(retryAt).toISOString();
  safeErrors.add(error); return error;
}
export const isGitHubError = error => safeErrors.has(error);
export function rateHeaders(headers, now) {
  const integer = name => {const v = headers.get(name); return v !== null && /^\d+$/.test(v) && Number.isSafeInteger(Number(v)) ? Number(v) : null;};
  const limit = integer('x-ratelimit-limit'), remaining = integer('x-ratelimit-remaining'), reset = integer('x-ratelimit-reset');
  const rawRetry = headers.get('retry-after');
  const retry = rawRetry === null ? NaN : /^\d+$/.test(rawRetry) ? now + Number(rawRetry) * 1000 : Date.parse(rawRetry);
  const rawResource = headers.get('x-ratelimit-resource');
  const resource = /^[a-z_]{1,40}$/.test(rawResource || '') ? rawResource : 'core';
  return {limit, remaining, resetAt: reset !== null && reset * 1000 <= 8640000000000000 ? reset * 1000 : null,
    retryAt: Number.isFinite(retry) && retry > now ? Math.min(retry, now + 86400000) : null, resource};
}
export function rateDeadline(rate, now) {
  return Math.min(now + 86400000, Math.max(now + 1000, rate.retryAt || 0,
    rate.remaining === 0 && rate.resetAt > now ? rate.resetAt : now + 60000));
}
export const rateError = until => githubError('github_rate_limited', 'GitHub 请求额度暂时受限，请在恢复后重试', 429, until);
