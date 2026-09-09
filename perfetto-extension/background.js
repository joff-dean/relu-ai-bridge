import {
  EXTENSION_PROTOCOL_VERSION,
  MAX_BRIDGE_MESSAGE_CHARS,
  NATIVE_HOST_NAME,
  PERFETTO_ORIGIN,
} from './policy.js';

const CONTENT_PORT_NAME = 'relu-perfetto-page-v1';
const LOOPBACK_ENDPOINT = /^ws:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/perfetto\/extension-ws$/;
let nativePort = null;
let nativeSequence = 0;
const nativePending = new Map();
const contentSessions = new Set();

function exactOrigin(url) {
  try {
    const parsed = new URL(url);
    return parsed.origin;
  } catch {
    return null;
  }
}

function connectNativeHost() {
  if (nativePort) return nativePort;
  const port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
  nativePort = port;
  port.onMessage.addListener((message) => {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return;
    const pending = nativePending.get(message.id);
    if (!pending) return;
    nativePending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.ok === true) pending.resolve(message.value);
    else pending.reject(new Error('RELU Perfetto Native Host 요청이 거부되었습니다.'));
  });
  port.onDisconnect.addListener(() => {
    if (nativePort !== port) return;
    nativePort = null;
    for (const pending of nativePending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('RELU Perfetto Native Host 연결이 종료되었습니다.'));
    }
    nativePending.clear();
    for (const session of contentSessions) session.invalidate();
  });
  return port;
}

function callNativeHost(payload) {
  const id = `native_${Date.now()}_${++nativeSequence}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      nativePending.delete(id);
      reject(new Error('RELU Perfetto Native Host 응답 시간이 초과되었습니다.'));
    }, 15_000);
    nativePending.set(id, {resolve, reject, timer});
    connectNativeHost().postMessage({id, ...payload});
  });
}

function validateBootstrap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Native Host bootstrap 형식이 올바르지 않습니다.');
  }
  const keys = Object.keys(value).sort();
  if (keys.join('\0') !== ['endpoint', 'token'].join('\0')) {
    throw new Error('Native Host bootstrap field가 올바르지 않습니다.');
  }
  const endpointMatch = typeof value.endpoint === 'string' && value.endpoint.match(LOOPBACK_ENDPOINT);
  if (!endpointMatch || Number(endpointMatch[1]) > 65_535) {
    throw new Error('Native Host endpoint가 올바르지 않습니다.');
  }
  if (typeof value.token !== 'string' || value.token.length < 24 || value.token.length > 4096) {
    throw new Error('Native Host credential이 올바르지 않습니다.');
  }
  return {endpoint: value.endpoint, token: value.token};
}

function extensionWebSocketUrl(endpoint) {
  const url = new URL(endpoint);
  url.searchParams.set('pageOrigin', PERFETTO_ORIGIN);
  return url.toString();
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== CONTENT_PORT_NAME || exactOrigin(port.sender?.url) !== PERFETTO_ORIGIN) {
    port.disconnect();
    return;
  }
  const sockets = new Map();
  let bootstrap = null;

  const reply = (message) => {
    try { port.postMessage(message); } catch { /* The page was closed. */ }
  };
  const session = {
    invalidate() {
      bootstrap = null;
      for (const socket of sockets.values()) socket.close(1012, 'Native Host restarted');
      sockets.clear();
      reply({version: EXTENSION_PROTOCOL_VERSION, type: 'bootstrap.invalidated'});
    },
  };
  contentSessions.add(session);

  port.onMessage.addListener((message) => {
    void (async () => {
      if (!message || typeof message !== 'object' || Array.isArray(message) || message.version !== EXTENSION_PROTOCOL_VERSION) {
        throw new Error('지원하지 않는 page message입니다.');
      }
      if (message.type === 'bootstrap.request') {
        bootstrap ??= validateBootstrap(await callNativeHost({
          type: 'bridge.bootstrap',
          version: EXTENSION_PROTOCOL_VERSION,
          pageOrigin: PERFETTO_ORIGIN,
        }));
        reply({version: EXTENSION_PROTOCOL_VERSION, type: 'bootstrap.response', requestId: message.requestId, ok: true, value: bootstrap});
        return;
      }
      if (message.type === 'socket.open') {
        if (!bootstrap || message.endpoint !== bootstrap.endpoint || typeof message.socketId !== 'string') {
          throw new Error('socket bootstrap binding이 올바르지 않습니다.');
        }
        if (sockets.has(message.socketId) || sockets.size >= 4) throw new Error('socket limit을 초과했습니다.');
        const socket = new WebSocket(extensionWebSocketUrl(bootstrap.endpoint));
        sockets.set(message.socketId, socket);
        socket.onopen = () => reply({version: EXTENSION_PROTOCOL_VERSION, type: 'socket.opened', socketId: message.socketId});
        socket.onmessage = (event) => {
          if (typeof event.data !== 'string' || event.data.length > MAX_BRIDGE_MESSAGE_CHARS) {
            socket.close(1009, 'message too large');
            return;
          }
          reply({version: EXTENSION_PROTOCOL_VERSION, type: 'socket.message', socketId: message.socketId, data: event.data});
        };
        socket.onerror = () => reply({version: EXTENSION_PROTOCOL_VERSION, type: 'socket.error', socketId: message.socketId});
        socket.onclose = (event) => {
          sockets.delete(message.socketId);
          reply({version: EXTENSION_PROTOCOL_VERSION, type: 'socket.closed', socketId: message.socketId, code: event.code, reason: event.reason});
        };
        return;
      }
      if (message.type === 'socket.send') {
        const socket = sockets.get(message.socketId);
        if (!socket || socket.readyState !== WebSocket.OPEN || typeof message.data !== 'string' || message.data.length > MAX_BRIDGE_MESSAGE_CHARS) {
          throw new Error('socket send가 올바르지 않습니다.');
        }
        socket.send(message.data);
        return;
      }
      if (message.type === 'socket.close') {
        const socket = sockets.get(message.socketId);
        if (socket) socket.close(Number.isSafeInteger(message.code) ? message.code : 1000, typeof message.reason === 'string' ? message.reason.slice(0, 123) : '');
        return;
      }
      throw new Error('지원하지 않는 page message입니다.');
    })().catch(() => {
      if (message?.type === 'bootstrap.request') {
        reply({version: EXTENSION_PROTOCOL_VERSION, type: 'bootstrap.response', requestId: message.requestId, ok: false});
      } else if (typeof message?.socketId === 'string') {
        reply({version: EXTENSION_PROTOCOL_VERSION, type: 'socket.error', socketId: message.socketId});
      }
    });
  });

  port.onDisconnect.addListener(() => {
    contentSessions.delete(session);
    for (const socket of sockets.values()) socket.close(1000, 'Perfetto page closed');
    sockets.clear();
  });
});
