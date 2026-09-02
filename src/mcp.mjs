import crypto from 'node:crypto';
import { ApprovalRequiredError } from './approvals.mjs';
import { errorMessage, randomId } from './utils.mjs';
import { createPerfettoToolDefinitions, PerfettoTools } from './perfetto-tools.mjs';
import { createReluToolDefinitions, ReluTools } from './relu-tools.mjs';
import { validateJsonSchema } from './json-schema.mjs';

const objectSchema = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const string = (description) => ({ type: 'string', description });
const MAX_MCP_SESSIONS = 1024;
const MCP_SESSION_IDLE_TTL_MS = 24 * 60 * 60_000;

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function argumentsHash(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function rootPolicyHash(config, rootId) {
  const root = config.roots.find((item) => item.id === rootId);
  if (!root) return argumentsHash({ missingRootId: rootId });
  return argumentsHash({
    id: root.id,
    path: root.path,
    readOnly: root.readOnly,
    protectedPaths: [...root.protectedPaths].sort(),
  });
}

function commandPolicyHash(config, args) {
  const commandName = args.profile ?? args.program ?? 'unknown';
  const policy = args.profile
    ? { type: 'profile', name: args.profile, definition: config.commandProfiles[args.profile] ?? null }
    : { type: 'arbitrary', program: args.program ?? null, enabled: config.permissions.allowArbitraryCommands };
  return {
    commandName,
    hash: argumentsHash({ root: rootPolicyHash(config, args.rootId), policy }),
  };
}

function tool(name, description, inputSchema, annotations = {}) {
  return { name, description, inputSchema, annotations };
}

export function createToolDefinitions(config) {
  const definitions = [
    ...createReluToolDefinitions(config),
    ...createPerfettoToolDefinitions(config),
    tool('workspace_roots', 'List approved local project roots and whether each root is read-only.', objectSchema(), { readOnlyHint: true }),
    tool('list_files', 'List regular files below an approved project root. Symlinks and common generated directories are skipped.', objectSchema({
      rootId: string('Approved root id.'),
      limit: { type: 'integer', minimum: 1, maximum: 5000 },
    }, ['rootId']), { readOnlyHint: true }),
    tool('read_file', 'Read one bounded UTF-8 text file inside an approved project root. Binary files are rejected to preserve credential redaction.', objectSchema({
      rootId: string('Approved root id.'),
      path: string('Relative path below the root.'),
    }, ['rootId', 'path']), { readOnlyHint: true }),
    tool('search_files', 'Search text files inside an approved root and return matching lines.', objectSchema({
      rootId: string('Approved root id.'),
      query: string('Literal text to search for.'),
      pathPrefix: string('Optional relative path prefix.'),
      caseSensitive: { type: 'boolean' },
      maxResults: { type: 'integer', minimum: 1, maximum: config.limits.maxSearchResults },
    }, ['rootId', 'query']), { readOnlyHint: true }),
    tool('apply_edits', 'Apply an atomic, bounded multi-file text edit transaction inside one approved root. Existing text must match exactly. A persistent local approval can suppress repeated prompts for the same root.', objectSchema({
      rootId: string('Approved root id.'),
      edits: {
        type: 'array',
        minItems: 1,
        maxItems: 100,
        items: objectSchema({
          path: string('Relative file path.'),
          create: { type: 'boolean', description: 'Create a new file; fails if it exists.' },
          oldText: string('Exact text to replace for an existing file.'),
          newText: string('Replacement or new file content.'),
          expectedOccurrences: { type: 'integer', minimum: 1, maximum: 1000 },
        }, ['path', 'newText']),
      },
    }, ['rootId', 'edits']), { readOnlyHint: false, destructiveHint: true }),
    tool('inspect_diff', 'Return the current git diff for an approved root without modifying the repository.', objectSchema({
      rootId: string('Approved root id.'),
      paths: { type: 'array', items: { type: 'string' }, maxItems: 100 },
    }, ['rootId']), { readOnlyHint: true }),
    tool('run_command', 'Run a configured command profile, or an arbitrary executable only when explicitly enabled. Persistent approval is scoped to root and command profile.', objectSchema({
      rootId: string('Approved root id.'),
      profile: string('Configured command profile name.'),
      extraArgs: { type: 'array', items: { type: 'string' }, maxItems: 100 },
      cwd: string('Relative working directory below the approved root.'),
      program: string('Bare executable name; only allowed when arbitrary commands are enabled.'),
      args: { type: 'array', items: { type: 'string' }, maxItems: 100 },
      timeoutMs: { type: 'integer', minimum: 1 },
      interactive: { type: 'boolean' },
    }, ['rootId']), { readOnlyHint: false, destructiveHint: true }),
    tool('write_stdin', 'Write to, poll, close, or terminate a previously started interactive command session.', objectSchema({
      sessionId: string('Command session id.'),
      chars: string('Characters to write to stdin.'),
      closeStdin: { type: 'boolean' },
      terminate: { type: 'boolean' },
    }, ['sessionId']), { readOnlyHint: false, destructiveHint: true }),
    tool('session', 'Manage locally recorded browser conversations, goals, and Compact & Resume.', objectSchema({
      action: { type: 'string', enum: ['list', 'read', 'current', 'set_goal', 'clear_goal', 'compact'] },
      sessionId: string('Session id for read, goal, or compact actions.'),
      goal: string('Specific durable goal.'),
    }, ['action']), { readOnlyHint: false }),
    tool('agents', 'Manage durable prime/worker ChatGPT browser conversations. Worker routing is performed by the local Chrome extension.', objectSchema({
      action: { type: 'string', enum: ['status', 'spawn', 'message', 'report', 'clear'] },
      primeId: string('Stable prime conversation id; defaults to the active conversation.'),
      workerId: string('Worker id.'),
      label: string('Short worker label.'),
      task: string('Initial worker task.'),
      message: string('Follow-up worker message.'),
      result: string('Worker result.'),
      status: { type: 'string', enum: ['complete', 'failed'] },
      clientId: string('Optional browser client id.'),
    }, ['action']), { readOnlyHint: false, openWorldHint: true }),
    tool('approval_status', 'Show the active local approval policy, exceptional pending requests, and active manual grants.', objectSchema(), { readOnlyHint: true }),
  ];
  return definitions;
}

function success(value) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
    isError: false,
  };
}

