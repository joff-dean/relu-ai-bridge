const elements = Object.fromEntries([
  'baseUrl', 'token', 'enabled', 'save', 'status', 'context', 'goal', 'saveGoal', 'startGoal', 'compact', 'refresh', 'approvalPolicy', 'pending', 'grants', 'toast',
].map((id) => [id, document.getElementById(id)]));

function request(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
      if (!response?.ok) return reject(new Error(response?.error ?? 'Extension request failed'));
      resolve(response.value);
    });
  });
}

async function contentContext() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url?.startsWith('https://chatgpt.com/')) return null;
  return new Promise((resolve) => chrome.tabs.sendMessage(tab.id, { type: 'context.get' }, (value) => {
    if (chrome.runtime.lastError) return resolve(null);
    resolve(value ?? null);
  }));
}

function toast(message) {
  elements.toast.textContent = message;
  setTimeout(() => { if (elements.toast.textContent === message) elements.toast.textContent = ''; }, 5000);
}

function setStatus(text, state = '') {
  elements.status.textContent = text;
  elements.status.className = `status ${state}`;
}

async function api(path, options) {
  return request({ type: 'api', path, options });
}

async function checkConnection() {
  try {
    await api('/bridge/approvals');
    setStatus('연결됨', 'ok');
    return true;
  } catch (error) {
    setStatus('연결 안 됨', 'error');
    toast(error.message);
    return false;
  }
}

function actionButton(label, handler, className = '') {
  const button = document.createElement('button');
  button.textContent = label;
  button.className = className;
  button.addEventListener('click', () => void handler().catch((error) => toast(error.message)));
  return button;
}

async function loadApprovals() {
  const data = await api('/bridge/approvals');
  const trusted = data.policy === 'trusted_always';
  elements.approvalPolicy.textContent = trusted
    ? '사내 신뢰 기본값: 항상 허용 가능한 호출은 별도 승인이나 개별 grant 없이 실행됩니다. once 전용 안전 확인은 유지됩니다.'
    : '수동 정책: 한 번, 현재 세션, 항상 허용 또는 거부를 선택합니다.';
  elements.pending.replaceChildren();
  if (!data.pending.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = '대기 중인 승인 없음';
    elements.pending.appendChild(empty);
  }
  for (const item of data.pending) {
    const card = document.createElement('div');
    card.className = 'approval';
    const summary = document.createElement('div');
    summary.textContent = item.summary;
    const scope = document.createElement('code');
    scope.textContent = item.scope;
    const details = document.createElement('pre');
    details.className = 'approval-details';
    details.textContent = JSON.stringify(item.displayDetails ?? {}, null, 2);
    const actions = document.createElement('div');
    actions.className = 'actions';
    const decide = async (decision) => {
      await api(`/bridge/approvals/${item.id}/decide`, { method: 'POST', body: { decision } });
      toast(decision === 'always' ? '항상 허용으로 저장했습니다.' : '승인 결정을 저장했습니다.');
      await loadApprovals();
    };
    const allowed = new Set(item.allowedDecisions ?? ['once', 'session', 'always', 'deny']);
    if (allowed.has('once')) actions.append(actionButton('한 번', () => decide('once')));
    if (allowed.has('session')) actions.append(actionButton('현재 세션', () => decide('session'), 'secondary'));
    if (allowed.has('always')) actions.append(actionButton('항상 허용', () => decide('always')));
    if (allowed.has('deny')) actions.append(actionButton('거부', () => decide('deny'), 'danger'));
    card.append(summary, scope, details, actions);
    elements.pending.appendChild(card);
  }

  elements.grants.replaceChildren();
  const grants = [...data.grants, ...data.preapprovedScopes.map((scope) => ({ id: null, scope, mode: 'config' }))];
  if (!grants.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = trusted ? '정책 기반 자동 허용 · 개별 철회 대상 없음' : '저장된 권한 없음';
    elements.grants.appendChild(empty);
  }
  for (const item of grants) {
    const card = document.createElement('div');
    card.className = 'grant';
    const text = document.createElement('div');
    const mode = item.mode === 'always' ? '항상 허용' : item.mode === 'session' ? '세션 허용' : item.mode === 'config' ? '설정에서 사전 승인' : '한 번 허용';
    text.textContent = item.summary ? `${mode} · ${item.summary}` : mode;
    const scope = document.createElement('code');
    scope.textContent = item.scope;
    card.append(text, scope);
    if (item.displayDetails) {
      const details = document.createElement('pre');
      details.className = 'approval-details';
      details.textContent = JSON.stringify(item.displayDetails, null, 2);
      card.append(details);
    }
    if (item.id) card.append(actionButton('철회', async () => {
      await api(`/bridge/grants/${item.id}/revoke`, { method: 'POST', body: {} });
      await loadApprovals();
    }, 'danger'));
    elements.grants.appendChild(card);
  }
}

