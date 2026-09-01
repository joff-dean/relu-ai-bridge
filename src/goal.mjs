import { truncateUtf8 } from './utils.mjs';

const MAX_REMOTE_GOAL_BYTES = 16 * 1024;
const MAX_REMOTE_TRANSCRIPT_EVENT_BYTES = 8 * 1024;
const MAX_REMOTE_RESPONSE_BYTES = 64 * 1024;
const MAX_REMOTE_DECISION_FIELD_BYTES = 8 * 1024;

async function readBoundedResponse(response, maxBytes) {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error('Goal evaluator response exceeds the configured safety limit');
  }
  if (!response.body?.getReader) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes) throw new Error('Goal evaluator response exceeds the configured safety limit');
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > maxBytes) {
        await reader.cancel('response limit exceeded').catch(() => {});
        throw new Error('Goal evaluator response exceeds the configured safety limit');
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function boundedDecisionText(value, fallback = '') {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string') throw new Error('Goal evaluator returned an invalid decision field');
  return truncateUtf8(value, MAX_REMOTE_DECISION_FIELD_BYTES).text;
}

function lastAssistantText(session) {
  return [...session.events].reverse().find((event) => event.role === 'assistant')?.text ?? '';
}

function localDecision(config, session) {
  const answer = lastAssistantText(session);
  const completed = config.goal.completionMarkers.some((marker) => answer.includes(marker));
  if (completed) return { status: 'complete', reason: 'The assistant emitted an explicit completion marker.' };
  if (session.goalTurns >= config.limits.maxGoalTurns) {
    return { status: 'stopped', reason: `Maximum goal turns (${config.limits.maxGoalTurns}) reached.` };
  }
  return {
    status: 'continue',
    reason: 'No explicit completion marker was found.',
    message: config.goal.continuePrompt,
  };
}

async function remoteDecision(config, session) {
  const apiKey = config.goal.apiKeyValue ?? process.env[config.goal.apiKeyEnv];
  if (!config.goal.endpoint || !config.goal.model || !apiKey) {
    throw new Error('Remote goal evaluator requires goal.endpoint, goal.model, and the configured API key environment variable');
  }
  const transcript = session.events
    .filter((event) => event.type === 'message' && ['user', 'assistant'].includes(event.role))
    .slice(-40)
    .map((event) => ({
      role: event.role,
      content: truncateUtf8(event.text, MAX_REMOTE_TRANSCRIPT_EVENT_BYTES).text,
    }));
  const response = await fetch(config.goal.endpoint, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: config.goal.model,
      messages: [
        {
          role: 'system',
          content: 'Decide whether the stated goal is fully complete. Return only JSON: {"status":"complete"|"continue","reason":"...","message":"..."}. Never include secrets or tool outputs.',
        },
        {
          role: 'user',
          content: JSON.stringify({
            goal: truncateUtf8(session.goal, MAX_REMOTE_GOAL_BYTES).text,
            transcript,
          }),
        },
      ],
      response_format: { type: 'json_object' },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Goal evaluator returned HTTP ${response.status}`);
  const contentType = String(response.headers.get('content-type') ?? '').toLowerCase();
  if (!contentType.includes('application/json') && !contentType.includes('+json')) {
    throw new Error('Goal evaluator must return JSON');
  }
  const bytes = await readBoundedResponse(response, MAX_REMOTE_RESPONSE_BYTES);
  let payload;
  try {
    payload = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('Goal evaluator returned invalid JSON');
  }
  const raw = payload.choices?.[0]?.message?.content ?? payload.output_text;
  let decision;
  try {
    decision = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    throw new Error('Goal evaluator returned invalid decision JSON');
  }
  if (!['complete', 'continue'].includes(decision?.status)) throw new Error('Goal evaluator returned an invalid status');
  const normalized = {
    status: decision.status,
    reason: boundedDecisionText(decision.reason, 'No reason supplied.'),
  };
  if (decision.status === 'continue') {
    // The remote evaluator may decide only complete vs. continue. It never
    // controls the next instruction sent to the browser conversation.
    normalized.message = config.goal.continuePrompt;
  }
  return normalized;
}

export async function evaluateGoal(config, session) {
  if (!config.permissions.goalLoop) throw new Error('Goal loop is disabled');
  if (!session.goal) return { status: 'stopped', reason: 'No goal is configured for this session.' };
  if (config.goal.mode === 'local') return localDecision(config, session);
  if (config.goal.mode === 'remote') return remoteDecision(config, session);
  throw new Error(`Unsupported goal mode: ${config.goal.mode}`);
}
