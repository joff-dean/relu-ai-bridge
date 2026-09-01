import crypto from 'node:crypto';
import { secureEqual } from './utils.mjs';

const NONCE = /^[a-f0-9]{64}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const CHALLENGE_TTL_MS = 10_000;
const MAX_CHALLENGES = 256;

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function canonicalBodyHash(value) {
  return crypto.createHash('sha256').update(canonicalJson(value ?? null)).digest('hex');
}

export function requestBindingHash(method, requestPath, body) {
  return crypto.createHash('sha256').update([
    'relu-ai-bridge/http-request-binding/v1', String(method).toUpperCase(),
    String(requestPath), canonicalBodyHash(body),
  ].join('\0')).digest('hex');
}

function proofInput(kind, record) {
  return [
    `relu-ai-bridge/http-${kind}/v1`, record.origin, record.clientNonce,
    record.serverNonce, record.requestHash,
  ].join('\0');
}

function hmac(token, value) {
  return crypto.createHmac('sha256', token).update(value).digest('hex');
}

export class HttpProofBroker {
  constructor(token) {
    this.token = token;
    this.challenges = new Map();
  }

  prune(now = Date.now()) {
    for (const [nonce, record] of this.challenges) {
      if (record.expiresAt <= now) this.challenges.delete(nonce);
    }
  }

  issue(origin, input) {
    this.prune();
    if (this.challenges.size >= MAX_CHALLENGES) {
      // Challenges contain no client data and are one-shot. Evict the oldest
      // instead of letting unauthenticated challenge creation permanently
      // exhaust the extension authentication path.
      this.challenges.delete(this.challenges.keys().next().value);
    }
    const clientNonce = String(input?.clientNonce ?? '');
    const requestHash = String(input?.requestHash ?? '');
    if (!NONCE.test(clientNonce) || !DIGEST.test(requestHash)) {
      const error = new Error('Invalid bridge authentication challenge');
      error.statusCode = 400;
      throw error;
    }
    const serverNonce = crypto.randomBytes(32).toString('hex');
    const record = {
      origin, clientNonce, serverNonce, requestHash,
      expiresAt: Date.now() + CHALLENGE_TTL_MS,
    };
    this.challenges.set(serverNonce, record);
    return {
      protocolVersion: '1.0',
      serverNonce,
      proof: hmac(this.token, proofInput('server', record)),
      expiresAt: new Date(record.expiresAt).toISOString(),
    };
  }

  consume(request, origin) {
    this.prune();
    const serverNonce = String(request.headers['x-relu-server-nonce'] ?? '');
    const clientNonce = String(request.headers['x-relu-client-nonce'] ?? '');
    const suppliedProof = String(request.headers['x-relu-request-proof'] ?? '');
    const record = this.challenges.get(serverNonce);
    if (!record || record.origin !== origin || record.clientNonce !== clientNonce || !DIGEST.test(suppliedProof)) return null;
    // Every challenge is one-shot, including failed proofs.
    this.challenges.delete(serverNonce);
    const expected = hmac(this.token, proofInput('client', record));
    return secureEqual(suppliedProof, expected) ? record : null;
  }

  requestMatches(record, request, body) {
    return secureEqual(record.requestHash, requestBindingHash(request.method, request.url, body));
  }
}
