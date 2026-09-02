import crypto from 'node:crypto';
import { validateJsonSchema } from './json-schema.mjs';

const objectSchema = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const string = (description, maxLength = undefined) => ({ type: 'string', description, ...(maxLength ? { maxLength } : {}) });
const CLAUDE_ALWAYS_LOAD = { 'anthropic/alwaysLoad': true };

const tool = (name, description, inputSchema, annotations = {}) => ({
  name,
  description,
  inputSchema,
  annotations,
  _meta: CLAUDE_ALWAYS_LOAD,
});

const PERFETTO_CAPABILITIES = Object.freeze([
  {
    name: 'trace_info', description: 'Read bounded metadata for this Perfetto trace.', readOnly: true, effect: 'read',
    inputSchema: objectSchema(), outputSchema: { type: 'object' },
  },
  {
    name: 'get_selection', description: 'Read the current area selection in this Perfetto tab.', readOnly: true, effect: 'read',
    inputSchema: objectSchema(), outputSchema: { type: 'object' },
  },
  {
    name: 'query_sql', description: 'Run one bounded read-only PerfettoSQL SELECT query; CTEs are disabled.', readOnly: true, effect: 'read',
    inputSchema: objectSchema({ sql: string('One bounded read-only PerfettoSQL query.', 65_536) }, ['sql']), outputSchema: { type: 'object' },
  },
  {
    name: 'select_range', description: 'Select and focus a nanosecond range in this Perfetto tab.', readOnly: false, effect: 'ui_mutation',
    inputSchema: objectSchema({
      start: string('Inclusive timestamp in nanoseconds.', 128),
      end: string('Exclusive timestamp in nanoseconds.', 128),
      trackUris: { type: 'array', items: { type: 'string', maxLength: 500 }, maxItems: 1000 },
    }, ['start', 'end']),
    outputSchema: { type: 'object' },
  },
]);

export function createReluToolDefinitions() {
  return [
    tool('list_sessions', 'Start here: list privacy-safe live RELU AI Bridge sessions across configured browser services, desktop applications, and Perfetto.', objectSchema({
      serviceId: string('Optional exact service id.', 64),
      activeOnly: { type: 'boolean', description: 'Filter by the connector-reported focus hint; never use this hint alone to authorize or target a mutation.' },
    }), { readOnlyHint: true }),
    tool('get_context', 'Read the structured current-view context for one RELU session. The first read requires a locally revocable scoped approval.', objectSchema({
      sessionId: string('Session id returned by list_sessions.', 200),
    }, ['sessionId']), { readOnlyHint: true }),
    tool('list_capabilities', 'List the server-authoritative allowlisted actions and JSON schemas for one RELU session.', objectSchema({
      sessionId: string('Session id returned by list_sessions.', 200),
    }, ['sessionId']), { readOnlyHint: true }),
    tool('execute', 'Execute one server-authoritative capability for a RELU session. Arbitrary URL, method, header, script, selector, or command relays are not supported.', objectSchema({
      sessionId: string('Session id returned by list_sessions.', 200),
      action: string('Capability name returned by list_capabilities.', 64),
      parameters: { type: 'object', description: 'Arguments matching the capability inputSchema.' },
      operationId: {
        type: 'string',
        description: 'Required unique id for UI/data mutation or external-side-effect capabilities.',
        minLength: 8,
        maxLength: 128,
        pattern: '^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,127}$',
      },
    }, ['sessionId', 'action', 'parameters']), { readOnlyHint: false, destructiveHint: true }),
  ];
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return crypto.createHash('sha256').update(canonical(value)).digest('hex');
}

function perfettoSessionId(clientId) {
  return `perfetto:${clientId}`;
}

function parsePerfettoSessionId(value) {
  return typeof value === 'string' && value.startsWith('perfetto:') ? value.slice('perfetto:'.length) : null;
}

function perfettoSession(client) {
  return {
    id: perfettoSessionId(client.id),
    serviceId: 'perfetto',
    serviceName: 'Perfetto Connector #1',
    connectorVersion: client.plugin.version,
    sessionKey: client.traceKey,
    connectedAt: client.connectedAt,
    lastSeenAt: client.lastSeenAt,
    contextUpdatedAt: client.lastSeenAt,
    active: false,
    role: client.role,
    groupSessionId: client.sessionId,
    capabilities: PERFETTO_CAPABILITIES.map((item) => item.name),
  };
}

export class ReluTools {
  constructor(context, perfettoTools) {
    this.context = context;
    this.perfettoTools = perfettoTools;
    this.names = new Set(createReluToolDefinitions().map((item) => item.name));
  }

  has(name) {
    return this.names.has(name);
  }

  listSessions(args) {
    const generic = this.context.connectors.listSessions(args);
    const perfetto = (!args.serviceId || args.serviceId === 'perfetto') && !args.activeOnly
      ? this.context.perfetto.listClients().map(perfettoSession)
      : [];
    return { sessions: [...generic, ...perfetto] };
  }