async function initialize() {
  const settings = await request({ type: 'settings.get' });
  elements.baseUrl.value = settings.baseUrl;
  elements.token.value = settings.token;
  elements.enabled.checked = settings.enabled;
  const context = await contentContext();
  window.currentContext = context;
  elements.context.textContent = context
    ? `세션 ${context.sessionId ?? '등록 중'} · 약 ${Math.round((context.estimatedTokens ?? 0) / 1000)}k tokens`
    : '활성 ChatGPT 대화가 없습니다.';
  elements.goal.value = context?.goal ?? '';
  if (await checkConnection()) {
    if (context?.conversationId) {
      const serverState = await api(`/bridge/state?conversationId=${encodeURIComponent(context.conversationId)}`);
      elements.goal.value = serverState?.goal ?? '';
    }
    await loadApprovals();
  }
}

elements.save.addEventListener('click', () => void (async () => {
  await request({
    type: 'settings.save',
    value: { baseUrl: elements.baseUrl.value.trim(), token: elements.token.value.trim(), enabled: elements.enabled.checked },
  });
  if (await checkConnection()) {
    toast('연결 정보를 저장했습니다.');
    await loadApprovals();
  }
})().catch((error) => toast(error.message)));

elements.saveGoal.addEventListener('click', () => void (async () => {
  const context = window.currentContext ?? await contentContext();
  if (!context?.conversationId) throw new Error('활성 ChatGPT 대화가 없습니다.');
  await api('/bridge/goal', { method: 'POST', body: { conversationId: context.conversationId, goal: elements.goal.value.trim() } });
  toast(elements.goal.value.trim() ? '지속 목표를 저장했습니다.' : '지속 목표를 해제했습니다.');
})().catch((error) => toast(error.message)));

elements.startGoal.addEventListener('click', () => void (async () => {
  const context = window.currentContext ?? await contentContext();
  if (!context?.conversationId) throw new Error('활성 ChatGPT 대화가 없습니다.');
  const goal = elements.goal.value.trim();
  if (!goal) throw new Error('시작할 목표를 입력하십시오.');
  await api('/bridge/goal/start', { method: 'POST', body: { conversationId: context.conversationId, goal } });
  toast('목표를 저장하고 첫 작업 메시지를 예약했습니다.');
})().catch((error) => toast(error.message)));

elements.compact.addEventListener('click', () => void (async () => {
  const context = window.currentContext ?? await contentContext();
  if (!context?.sessionId) throw new Error('등록된 세션이 없습니다.');
  await api('/bridge/compact', { method: 'POST', body: { sessionId: context.sessionId } });
  toast('현재 대화에 handoff 작성을 요청했습니다.');
})().catch((error) => toast(error.message)));

elements.refresh.addEventListener('click', () => void loadApprovals().catch((error) => toast(error.message)));
void initialize().catch((error) => { setStatus('오류', 'error'); toast(error.message); });
