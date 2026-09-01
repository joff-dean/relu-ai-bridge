(() => {
  const state = {
    clientId: sessionStorage.getItem('relu-ai-bridge-client-id') || `client_${crypto.randomUUID()}`,
    conversationId: null,
    sessionId: null,
    role: 'prime',
    primeId: null,
    workerId: null,
    resumeSessionId: null,
    cursor: 0,
    registeredUrl: null,
    sentMessages: new Set(),
    lastEndedSignature: null,
    handoffSessionId: null,
    estimatedTokens: 0,
    goal: null,
    stopped: false,
  };
  sessionStorage.setItem('relu-ai-bridge-client-id', state.clientId);

  function request(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
        if (!response?.ok) return reject(new Error(response?.error ?? 'Extension request failed'));
        resolve(response.value);
      });
    });
  }

  const localApi = (path, options) => request({ type: 'api', path, options });

  function conversationId() {
    const match = location.pathname.match(/^\/c\/([^/?#]+)/);
    return match?.[1] ?? `new:${state.clientId}`;
  }

  function badge() {
    let element = document.getElementById('relu-ai-bridge-badge');
    if (!element) {
      element = document.createElement('div');
      element.id = 'relu-ai-bridge-badge';
      element.innerHTML = '<span class="status">RELU 연결 중</span><button type="button">Compact</button>';
      element.querySelector('button').addEventListener('click', async () => {
        try {
          await localApi('/bridge/compact', { method: 'POST', body: { sessionId: state.sessionId } });
          updateBadge('handoff 요청됨');
        } catch (error) {
          updateBadge(error.message, true);
        }
      });
      document.documentElement.appendChild(element);
    }
    return element;
  }

  function updateBadge(text, error = false) {
    const element = badge();
    element.dataset.state = error ? 'error' : 'ok';
    element.querySelector('.status').textContent = text;
  }

  function applyInitialPayload(payload) {
    state.role = payload.role ?? (payload.workerId ? 'worker' : 'prime');
    state.primeId = payload.primeId ?? null;
    state.workerId = payload.workerId ?? null;
    state.resumeSessionId = payload.sessionId ?? null;
    if (payload.message) setTimeout(() => void sendPrompt(payload.message), 300);
  }

  async function claimInitialPayload() {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const payload = await request({ type: 'initial.claim' }).catch(() => null);
      if (payload) {
        applyInitialPayload(payload);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  async function register(force = false) {
    const currentId = conversationId();
    if (!force && state.registeredUrl === location.href && state.conversationId === currentId) return;
    state.conversationId = currentId;
    const value = await localApi('/bridge/register', {
      method: 'POST',
      body: {
        clientId: state.clientId,
        conversationId: currentId,
        url: location.href,
        title: document.title,
        role: state.role,
        primeId: state.primeId,
        workerId: state.workerId,
        resumeSessionId: state.resumeSessionId,
      },
    });
    state.sessionId = value.sessionId;
    state.estimatedTokens = value.estimatedTokens ?? 0;
    state.goal = value.goal ?? null;
    state.registeredUrl = location.href;
    updateBadge(`RELU · ${Math.round(state.estimatedTokens / 1000)}k`);
  }

  function messageNodes() {
    return [...document.querySelectorAll('[data-message-author-role]')];
  }

  function messageText(node) {
    return (node.innerText ?? node.textContent ?? '').trim();
  }

  function signature(text) {
    let hash = 2166136261;
    for (let i = 0; i < text.length; i += 1) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
    return `${text.length}:${hash >>> 0}`;
  }

  function isGenerating() {
    return Boolean(document.querySelector('button[data-testid="stop-button"], button[aria-label*="Stop"], button[aria-label*="중지"]'));
  }

  async function captureMessages() {
    await register();
    const nodes = messageNodes();
    for (let index = 0; index < nodes.length; index += 1) {
      const node = nodes[index];
      const role = node.getAttribute('data-message-author-role');
      if (!['user', 'assistant'].includes(role)) continue;
      const text = messageText(node);
      if (!text) continue;
      const messageId = node.getAttribute('data-message-id') || `${role}:${index}:${signature(text)}`;
      if (state.sentMessages.has(messageId)) continue;
      state.sentMessages.add(messageId);
      const result = await localApi('/bridge/events', {
        method: 'POST',
        body: { conversationId: state.conversationId, messageId, type: 'message', role, text },
      });
      state.estimatedTokens = result.estimatedTokens ?? state.estimatedTokens;
    }
    const last = [...nodes].reverse().find((node) => node.getAttribute('data-message-author-role') === 'assistant');
    if (!last || isGenerating()) return;
    const text = messageText(last);
    const ended = signature(text);
    if (!text || ended === state.lastEndedSignature) return;
    await new Promise((resolve) => setTimeout(resolve, 1400));
    if (isGenerating() || messageText(last) !== text) return;
    state.lastEndedSignature = ended;
    const result = await localApi('/bridge/events', {
      method: 'POST',
      body: { conversationId: state.conversationId, messageId: `end:${ended}`, type: 'response_end', role: 'assistant', text },
    });
    state.estimatedTokens = result.estimatedTokens ?? state.estimatedTokens;
    updateBadge(`RELU · ${Math.round(state.estimatedTokens / 1000)}k`);
    if (state.handoffSessionId && text.includes('[HANDOFF_READY]')) {
      const sessionId = state.handoffSessionId;
      state.handoffSessionId = null;
      await localApi('/bridge/handoff', { method: 'POST', body: { sessionId, handoff: text } });
    }
    if (state.role === 'worker' && /\[(WORKER_DONE|작업_완료)\]/.test(text)) {
      await localApi('/bridge/worker/report', {
        method: 'POST',
        body: { primeId: state.primeId, workerId: state.workerId, result: text, status: 'complete' },
      });
    }
  }

  function composer() {
    return document.querySelector('#prompt-textarea')
      || document.querySelector('textarea[data-id="root"]')
      || document.querySelector('textarea')
      || document.querySelector('[contenteditable="true"]');
  }

  async function sendPrompt(text) {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const input = composer();
      if (!input) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        continue;
      }
      input.focus();
      if (input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement) {
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')?.set;
        setter?.call(input, text);
      } else {
        input.textContent = text;
      }
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      await new Promise((resolve) => setTimeout(resolve, 300));
      const send = document.querySelector('button[data-testid="send-button"]')
        || document.querySelector('button[aria-label*="Send"], button[aria-label*="보내기"]');
      if (send && !send.disabled) send.click();
      else input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
      return;
    }
    throw new Error('ChatGPT composer was not found');
  }

  async function handleCommand(command) {
    if (command.conversationId && command.conversationId !== state.conversationId) return false;
    if (command.targetClientId && command.targetClientId !== state.clientId) return false;
    const claim = await request({ type: 'command.claim', commandId: command.id });
    if (!claim.claimed) return false;
    if (command.type === 'send_message') await sendPrompt(command.message);
    else if (command.type === 'request_handoff') {
      state.handoffSessionId = command.sessionId;
      await sendPrompt(command.message);
    } else if (command.type === 'open_worker') {
      await request({
        type: 'chat.open',
        payload: { role: 'worker', primeId: command.primeId, workerId: command.workerId, message: command.message },
      });
    } else if (command.type === 'message_worker') {
      await request({
        type: 'chat.open',
        payload: {
          role: 'worker',
          primeId: command.primeId,
          workerId: command.workerId,
          conversationUrl: command.conversationUrl,
          message: command.message,
        },
      });
    } else if (command.type === 'open_resumed_chat') {
      await request({ type: 'chat.open', payload: { role: 'prime', sessionId: command.sessionId, message: command.message } });
    } else return false;
    await localApi(`/bridge/commands/${command.id}/ack`, { method: 'POST', body: { status: 'ok' } });
    return true;
  }

  async function pollCommands() {
    const result = await localApi(`/bridge/commands?clientId=${encodeURIComponent(state.clientId)}&after=${state.cursor}`);
    for (const command of result.commands ?? []) {
      state.cursor = Math.max(state.cursor, command.cursor);
      try {
        await handleCommand(command);
      } catch (error) {
        await localApi(`/bridge/commands/${command.id}/ack`, {
          method: 'POST',
          body: { status: 'failed', error: error.message },
        }).catch(() => {});
      }
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'context.get') {
      sendResponse({
        clientId: state.clientId,
        conversationId: state.conversationId,
        sessionId: state.sessionId,
        estimatedTokens: state.estimatedTokens,
        goal: state.goal,
      });
    }
    if (message?.type === 'initial.deliver') {
      applyInitialPayload(message.payload);
      sendResponse({ accepted: true });
    }
  });

  let captureTimer;
  const observer = new MutationObserver(() => {
    clearTimeout(captureTimer);
    captureTimer = setTimeout(() => void captureMessages().catch((error) => updateBadge(error.message, true)), 500);
  });

  async function start() {
    badge();
    await claimInitialPayload();
    await register(true);
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    await captureMessages();
    setInterval(() => {
      if (location.href !== state.registeredUrl) void register(true).catch((error) => updateBadge(error.message, true));
      void pollCommands().catch((error) => updateBadge(error.message, true));
    }, 1500);
  }

  void start().catch((error) => updateBadge(error.message, true));
})();
