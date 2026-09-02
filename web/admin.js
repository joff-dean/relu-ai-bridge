const state = {
  token: '', connectorSessions: [], clients: [], sessions: [], operations: [],
  approvals: { policy: 'manual', pending: [], grants: [], preapprovedScopes: [] },
};
const $ = (selector) => document.querySelector(selector);

function notice(message) {
  const output = $('#notice');
  output.textContent = message;
  output.classList.add('visible');
  window.setTimeout(() => output.classList.remove('visible'), 2600);
}

async function api(path, options = {}) {
  if (!state.token) throw new Error('페어링 토큰을 먼저 입력하세요.');
  const response = await fetch(path, {
    ...options,
    headers: {
      authorization: `Bearer ${state.token}`,
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...options.headers,
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return body;
}

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}

function button(label, handler, className = '') {
  const element = node('button', label, className);
  element.type = 'button';
  element.addEventListener('click', () => Promise.resolve(handler()).catch((error) => {
    notice(error.message);
    if (error.status === 409) refresh().catch(() => {});
  }));
  return element;
}

function renderClients() {
  const root = $('#clients');
  root.replaceChildren();
  root.classList.toggle('empty', state.clients.length === 0);
  if (!state.clients.length) return root.append('연결된 클라이언트가 없습니다.');
  for (const client of state.clients) {
    const card = node('article', undefined, 'card');
    card.append(node('strong', `${client.role ? client.role.toUpperCase() : '미지정'} · trace ${client.traceKey}`));
    card.append(node('div', client.id, 'meta'));
    card.append(node('div', client.sessionId ? `세션: ${client.sessionId}` : '세션 미연결', 'meta'));
    card.append(node('div', `마지막 응답: ${client.lastSeenAt}`, 'meta'));
    root.append(card);
  }
}

function renderConnectorSessions() {
  const root = $('#connector-sessions');
  root.replaceChildren();
  root.classList.toggle('empty', state.connectorSessions.length === 0);
  if (!state.connectorSessions.length) return root.append('연결된 웹서비스가 없습니다.');
  for (const session of state.connectorSessions) {
    const card = node('article', undefined, 'card');
    card.append(node('strong', `${session.active ? '현재 · ' : ''}${session.serviceName}`));
    card.append(node('div', `${session.serviceId} · ${session.sessionKey}`, 'meta'));
    card.append(node('div', `Capabilities: ${session.capabilities.join(', ') || '없음'}`, 'meta'));
    card.append(node('div', `Context 갱신: ${session.contextUpdatedAt}`, 'meta'));
    root.append(card);
  }
}

function renderSessions() {
  const root = $('#sessions');
  root.replaceChildren();
  root.classList.toggle('empty', state.sessions.length === 0);
  if (!state.sessions.length) return root.append('생성된 세션이 없습니다.');
  for (const session of state.sessions) {
    const card = node('article', undefined, 'card');
    card.append(node('strong', session.name));
    card.append(node('div', session.id, 'meta'));
    card.append(node('div', `REF: ${session.refClientId || '미지정'} / DUT: ${session.dutClientId || '미지정'}`, 'meta'));
    const actions = node('div', undefined, 'actions');
    for (const role of ['ref', 'dut']) {
      const select = node('select');
      select.append(new Option(`${role.toUpperCase()} 클라이언트 선택`, ''));
      for (const client of state.clients) select.append(new Option(`trace ${client.traceKey}`, client.id));
      const current = role === 'ref' ? session.refClientId : session.dutClientId;
      if (current) select.value = current;
      const attach = button(`${role.toUpperCase()} 연결`, async () => {
        if (!select.value) throw new Error('클라이언트를 선택하세요.');
        await api(`/api/v1/perfetto/sessions/${session.id}/attach`, {
          method: 'POST', body: JSON.stringify({ role, clientId: select.value }),
        });
        await refresh();
      }, 'secondary');
      actions.append(select, attach);
    }
    card.append(actions);
    root.append(card);
  }
}

function renderApprovals() {
  const trusted = state.approvals.policy === 'trusted_always';
  $('#approval-policy').textContent = trusted
    ? '사내 신뢰 기본값(trusted_always): 항상 허용 가능한 보호 호출은 별도 확인·재시도·개별 grant 없이 실행됩니다. 결과 불명 변경의 판정처럼 once 전용 작업은 계속 확인이 필요합니다.'
    : '수동 정책(manual): 미승인 호출은 아래 요청으로 표시되며 once/session/always/deny 중 허용된 결정을 선택해야 합니다.';
  const root = $('#approvals');
  root.replaceChildren();
  const pending = state.approvals.pending || [];
  root.classList.toggle('empty', pending.length === 0);
  if (!pending.length) root.append('대기 중인 승인이 없습니다.');
  for (const request of pending) {
    const card = node('article', undefined, 'card');
    card.append(node('strong', request.summary));
    card.append(node('div', request.scope, 'meta'));
    card.append(node('div', request.id, 'meta'));
    if (request.displayDetails) card.append(node('pre', JSON.stringify(request.displayDetails, null, 2), 'meta'));
    const actions = node('div', undefined, 'actions');
    const allowed = new Set(request.allowedDecisions || ['once', 'session', 'always', 'deny']);
    for (const [label, decision, className] of [
      ['한 번', 'once', 'secondary'],
      ['현재 세션', 'session', 'secondary'],
      ['항상 허용', 'always', ''],
      ['거부', 'deny', 'danger'],
    ]) {
      if (!allowed.has(decision)) continue;
      const decisionButton = button(label, async () => {
        await api(`/bridge/approvals/${request.id}/decide`, {
          method: 'POST', body: JSON.stringify({ decision }),
        });
        await refresh();
      }, className);
      if (decision === 'session' && !request.sessionId) decisionButton.disabled = true;
      actions.append(decisionButton);
    }
    card.append(actions);
    root.append(card);
  }

  const grantsRoot = $('#grants');
  grantsRoot.replaceChildren();
  const grants = state.approvals.grants || [];
  grantsRoot.classList.toggle('empty', grants.length === 0);
  if (!grants.length) grantsRoot.append(trusted
    ? '정책 기반 자동 허용은 철회할 개별 grant를 만들지 않습니다.'
    : '저장된 권한이 없습니다.');
  for (const grant of grants) {
    const card = node('article', undefined, 'card');
    card.append(node('strong', `${grant.mode} · ${grant.summary || grant.scope}`));
    card.append(node('div', grant.scope, 'meta'));
    card.append(node('div', grant.id, 'meta'));
    if (grant.displayDetails) card.append(node('pre', JSON.stringify(grant.displayDetails, null, 2), 'meta'));
    card.append(button('철회', async () => {
      await api(`/bridge/grants/${grant.id}/revoke`, { method: 'POST', body: '{}' });
      await refresh();
    }, 'danger'));
    grantsRoot.append(card);
  }
}

function renderOperations() {
  const root = $('#operations');
  root.replaceChildren();
  root.classList.toggle('empty', state.operations.length === 0);
  if (!state.operations.length) return root.append('기록된 변경 작업이 없습니다.');
  for (const operation of state.operations) {
    const card = node('article', undefined, 'card');
    card.append(node('strong', `${operation.status} · ${operation.serviceId}.${operation.capability}`));
    card.append(node('div', `${operation.id} · session ${operation.sessionKey}`, 'meta'));
    card.append(node('div', `operationId: ${operation.operationId} · args ${operation.argumentsHash}`, 'meta'));
    card.append(node('div', `late outcome: ${operation.lateOutcome || '없음'} · ${operation.updatedAt}`, 'meta'));
    if (operation.status === 'ambiguous') {
      const actions = node('div', undefined, 'actions');
      actions.append(
        button('적용됨으로 확인', async () => {
          if (!window.confirm('실제 서비스에서 변경이 적용된 것을 확인했습니까? 이 operationId는 다시 실행되지 않습니다.')) return;
          await api(`/api/v1/relu/operations/${operation.id}/reconcile`, {
            method: 'POST', body: JSON.stringify({ decision: 'confirmed_applied' }),
          });
          await refresh();
        }, 'secondary'),
        button('미적용으로 확인', async () => {
          if (!window.confirm('실제 서비스에서 변경이 적용되지 않은 것을 확인했습니까? 이후 새 실행을 허용합니다.')) return;
          await api(`/api/v1/relu/operations/${operation.id}/reconcile`, {
            method: 'POST', body: JSON.stringify({ decision: 'confirmed_not_applied' }),
          });
          await refresh();
        }, 'danger'),
      );
      card.append(actions);
    }
    root.append(card);
  }
}

async function refresh() {
  const [relu, clients, sessions, approvals, operations] = await Promise.all([
    api('/api/v1/relu/sessions'),
    api('/api/v1/perfetto/clients'),
    api('/api/v1/perfetto/sessions'),
    api('/bridge/approvals'),
    api('/api/v1/relu/operations'),
  ]);
  state.connectorSessions = relu.sessions;
  state.clients = clients.clients;
  state.sessions = sessions.sessions;
  state.approvals = approvals;
  state.operations = operations.operations;
  renderConnectorSessions();
  renderClients();
  renderSessions();
  renderApprovals();
  renderOperations();
  $('#connection').textContent = '로컬 서버 연결됨';
  $('#connection').classList.add('ok');
}

$('#connect').addEventListener('click', async () => {
  state.token = $('#token').value.trim();
  sessionStorage.setItem('reluAiBridgeToken', state.token);
  try {
    await refresh();
    notice('연결했습니다.');
  } catch (error) {
    $('#connection').textContent = '연결 실패';
    $('#connection').classList.remove('ok');
    notice(error.message);
  }
});

$('#create-session').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await api('/api/v1/perfetto/sessions', {
      method: 'POST', body: JSON.stringify({ name: $('#session-name').value }),
    });
    $('#session-name').value = '';
    await refresh();
    notice('세션을 생성했습니다.');
  } catch (error) {
    notice(error.message);
    if (error.status === 409) await refresh().catch(() => {});
  }
});

for (const element of document.querySelectorAll('[data-refresh]')) {
  element.addEventListener('click', () => refresh().catch((error) => notice(error.message)));
}

state.token = sessionStorage.getItem('reluAiBridgeToken') || '';
$('#token').value = state.token;
if (state.token) refresh().catch((error) => notice(error.message));