function failure(error) {
  const value = error instanceof ApprovalRequiredError
    ? { error: error.code, message: error.message, approval: error.request }
    : { error: 'TOOL_ERROR', message: errorMessage(error) };
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
    isError: true,
  };
}

export class McpService {
  constructor(context) {
    this.context = context;
    this.definitions = createToolDefinitions(context.config);
    this.definitionMap = new Map(this.definitions.map((definition) => [definition.name, definition]));
    this.perfettoTools = new PerfettoTools(context);
    this.reluTools = new ReluTools(context, this.perfettoTools);
    this.sessions = new Map();
  }

  async initialize() {
    const cutoff = Date.now() - MCP_SESSION_IDLE_TTL_MS;
    const expired = [];
    for (const [id, session] of this.sessions) {
      if (session.lastSeenAt < cutoff) {
        this.sessions.delete(id);
        expired.push(id);
      }
    }
    await Promise.all(expired.map((id) => this.context.approvals.revokeSession(id)));
    if (this.sessions.size >= MAX_MCP_SESSIONS) {
      const error = new Error('MCP session capacity reached; close or wait for an idle session to expire');
      error.code = -32002;
      throw error;
    }
    const sessionId = randomId('mcp_');
    this.sessions.set(sessionId, { createdAt: Date.now(), lastSeenAt: Date.now() });
    const approvalInstruction = this.context.config.approvals.policy === 'trusted_always'
      ? 'The trusted local policy automatically permits always-eligible protected calls without creating grants. Once-only safety interlocks still require a local decision.'
      : 'Protected calls can require a locally revocable once/session/always approval.';
    return {
      sessionId,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'relu-ai-bridge', version: '0.5.0' },
        instructions: `Start with list_sessions, then get_context and list_capabilities. Use execute only with a listed server-authoritative capability. Perfetto is Connector #1 and retains dedicated bounded SQL and REF/DUT tools. ${approvalInstruction} Never request secrets, arbitrary URLs, methods, headers, scripts, selectors, commands, or approval bypasses.`,
      },
    };
  }

  async sessionAction(args, requestContext = {}) {
    const { sessions, agents, approvals } = this.context;
    if (args.action === 'list') return sessions.list();
    if (args.action === 'current') {
      const current = await sessions.findByConversation(sessions.activeConversationId);
      return current ?? { session: null };
    }
    if (!args.sessionId) throw new Error('sessionId is required');
    if (args.action === 'read') return sessions.get(args.sessionId);
    if (args.action === 'set_goal' || args.action === 'clear_goal') {
      await approvals.require({
        scope: `session.goal:${args.sessionId}`,
        summary: `${args.action === 'set_goal' ? 'Set' : 'clear'} the durable goal for session ${args.sessionId}`,
        details: { action: args.action, goal: args.goal ?? null },
        sessionId: requestContext.mcpSessionId ?? null,
      });
      return sessions.setGoal(args.sessionId, args.action === 'set_goal' ? args.goal : null);
    }
    if (args.action === 'compact') {
      await approvals.require({
        scope: `session.compact:${args.sessionId}`,
        summary: `Open a replacement ChatGPT conversation for session ${args.sessionId}`,
        details: { action: args.action },
        sessionId: requestContext.mcpSessionId ?? null,
      });
      return this.context.bridge.requestCompact({ sessionId: args.sessionId });
    }
    throw new Error('Unsupported session action');
  }

  async agentAction(args, requestContext = {}) {
    const { agents, approvals, sessions } = this.context;
    const primeId = args.primeId || sessions.activeConversationId || 'default';
    if (args.action === 'status') return agents.status(primeId);
    const approvalPrimeKey = agents.primeKey(primeId);
    const targetSnapshot = ['message', 'report'].includes(args.action)
      ? agents.approvalSnapshot(primeId, args.workerId)
      : (args.action === 'clear' ? agents.approvalSnapshot(primeId) : null);
    await approvals.require({
      scope: `agent.manage:${approvalPrimeKey}:${args.action}`,
      summary: `${args.action} browser worker for opaque prime ${approvalPrimeKey.slice(-12)}`,
      details: {
        argumentsHash: argumentsHash({ ...args, primeId }),
        targetHash: targetSnapshot?.hash ?? null,
      },
      displayDetails: {
        action: args.action,
        workerId: args.workerId ?? null,
        label: args.label ?? null,
        taskLength: String(args.task ?? '').length,
        messageLength: String(args.message ?? '').length,
        resultLength: String(args.result ?? '').length,
      },
      sessionId: requestContext.mcpSessionId ?? null,
    });
    if (args.action === 'spawn') return agents.spawn({ ...args, primeId });
    if (args.action === 'message') return agents.message({ ...args, primeId, expectedTargetHash: targetSnapshot.hash });
    if (args.action === 'report') return agents.report({ ...args, primeId, expectedTargetHash: targetSnapshot.hash });
    if (args.action === 'clear') return agents.clear(primeId, targetSnapshot.hash);
    throw new Error('Unsupported agent action');
  }

  async callTool(name, args = {}, requestContext = {}) {
    const { files, commands, approvals, audit } = this.context;
    const started = Date.now();
    try {
      const definition = this.definitionMap.get(name);
      if (!definition) throw new Error(`Unknown tool: ${name}`);
      validateJsonSchema(definition.inputSchema, args);
      let result;
      if (this.reluTools.has(name)) result = await this.reluTools.call(name, args, requestContext);
      else if (this.perfettoTools.has(name)) result = await this.perfettoTools.call(name, args, requestContext);
      else if (name === 'workspace_roots') result = files.listRoots();
      else if (name === 'list_files') result = await files.listFiles(args);
      else if (name === 'read_file') result = await files.readFile(args);
      else if (name === 'search_files') result = await files.search(args);
      else if (name === 'inspect_diff') result = await files.gitDiff(args);
      else if (name === 'apply_edits') {
        const policyHash = rootPolicyHash(this.context.config, args.rootId);
        await approvals.require({
          scope: `file.write:${args.rootId}:${policyHash}`,
          summary: `Allow file changes inside root ${args.rootId}`,
          details: { argumentsHash: argumentsHash(args) },
          displayDetails: { paths: (args.edits ?? []).map((edit) => edit.path), editCount: args.edits?.length ?? 0 },
          sessionId: requestContext.mcpSessionId ?? null,
        });
        result = await files.applyEdits(args);
      } else if (name === 'run_command') {
        const { commandName, hash: policyHash } = commandPolicyHash(this.context.config, args);
        await approvals.require({
          scope: `command.run:${args.rootId}:${commandName}:${policyHash}`,
          summary: `Run command ${commandName} inside root ${args.rootId}`,
          details: { argumentsHash: argumentsHash(args) },
          displayDetails: {
            profile: args.profile ?? null,
            program: args.program ?? null,
            cwd: args.cwd ?? '.',
            argumentCount: (args.args?.length ?? 0) + (args.extraArgs?.length ?? 0),
            interactive: Boolean(args.interactive),
          },
          sessionId: requestContext.mcpSessionId ?? null,
        });
        result = await commands.run(args);
      } else if (name === 'write_stdin') {
        await approvals.require({
          scope: `command.stdin:${args.sessionId}`,
          summary: `Interact with command session ${args.sessionId}`,
          details: { argumentsHash: argumentsHash(args) },
          displayDetails: {
            charsLength: String(args.chars ?? '').length,
            closeStdin: Boolean(args.closeStdin),
            terminate: Boolean(args.terminate),
          },
          sessionId: requestContext.mcpSessionId ?? null,
        });
        result = commands.write(args);
      } else if (name === 'session') result = await this.sessionAction(args, requestContext);
      else if (name === 'agents') result = await this.agentAction(args, requestContext);
      else if (name === 'approval_status') result = approvals.list();
      else throw new Error(`Unknown tool: ${name}`);
      await audit.append({ category: 'mcp', action: name, durationMs: Date.now() - started, arguments: args, result });
      return success(result);
    } catch (error) {
      await audit.append({ category: 'mcp', action: name, durationMs: Date.now() - started, arguments: args, error: errorMessage(error) });
      return failure(error);
    }
  }

  async handle(message, requestContext = {}) {
    if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      return { jsonrpc: '2.0', id: message?.id ?? null, error: { code: -32600, message: 'Invalid Request' } };
    }
    if (message.method === 'initialize') {
      try {
        const initialized = await this.initialize();
        return { response: { jsonrpc: '2.0', id: message.id, result: initialized.result }, sessionId: initialized.sessionId };
      } catch (error) {
        return {
          response: {
            jsonrpc: '2.0', id: message.id ?? null,
            error: { code: Number.isInteger(error?.code) ? error.code : -32603, message: errorMessage(error) },
          },
        };
      }
    }
    const mcpSessionId = requestContext.mcpSessionId;
    const mcpSession = typeof mcpSessionId === 'string' ? this.sessions.get(mcpSessionId) : null;
    if (!mcpSession || Date.now() - mcpSession.lastSeenAt > MCP_SESSION_IDLE_TTL_MS) {
      if (mcpSessionId) {
        this.sessions.delete(mcpSessionId);
        await this.context.approvals.revokeSession(mcpSessionId);
      }
      return { response: { jsonrpc: '2.0', id: message.id ?? null, error: { code: -32001, message: 'A valid server-issued MCP session id is required' } } };
    }
    mcpSession.lastSeenAt = Date.now();
    if (message.method === 'notifications/initialized' || message.method.startsWith('notifications/')) return { notification: true };
    if (message.method === 'ping') return { response: { jsonrpc: '2.0', id: message.id, result: {} } };
    if (message.method === 'tools/list') return { response: { jsonrpc: '2.0', id: message.id, result: { tools: this.definitions } } };
    if (message.method === 'tools/call') {
      const result = await this.callTool(message.params?.name, message.params?.arguments ?? {}, { ...requestContext, mcpSessionId });
      return { response: { jsonrpc: '2.0', id: message.id, result } };
    }
    return { response: { jsonrpc: '2.0', id: message.id ?? null, error: { code: -32601, message: 'Method not found' } } };
  }

  async closeSession(sessionId) {
    const closed = this.sessions.delete(sessionId);
    await this.context.approvals.revokeSession(sessionId);
    return closed;
  }
}
