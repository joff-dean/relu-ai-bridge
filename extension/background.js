import { bridgeApiUrl, normalizeBridgeBaseUrl } from './security.js';

const DEFAULTS = {
  baseUrl: 'http://127.0.0.1:5746',
  enabled: true,
};

const claimedCommands = new Set();
const encoder = new TextEncoder();

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hex(bytes) {
  return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

async function sha256(value) {
  return hex(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
}

async function hmac(token, value) {
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(token), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  return hex(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
}

function randomNonce() {
  return hex(crypto.getRandomValues(new Uint8Array(32)));
}

function proofInput(kind, record) {
  return [
    `relu-ai-bridge/http-${kind}/v1`, record.origin, record.clientNonce,
    record.serverNonce, record.requestHash,
  ].join('\0');
}

function sameHex(left, right) {
  if (typeof left !== 'string' || left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

async function settings() {
  const local = await chrome.storage.local.get(DEFAULTS);
  const session = await chrome.storage.session.get({ token: '' });
  return {
    ...DEFAULTS,
    ...local,
    baseUrl: normalizeBridgeBaseUrl(local.baseUrl ?? DEFAULTS.baseUrl),
    token: session.token,
  };
}

async function api(path, options = {}) {
  const config = await settings();
  if (!config.enabled) throw new Error('RELU AI Bridge Companion is disabled');
  if (!config.token) throw new Error('Pairing token is not configured');
  const method = options.method ?? 'GET';
  const bodyValue = options.body ?? null;
  const bodyHash = await sha256(canonicalJson(bodyValue));
  const requestHash = await sha256([
    'relu-ai-bridge/http-request-binding/v1', method, path, bodyHash,
  ].join('\0'));
  const clientNonce = randomNonce();
  const origin = self.location.origin;
  const challengeResponse = await fetch(bridgeApiUrl(config.baseUrl, '/bridge/challenge'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clientNonce, requestHash }),
  });
  const challenge = await challengeResponse.json().catch(() => ({}));
  if (!challengeResponse.ok) throw new Error(challenge.error ?? `Local bridge challenge returned HTTP ${challengeResponse.status}`);
  const record = { origin, clientNonce, serverNonce: challenge.serverNonce, requestHash };
  const expectedServerProof = await hmac(config.token, proofInput('server', record));
  if (challenge.protocolVersion !== '1.0' || !/^[a-f0-9]{64}$/.test(challenge.serverNonce)
    || !sameHex(challenge.proof, expectedServerProof)) {
    throw new Error('Local endpoint could not prove RELU AI Bridge identity');
  }
  const requestProof = await hmac(config.token, proofInput('client', record));
  const response = await fetch(bridgeApiUrl(config.baseUrl, path), {
    method,
    headers: {
      'x-relu-client-nonce': clientNonce,
      'x-relu-server-nonce': challenge.serverNonce,
      'x-relu-request-proof': requestProof,
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `Local bridge returned HTTP ${response.status}`);
  return body;
}

function payloadKey(tabId) {
  return `initial-payload:${tabId}`;
}

async function openChat(payload) {
  let tab = null;
  if (payload.conversationUrl) {
    const matches = await chrome.tabs.query({ url: `${payload.conversationUrl}*` });
    tab = matches[0] ?? null;
  }
  if (tab) await chrome.tabs.update(tab.id, { active: true });
  else tab = await chrome.tabs.create({ url: payload.conversationUrl ?? 'https://chatgpt.com/', active: false });
  await chrome.storage.session.set({ [payloadKey(tab.id)]: payload });
  if (payload.conversationUrl && tab) {
    try {
      const response = await chrome.tabs.sendMessage(tab.id, { type: 'initial.deliver', payload });
      if (response?.accepted) await chrome.storage.session.remove(payloadKey(tab.id));
    } catch {
      // A newly loading tab claims the stored payload from its content script.
    }
  }
  return { tabId: tab.id };
}

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get(Object.keys(DEFAULTS));
  await chrome.storage.local.set({ ...DEFAULTS, ...existing });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message?.type === 'settings.get') return settings();
    if (message?.type === 'settings.save') {
      const next = {
        baseUrl: normalizeBridgeBaseUrl(message.value.baseUrl ?? DEFAULTS.baseUrl),
        token: String(message.value.token ?? ''),
        enabled: Boolean(message.value.enabled),
      };
      await chrome.storage.local.set({ baseUrl: next.baseUrl, enabled: next.enabled });
      await chrome.storage.session.set({ token: next.token });
      return next;
    }
    if (message?.type === 'api') return api(message.path, message.options);
    if (message?.type === 'command.claim') {
      if (claimedCommands.has(message.commandId)) return { claimed: false };
      claimedCommands.add(message.commandId);
      setTimeout(() => claimedCommands.delete(message.commandId), 60_000);
      return { claimed: true };
    }
    if (message?.type === 'chat.open') return openChat(message.payload);
    if (message?.type === 'initial.claim') {
      const tabId = sender.tab?.id;
      if (!tabId) return null;
      const key = payloadKey(tabId);
      const value = (await chrome.storage.session.get(key))[key] ?? null;
      if (value) await chrome.storage.session.remove(key);
      return value;
    }
    throw new Error('Unknown extension message');
  })().then(
    (value) => sendResponse({ ok: true, value }),
    (error) => sendResponse({ ok: false, error: error.message ?? String(error) }),
  );
  return true;
});
