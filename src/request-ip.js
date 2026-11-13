// SPDX-License-Identifier: GPL-3.0-or-later
import {isIP, SocketAddress} from 'node:net';

function normalizeIP(value) {
  if (typeof value !== 'string' || value.length > 45) return '';
  const family = isIP(value);
  if (family === 4) return value;
  if (family !== 6) return '';
  const address = SocketAddress.parse(`[${value}]:0`)?.address || '';
  return address.replace(/^::ffff:(?=\d+\.)/, '');
}

export function requestIP(req, {trustLoopbackProxy, host}) {
  const peer = normalizeIP(req.socket.remoteAddress);
  if (trustLoopbackProxy && (host === '127.0.0.1' || host === '::1') && peer === host) {
    // The explicitly trusted proxy must overwrite this header on every request.
    // Multiple values, chains and non-IP values fall back to the socket address.
    return normalizeIP(req.headers['x-miemie-client-ip']) || peer;
  }
  return peer || 'unknown';
}