  async getContext(sessionId, requestContext = {}) {
    const perfettoClientId = parsePerfettoSessionId(sessionId);
    if (perfettoClientId) {
      const client = this.context.perfetto.getClient(perfettoClientId);
      const snapshot = this.context.perfetto.createSnapshot(client);
      await this.perfettoTools.requireTraceRead(snapshot, 'relu-context', {}, requestContext.mcpSessionId);
      const [trace, selection] = await Promise.all([
        this.context.perfetto.requestSnapshot(snapshot, 'trace.getInfo'),
        this.context.perfetto.requestSnapshot(snapshot, 'selection.getArea'),
      ]);
      this.context.perfetto.assertSnapshot(snapshot);
      const publicClient = this.context.perfetto.listClients().find((item) => item.id === snapshot.clientId);
      return { session: perfettoSession(publicClient), context: { trace, selection } };
    }
    const snapshot = this.context.connectors.getContextSnapshot(sessionId);
    const descriptor = snapshot.approvalDescriptor;
    const scope = this.approvalScope('context.read', descriptor);
    await this.context.approvals.require({
      scope,
      summary: `Read current context from ${descriptor.serviceName}`,
      details: { contextVersion: snapshot.contextVersion },
      displayDetails: {
        action: 'get-context', serviceId: descriptor.serviceId,
        sessionKey: snapshot.session.sessionKey, resourceKey: snapshot.session.resourceKey,
      },
      sessionId: requestContext.mcpSessionId ?? null,
    });
    return this.context.connectors.readContextSnapshot(snapshot);
  }

  listCapabilities(sessionId) {
    if (parsePerfettoSessionId(sessionId)) {
      this.context.perfetto.getClient(parsePerfettoSessionId(sessionId));
      return { sessionId, capabilities: structuredClone(PERFETTO_CAPABILITIES) };
    }
    return { sessionId, capabilities: this.context.connectors.listCapabilities(sessionId) };
  }

  approvalScope(kind, descriptor) {
    const tuple = {
      version: 3,
      kind,
      connectorId: descriptor.serviceId,
      origin: descriptor.origin,
      pageBinding: descriptor.pageBinding,
      resourceBinding: descriptor.contextBinding,
      executionGuardMode: descriptor.executionGuardMode,
      executionGuardFields: descriptor.executionGuardFields,
      connectorVersion: descriptor.connectorVersion,
      capabilityId: descriptor.capability?.name ?? 'get_context',
      transport: descriptor.capability?.transport ?? 'context-plane',
      http: descriptor.capability?.http ?? null,
      schemaHash: digest(descriptor.capability
        ? { input: descriptor.capability.inputSchema, output: descriptor.capability.outputSchema }
        : descriptor.contextSchema),
      effect: descriptor.capability?.effect ?? 'read',
      policyEpoch: this.context.config.connectors.policyEpoch,
    };
    return `relu.${kind}:${digest(tuple)}`;
  }

  async executePerfetto(clientId, action, parameters, operationId, mcpSessionId) {
    const requestContext = { mcpSessionId };
    if (action === 'trace_info') return this.perfettoTools.call('perfetto_trace_info', { clientId }, requestContext);
    if (action === 'get_selection') return this.perfettoTools.call('perfetto_get_selection', { clientId }, requestContext);
    if (action === 'query_sql') return this.perfettoTools.call('perfetto_query', { clientId, sql: parameters.sql }, requestContext);
    if (action === 'select_range') return this.perfettoTools.call('perfetto_select_area', {
      clientId, start: parameters.start, end: parameters.end, trackUris: parameters.trackUris, operationId,
    }, requestContext);
    throw new Error(`Unsupported Perfetto capability: ${action}`);
  }

  async execute(args, requestContext = {}) {
    const perfettoClientId = parsePerfettoSessionId(args.sessionId);
    if (perfettoClientId) {
      const capability = PERFETTO_CAPABILITIES.find((item) => item.name === args.action);
      if (!capability) throw new Error(`Capability is not available: ${args.action}`);
      validateJsonSchema(capability.inputSchema, args.parameters, { maxNodes: 20_000, maxDepth: 16 });
      if (capability.effect !== 'read' && !args.operationId) throw new Error('operationId is required for a mutating capability');
      const result = await this.executePerfetto(
        perfettoClientId, args.action, args.parameters, args.operationId, requestContext.mcpSessionId,
      );
      validateJsonSchema(capability.outputSchema, result, { maxNodes: 20_000, maxDepth: 16 });
      return result;
    }
    const prepared = this.context.connectors.prepareExecution(
      args.sessionId, args.action, args.parameters, { operationId: args.operationId },
    );
    const { snapshot } = prepared;
    const descriptor = snapshot.approvalDescriptor;
    const capability = snapshot.capability;
    const scope = this.approvalScope('capability', descriptor);
    await this.context.approvals.require({
      scope,
      summary: `${capability.effect === 'read' ? 'Read with' : 'Run'} ${descriptor.serviceName}.${capability.name}`,
      details: { argumentsHash: prepared.argsHash, operationId: prepared.operationId },
      displayDetails: {
        action: capability.name,
        effect: capability.effect,
        serviceId: descriptor.serviceId,
        sessionKey: snapshot.session.sessionKey,
        resourceKey: snapshot.session.resourceKey,
        argumentsHash: prepared.argsHash.slice(0, 12),
      },
      sessionId: requestContext.mcpSessionId ?? null,
    });
    return this.context.connectors.executePrepared(prepared);
  }

  async call(name, args = {}, requestContext = {}) {
    if (name === 'list_sessions') return this.listSessions(args);
    if (name === 'get_context') return this.getContext(args.sessionId, requestContext);
    if (name === 'list_capabilities') return this.listCapabilities(args.sessionId);
    if (name === 'execute') return this.execute(args, requestContext);
    throw new Error(`Unknown RELU tool: ${name}`);
  }
}
