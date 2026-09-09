const VERSION = 1;
const PLUGIN_SOURCE = 'relu-perfetto-plugin';
const EXTENSION_SOURCE = 'relu-perfetto-extension';
const port = chrome.runtime.connect({name: 'relu-perfetto-page-v1'});
let sequence = 0;
const pendingBootstrap = new Map();

function postToPage(message) {
  window.postMessage({source: EXTENSION_SOURCE, version: VERSION, ...message}, window.location.origin);
}

port.onMessage.addListener((message) => {
  if (!message || typeof message !== 'object' || Array.isArray(message) || message.version !== VERSION) return;
  if (message.type === 'bootstrap.response') {
    const nonce = pendingBootstrap.get(message.requestId);
    if (!nonce) return;
    pendingBootstrap.delete(message.requestId);
    postToPage({type: 'bootstrap.response', nonce, ok: message.ok === true, ...(message.ok === true ? {value: message.value} : {})});
    return;
  }
  if (message.type === 'bootstrap.invalidated') {
    postToPage({type: 'bootstrap.invalidated'});
    return;
  }
  if (['socket.opened', 'socket.message', 'socket.error', 'socket.closed'].includes(message.type)) {
    postToPage(message);
  }
});

port.onDisconnect.addListener(() => {
  for (const nonce of pendingBootstrap.values()) {
    postToPage({type: 'bootstrap.response', nonce, ok: false});
  }
  pendingBootstrap.clear();
});

window.addEventListener('message', (event) => {
  if (event.source !== window || event.origin !== window.location.origin) return;
  const message = event.data;
  if (!message || typeof message !== 'object' || Array.isArray(message)
      || message.source !== PLUGIN_SOURCE || message.version !== VERSION) return;
  if (message.type === 'bootstrap.request' && /^[a-f0-9]{32}$/.test(message.nonce)) {
    const requestId = `page_${Date.now()}_${++sequence}`;
    pendingBootstrap.set(requestId, message.nonce);
    port.postMessage({version: VERSION, type: 'bootstrap.request', requestId});
    return;
  }
  if (!/^socket_[a-zA-Z0-9_]{16,128}$/.test(String(message.socketId ?? ''))) return;
  if (message.type === 'socket.open' && typeof message.endpoint === 'string') {
    port.postMessage({version: VERSION, type: 'socket.open', socketId: message.socketId, endpoint: message.endpoint});
  } else if (message.type === 'socket.send' && typeof message.data === 'string' && message.data.length <= 1_048_576) {
    port.postMessage({version: VERSION, type: 'socket.send', socketId: message.socketId, data: message.data});
  } else if (message.type === 'socket.close') {
    port.postMessage({version: VERSION, type: 'socket.close', socketId: message.socketId, code: message.code, reason: message.reason});
  }
});
