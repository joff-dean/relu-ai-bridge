import { evaluateGoal } from './goal.mjs';
import { randomId } from './utils.mjs';

export class BrowserBridge {
  constructor(config, sessions, agents, approvals, audit) {
    this.config = config;
    this.sessions = sessions;
    this.agents = agents;
    this.approvals = approvals;
    this.audit = audit;
    this.clients = new Map();
    this.seenMessages = new Set();
  }

  async register(input) {
    const clientId = String(input.clientId ?? randomId('browser_client_')).slice(0, 128);
    const conversationId = String(input.conversationId ?? '').slice(0, 256);
    if (!conversationId) throw new Error('conversationId is required');
    this.clients.set(clientId, {
      clientId,
      conversationId,
      url: input.url,
      lastSeenAt: Date.now(),
    });
    const session = input.resumeSessionId
      ? await this.sessions.rebind(input.resumeSessionId, { conversationId, url: input.url })
      : await this.sessions.getOrCreateForConversation({
        conversationId,
        conversationUrl: input.url,
        title: input.title,
        role: input.role,
        primeId: input.primeId,
      });
    if (input.role === 'worker' && input.primeId && input.workerId) {
      await this.agents.registerWorker({
        primeId: input.primeId,
        workerId: input.workerId,
        conversationId,
        conversationUrl: input.url,
      });
    }
    return {
      clientId,
      sessionId: session.id,
      goal: session.goal,
      estimatedTokens: session.estimatedTokens,
      compactThreshold: 400_000,
    };
  }

  async recordEvent(input) {
    const session = await this.sessions.findByConversation(input.conversationId);
    if (!session) throw new Error('Conversation is not registered');
    if (input.messageId) {
      const key = `${session.id}:${input.messageId}`;
      if (this.seenMessages.has(key)) return { duplicate: true };
      this.seenMessages.add(key);
      if (this.seenMessages.size > 10_000) this.seenMessages.clear();
    }
    const updated = await this.sessions.appendEvent(session.id, {
      type: input.type ?? 'message',
      role: input.role,
      text: input.text,
      metadata: input.metadata,
    });
    await this.audit.append({ category: 'browser', action: input.type ?? 'message', sessionId: session.id, role: input.role });
    let goalDecision = null;
    if (input.type === 'response_end' && updated.goal && updated.role !== 'worker') {
      goalDecision = await evaluateGoal(this.config, updated);
      if (goalDecision.status === 'continue') {
        await this.sessions.incrementGoalTurn(updated.id);
        await this.agents.enqueue({
          type: 'send_message',
          conversationId: updated.conversationId,
          message: goalDecision.message,
        });
      }
    }
    return {
      sessionId: updated.id,
      estimatedTokens: updated.estimatedTokens,
      recorded: this.sessions.recordsBrowserEvents(),
      goalDecision,
    };
  }

  async requestCompact(input) {
    const session = input.sessionId ? await this.sessions.get(input.sessionId) : await this.sessions.findByConversation(input.conversationId);
    if (!session) throw new Error('Session not found');
    const command = await this.agents.enqueue({
      type: 'request_handoff',
      conversationId: session.conversationId,
      sessionId: session.id,
      message: 'Create a concise but complete handoff for a new chat. Include the goal, completed work, changed files, validation results, unresolved problems, and the exact next action. End with [HANDOFF_READY].',
    });
    return { sessionId: session.id, commandId: command.id };
  }

  async completeHandoff(input) {
    const session = await this.sessions.get(input.sessionId);
    await this.sessions.saveHandoff(session.id, input.handoff);
    const command = await this.agents.enqueue({
      type: 'open_resumed_chat',
      sessionId: session.id,
      message: `Continue this existing work from the following trusted handoff. Verify repository state before changing anything.\n\n${input.handoff}`,
    });
    return { sessionId: session.id, commandId: command.id };
  }

  async handle(method, pathname, query, body) {
    if (method === 'POST' && pathname === '/bridge/register') return this.register(body ?? {});
    if (method === 'POST' && pathname === '/bridge/events') return this.recordEvent(body ?? {});
    if (method === 'GET' && pathname === '/bridge/commands') {
      return { commands: this.agents.poll(query.get('clientId'), Number(query.get('after') ?? 0)) };
    }
    if (method === 'POST' && pathname.startsWith('/bridge/commands/') && pathname.endsWith('/ack')) {
      const id = pathname.split('/')[3];
      return this.agents.acknowledge(id, body ?? {});
    }
    if (method === 'POST' && pathname === '/bridge/compact') return this.requestCompact(body ?? {});
    if (method === 'POST' && pathname === '/bridge/handoff') return this.completeHandoff(body ?? {});
    if (method === 'POST' && pathname === '/bridge/goal') {
      const session = body?.sessionId
        ? await this.sessions.get(body.sessionId)
        : await this.sessions.findByConversation(body?.conversationId);
      if (!session) throw new Error('Session not found');
      return this.sessions.setGoal(session.id, body?.goal || null);
    }
    if (method === 'POST' && pathname === '/bridge/goal/start') {
      const session = body?.sessionId
        ? await this.sessions.get(body.sessionId)
        : await this.sessions.findByConversation(body?.conversationId);
      if (!session) throw new Error('Session not found');
      const goal = String(body?.goal ?? '').trim();
      if (!goal) throw new Error('Goal is required');
      await this.sessions.setGoal(session.id, goal);
      const command = await this.agents.enqueue({
        type: 'send_message',
        conversationId: session.conversationId,
        message: `Work autonomously toward this goal:\n\n${goal}\n\nUse the available tools, verify the result, and continue until complete. When the whole goal is complete, end your final answer with [GOAL_COMPLETE].`,
      });
      return { sessionId: session.id, commandId: command.id, goal };
    }
    if (method === 'POST' && pathname === '/bridge/worker/report') return this.agents.report(body ?? {});
    if (method === 'GET' && pathname === '/bridge/approvals') return this.approvals.list();
    if (method === 'POST' && pathname.startsWith('/bridge/approvals/') && pathname.endsWith('/decide')) {
      const id = pathname.split('/')[3];
      return this.approvals.decide(id, body?.decision);
    }
    if (method === 'POST' && pathname.startsWith('/bridge/grants/') && pathname.endsWith('/revoke')) {
      const id = pathname.split('/')[3];
      return this.approvals.revoke(id);
    }
    if (method === 'GET' && pathname === '/bridge/state') {
      const session = await this.sessions.findByConversation(query.get('conversationId'));
      return session ? { sessionId: session.id, goal: session.goal, estimatedTokens: session.estimatedTokens } : null;
    }
    const error = new Error('Bridge endpoint not found');
    error.statusCode = 404;
    throw error;
  }
}
