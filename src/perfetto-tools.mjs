import crypto from 'node:crypto';
import { Worker } from 'node:worker_threads';

const objectSchema = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const string = (description) => ({ type: 'string', description });
const tool = (name, description, inputSchema, annotations = {}, meta = undefined) => ({
  name,
  description,
  inputSchema,
  annotations,
  ...(meta ? { _meta: meta } : {}),
});

const CLAUDE_ALWAYS_LOAD = { 'anthropic/alwaysLoad': true };
const PERFETTO_BOUNDED_READ_MARKER = '/*relu-ai-bridge:perfetto-bounded-read-v1*/';
const SERVICE_ALIGNMENT_LIMITS = Object.freeze({
  maxSamples: 5_000,
  maxDimensions: 16,
  maxFeatureValues: 240_000,
  maxCoarseSamples: 512,
  maxCoarseOperations: 3_000_000,
  maxDtwSamples: 1_024,
  maxDtwCells: 1_000_000,
  maxMappingPoints: 512,
  maxOperations: 8_000_000,
  timeBudgetMs: 3_000,
});

const finiteNumber = (minimum, maximum) => ({ type: 'number', minimum, maximum });
const safeInteger = (minimum, maximum) => ({ type: 'integer', minimum, maximum });
const alignmentLimitsSchema = objectSchema(Object.fromEntries(
  Object.entries(SERVICE_ALIGNMENT_LIMITS).map(([key, maximum]) => [key, safeInteger(1, maximum)]),
));
const alignmentOptionsSchema = objectSchema({
  minimumSamples: safeInteger(2, 100),
  fineCandidateCount: safeInteger(1, 4),
  limits: alignmentLimitsSchema,
  features: objectSchema({
    mode: { type: 'string', enum: ['raw', 'raw+delta', 'raw+delta+activity'] },
    clip: finiteNumber(0.000001, 20),
    epsilon: finiteNumber(1e-15, 1),
    deltaWeight: finiteNumber(0, 4),
    activityWeight: finiteNumber(0, 4),
  }),
  coarse: objectSchema({
    scales: { type: 'array', items: finiteNumber(0.25, 4), minItems: 1, maxItems: 16 },
    minScale: finiteNumber(0.25, 4),
    maxScale: finiteNumber(0.25, 4),
    scaleSteps: safeInteger(1, 16),
    probeCount: safeInteger(8, 512),
    candidateCount: safeInteger(1, 8),
    separationRatio: finiteNumber(0, 1),
  }),
  dtw: objectSchema({
    bandRatio: finiteNumber(0, 1),
    paddingRatio: finiteNumber(0, 1),
    transitionPenalty: finiteNumber(0, 1),
    endpointPenalty: finiteNumber(0, 1),
  }),
  mapping: objectSchema({ tolerance: finiteNumber(0, Number.MAX_SAFE_INTEGER) }),
});

export function createPerfettoToolDefinitions() {
  return [
    tool('perfetto_clients', 'Start here: list connected Perfetto v58.2 clients by privacy-safe trace key and show REF/DUT assignments.', objectSchema(), { readOnlyHint: true }, CLAUDE_ALWAYS_LOAD),
    tool('perfetto_sessions', 'Create, inspect, attach, detach, or remove durable REF/DUT sessions. Mutating actions use local scoped approval.', objectSchema({
      action: { type: 'string', enum: ['list', 'create', 'get', 'attach', 'detach', 'remove'] },
      sessionId: string('Session id for get, attach, detach, or remove.'),
      name: string('Human-readable name for create.'),
      role: { type: 'string', enum: ['ref', 'dut'] },
      clientId: string('Connected Perfetto client id for attach.'),
    }, ['action']), { readOnlyHint: false }, CLAUDE_ALWAYS_LOAD),
    tool('perfetto_trace_info', 'Read trace metadata from one connected Perfetto UI client or a REF/DUT session role.', objectSchema({
      clientId: string('Connected client id. Use either clientId or sessionId plus role.'),
      sessionId: string('REF/DUT session id.'),
      role: { type: 'string', enum: ['ref', 'dut'] },
    }), { readOnlyHint: true }),
    tool('perfetto_get_selection', 'Read the current selection from a connected Perfetto UI client.', objectSchema({
      clientId: string('Connected client id. Use either clientId or sessionId plus role.'),
      sessionId: string('REF/DUT session id.'),
      role: { type: 'string', enum: ['ref', 'dut'] },
    }), { readOnlyHint: true }),
    tool('perfetto_query', 'Execute one bounded SELECT-only PerfettoSQL read using a strict pure-function allowlist. First trace read requires revocable local approval.', objectSchema({
      clientId: string('Connected client id. Use either clientId or sessionId plus role.'),
      sessionId: string('REF/DUT session id.'),
      role: { type: 'string', enum: ['ref', 'dut'] },
      sql: string('One read-only SELECT query. CTEs, mutations, and multiple statements are rejected.'),
    }, ['sql']), { readOnlyHint: true }),
    tool('perfetto_select_area', 'Select and reveal a time area in one Perfetto UI. Persistent approval is scoped to the target client.', objectSchema({
      clientId: string('Connected client id. Use either clientId or sessionId plus role.'),
      sessionId: string('REF/DUT session id.'),
      role: { type: 'string', enum: ['ref', 'dut'] },
      start: string('Inclusive trace timestamp in nanoseconds, as an integer string.'),
      end: string('Exclusive trace timestamp in nanoseconds, as an integer string.'),
      trackUris: { type: 'array', items: { type: 'string' }, maxItems: 1000 },
      operationId: {
        type: 'string', minLength: 8, maxLength: 128,
        pattern: '^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,127}$',
        description: 'Required stable idempotency key for this UI mutation.',
      },
    }, ['start', 'end', 'operationId']), { readOnlyHint: false, destructiveHint: false }),
    tool('perfetto_align', 'Align REF and DUT feature time series using coarse correlation and constrained DTW, then optionally select the mapped DUT area.', objectSchema({
      sessionId: string('Durable session with connected REF and DUT clients.'),
      refSql: string('Read-only query returning timestamp and value columns for REF.'),
      dutSql: string('Read-only query returning timestamp and value columns for DUT.'),
      timestampColumn: string('Timestamp column name; defaults to ts.'),
      valueColumns: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 16 },
      refStart: string('Optional REF selection start in nanoseconds; current REF area is used when omitted.'),
      refEnd: string('Optional REF selection end in nanoseconds; current REF area is used when omitted.'),
      applySelection: { type: 'boolean', description: 'Select the mapped area in DUT; defaults to true.' },
      operationId: {
        type: 'string', minLength: 8, maxLength: 128,
        pattern: '^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,127}$',
        description: 'Required when applySelection is not false; omitted for read-only preview.',
      },
      trackUris: { type: 'array', items: { type: 'string' }, maxItems: 1000 },
      options: { ...alignmentOptionsSchema, description: 'Optional tuning bounded below the service hard caps; unknown keys are rejected.' },
    }, ['sessionId', 'refSql', 'dutSql']), { readOnlyHint: false, destructiveHint: false }, CLAUDE_ALWAYS_LOAD),
  ];
}

const FORBIDDEN_SQL_KEYWORDS = new Set([
  'alter', 'analyze', 'attach', 'begin', 'commit', 'copy', 'create',
  'delete', 'detach', 'drop', 'export', 'grant', 'import', 'include',
  'insert', 'pragma', 'reindex', 'release', 'replace', 'revoke',
  'recursive', 'rollback', 'savepoint', 'transaction', 'trigger', 'update', 'vacuum', 'with',
]);

const NEVER_ALLOWED_SQL_FUNCTIONS = new Set([
  'eval', 'export_json', 'export_trace', 'http_get', 'import',
  'load_extension', 'readfile', 'run_metric', 'shell', 'system', 'writefile',
]);

const SQL_PAREN_SYNTAX = new Set([
  'as', 'case', 'else', 'exists', 'filter', 'in', 'not', 'over', 'select',
  'values', 'when', 'where', 'window',
]);

function sqlTokens(sql) {
  const tokens = [];
  let index = 0;
  const push = (type, value, quoted = false) => tokens.push({ type, value, lower: value.toLowerCase(), quoted });
  while (index < sql.length) {
    const char = sql[index];
    if (/\s/u.test(char)) { index += 1; continue; }
    if (char === '-' && sql[index + 1] === '-') {
      index += 2;
      while (index < sql.length && !['\n', '\r'].includes(sql[index])) index += 1;
      continue;
    }
    if (char === '/' && sql[index + 1] === '*') {
      const end = sql.indexOf('*/', index + 2);
      if (end < 0) throw new Error('SQL block comment is not terminated');
      index = end + 2;
      continue;
    }
    if (char === "'") {
      let value = '';
      index += 1;
      let closed = false;
      while (index < sql.length) {
        if (sql[index] === "'" && sql[index + 1] === "'") { value += "'"; index += 2; continue; }
        if (sql[index] === "'") { index += 1; closed = true; break; }
        value += sql[index];
        index += 1;
      }
      if (!closed) throw new Error('SQL string literal is not terminated');
      push('string', value);
      continue;
    }
    if (char === '"' || char === '`' || char === '[') {
      const close = char === '[' ? ']' : char;
      let value = '';
      index += 1;
      let closed = false;
      while (index < sql.length) {
        if (sql[index] === close && sql[index + 1] === close) { value += close; index += 2; continue; }
        if (sql[index] === close) { index += 1; closed = true; break; }
        value += sql[index];
        index += 1;
      }
      if (!closed) throw new Error('SQL quoted identifier is not terminated');
      push('word', value, true);
      continue;
    }
    if (/[A-Za-z_\u0080-\uFFFF]/u.test(char)) {
      const start = index;
      index += 1;
      while (index < sql.length && /[A-Za-z0-9_$\u0080-\uFFFF]/u.test(sql[index])) index += 1;
      push('word', sql.slice(start, index));
      continue;
    }
    if (/[0-9]/u.test(char)) {
      const start = index;
      index += 1;
      while (index < sql.length && /[0-9A-Fa-f_xX.eE+-]/u.test(sql[index])) index += 1;
      push('number', sql.slice(start, index));
      continue;
    }
    push('symbol', char);
    index += 1;
  }
  return tokens;
}

export function validateReadOnlySql(config, sql) {
  if (typeof sql !== 'string' || !sql.trim()) throw new Error('sql is required');
  if (Buffer.byteLength(sql) > config.perfetto.maxQueryBytes) throw new Error('SQL exceeds configured byte limit');
  const tokens = sqlTokens(sql);
  if (tokens.at(-1)?.type === 'symbol' && tokens.at(-1).value === ';') tokens.pop();
  if (tokens.length === 0 || tokens.some((token) => token.type === 'symbol' && token.value === ';')) {
    throw new Error('Multiple SQL statements are not allowed');
  }
  if (tokens[0].type !== 'word' || tokens[0].quoted || tokens[0].lower !== 'select') {
    throw new Error('Only SELECT queries are allowed; CTEs are disabled');
  }
  for (const token of tokens) {
    if (token.type === 'word' && !token.quoted && FORBIDDEN_SQL_KEYWORDS.has(token.lower)) {
      throw new Error(`PerfettoSQL keyword is not allowed: ${token.value}`);
    }
  }
  const allowedFunctions = new Set((config.perfetto.allowedSqlFunctions ?? []).map((name) => String(name).toLowerCase()));
  for (let tokenIndex = 0; tokenIndex < tokens.length - 1; tokenIndex += 1) {
    const token = tokens[tokenIndex];
    const next = tokens[tokenIndex + 1];
    if (token.type === 'word' && next.type === 'symbol' && next.value === '!'
      && tokens[tokenIndex + 2]?.type === 'symbol' && tokens[tokenIndex + 2].value === '(') {
      throw new Error(`PerfettoSQL macro is not allowed: ${token.value}!`);
    }
    if (next.type !== 'symbol' || next.value !== '(') continue;
    if (token.type === 'string') throw new Error('Calling a string literal as a SQL function is not allowed');
    if (token.type !== 'word' || (!token.quoted && SQL_PAREN_SYNTAX.has(token.lower))) continue;
    if (NEVER_ALLOWED_SQL_FUNCTIONS.has(token.lower) || !allowedFunctions.has(token.lower)) {
      throw new Error(`PerfettoSQL function is not allowed: ${token.value}`);
    }
  }
  return sql;
}

function boundedSql(config, sql) {
  const validated = validateReadOnlySql(config, sql).trim().replace(/;\s*$/u, '');
  return `${PERFETTO_BOUNDED_READ_MARKER} SELECT * FROM (${validated}) AS _relu_perfetto_bounded LIMIT ${config.perfetto.maxQueryRows + 1}`;
}

function integerString(value, name) {
  const text = String(value ?? '');
  if (!/^-?\d+$/.test(text)) throw new Error(`${name} must be an integer string`);
  return text;
}

function queryRows(result) {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.rows)) return result.rows;
  throw new Error('Perfetto query did not return a rows array');
}

function queryCellBigInt(value, name) {
  const raw = value && typeof value === 'object' && value.type === 'bigint' ? value.value : value;
  if (typeof raw === 'bigint') return raw;
  if (typeof raw === 'number' && Number.isSafeInteger(raw)) return BigInt(raw);
  if (typeof raw === 'string' && /^-?\d+$/u.test(raw)) return BigInt(raw);
  throw new Error(`${name} must be an integer timestamp`);
}

function queryCellNumber(value, name) {
  const raw = value && typeof value === 'object' && value.type === 'bigint' ? value.value : value;
  if (typeof raw === 'bigint' || (typeof raw === 'string' && /^-?\d+$/u.test(raw))) {
    const integer = BigInt(raw);
    if (integer > BigInt(Number.MAX_SAFE_INTEGER) || integer < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw new Error(`${name} exceeds the safe numeric range`);
    }
  }
  const number = Number(raw);
  if (!Number.isFinite(number)) throw new Error(`${name} must be numeric`);
  return number;
}

function safeRelativeNumber(value, name) {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new Error(`${name} exceeds the safe relative timestamp range`);
  }
  return Number(value);
}

function rowsToSeries(result, timestampColumn, valueColumns, maxRows) {
  const rows = queryRows(result);
  if (rows.length < 2) throw new Error('Alignment query must return at least two rows');
  if (rows.length > maxRows) throw new Error(`Alignment query returned more than ${maxRows} rows`);
  const timestamps = rows.map((row, index) => queryCellBigInt(row?.[timestampColumn], `alignment row ${index} timestamp`));
  const origin = timestamps.reduce((minimum, value) => value < minimum ? value : minimum, timestamps[0]);
  return {
    origin,
    rows: rows.map((row, index) => {
      const timestamp = safeRelativeNumber(timestamps[index] - origin, `alignment row ${index} timestamp`);
      const values = valueColumns.map((column) => queryCellNumber(row?.[column], `alignment row ${index} column ${column}`));
      return { timestamp, value: values.length === 1 ? values[0] : values };
    }),
  };
}

function addOrigin(origin, relative, name) {
  const rounded = Math.round(relative);
  if (!Number.isSafeInteger(rounded)) throw new Error(`${name} is outside the safe relative timestamp range`);
  return (origin + BigInt(rounded)).toString();
}

function absoluteMapping(mapping, refOrigin, dutOrigin) {
  return {
    points: mapping.points.map((point) => ({
      refTime: addOrigin(refOrigin, point.refTime, 'mapping REF timestamp'),
      dutTime: addOrigin(dutOrigin, point.dutTime, 'mapping DUT timestamp'),
    })),
    refRange: {
      start: addOrigin(refOrigin, mapping.refRange.start, 'mapping REF range'),
      end: addOrigin(refOrigin, mapping.refRange.end, 'mapping REF range'),
    },
    dutRange: {
      start: addOrigin(dutOrigin, mapping.dutRange.start, 'mapping DUT range'),
      end: addOrigin(dutOrigin, mapping.dutRange.end, 'mapping DUT range'),
    },
  };
}

function serviceAlignmentOptions(value) {
  if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value))) {
    throw new Error('alignment options must be an object');
  }
  const options = value === undefined ? {} : structuredClone(value);
  options.limits = { ...SERVICE_ALIGNMENT_LIMITS, ...(options.limits ?? {}) };
  for (const [key, maximum] of Object.entries(SERVICE_ALIGNMENT_LIMITS)) {
    if (options.limits[key] > maximum) throw new Error(`alignment limit ${key} exceeds the service maximum`);
  }
  return options;
}

function alignInWorker(input, options) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../alignment/worker.mjs', import.meta.url), {
      workerData: { input, options },
    });
    const timeout = setTimeout(() => {
      void worker.terminate();
      reject(new Error('Alignment worker exceeded its wall-clock timeout'));
    }, SERVICE_ALIGNMENT_LIMITS.timeBudgetMs + 2_000);
    timeout.unref?.();
    worker.once('message', (message) => {
      clearTimeout(timeout);
      if (message?.ok) resolve(message.result);
      else reject(new Error(String(message?.error?.message ?? 'Alignment worker failed')));
    });
    worker.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    worker.once('exit', (code) => {
      if (code !== 0) {
        clearTimeout(timeout);
        reject(new Error(`Alignment worker exited with code ${code}`));
      }
    });
  });
}

export class PerfettoTools {
  constructor(context) {
    this.context = context;
    this.names = new Set(createPerfettoToolDefinitions().map((item) => item.name));
  }

  has(name) {
    return this.names.has(name);
  }

  targetClient(args) {
    const { perfetto } = this.context;
    if (args.clientId) {
      if (args.sessionId || args.role) throw new Error('Provide clientId or sessionId and role, not both selectors');
      return perfetto.getClient(args.clientId);
    }
    if (!args.sessionId || !args.role) throw new Error('Provide clientId or sessionId and role');
    return perfetto.resolveSessionClient(args.sessionId, args.role);
  }

  targetSnapshot(args) {
    const client = this.targetClient(args);
    return this.context.perfetto.createSnapshot(client, args.clientId ? {} : {
      sessionId: args.sessionId,
      role: args.role,
    });
  }

  async requireTraceRead(snapshot, action, details = {}, sessionId = null) {
    const { approvals, perfetto } = this.context;
    const binding = snapshot.traceBinding;
    await approvals.require({
      scope: `perfetto.trace.read:${binding}`,
      summary: `Allow bounded trace reads for trace ${binding.slice(0, 12)}`,
      details: { action, ...details },
      displayDetails: { action, traceKey: binding.slice(0, 12), ...details.display },
      sessionId,
    });
    perfetto.assertSnapshot(snapshot);
  }

  async sessionAction(args, approvalSessionId = null) {
    const { perfetto, perfettoStore, approvals } = this.context;
    if (args.action === 'list') return perfettoStore.list();
    if (args.action === 'get') return perfettoStore.get(args.sessionId);
    if (args.action === 'create') {
      await approvals.require({
        scope: 'perfetto.session.create',
        summary: 'Create a durable REF/DUT Perfetto session',
        details: { name: args.name ?? null },
        displayDetails: { action: 'create', name: String(args.name ?? 'REF/DUT session').slice(0, 100) },
        sessionId: approvalSessionId,
      });
      return perfettoStore.create({ name: args.name });
    }
    if (args.action === 'attach') {
      if (!args.sessionId || !args.role || !args.clientId) throw new Error('sessionId, role, and clientId are required');
      return perfetto.requestAttach(args.sessionId, args.role, args.clientId, 'mcp', approvalSessionId);
    }
    if (args.action === 'detach') {
      if (!args.sessionId || !args.role) throw new Error('sessionId and role are required');
      const session = perfettoStore.get(args.sessionId);
      const snapshot = this.targetSnapshot({ sessionId: args.sessionId, role: args.role });
      const binding = snapshot.traceBinding;
      await approvals.require({
        scope: `perfetto.session.detach:${args.sessionId}:${session.instanceId}:${args.role}:${binding}`,
        summary: `Detach ${args.role.toUpperCase()} from session ${args.sessionId}`,
        details: { action: 'detach', instanceId: session.instanceId },
        displayDetails: {
          action: 'detach',
          sessionId: args.sessionId,
          instanceKey: session.instanceId.slice(-12),
          role: args.role,
          traceKey: binding.slice(0, 12),
        },
        sessionId: approvalSessionId,
      });
      perfetto.assertSnapshot(snapshot);
      return perfetto.detach(args.sessionId, args.role, snapshot, session.instanceId);
    }
    if (args.action === 'remove') {
      if (!args.sessionId) throw new Error('sessionId is required');
      const session = perfettoStore.get(args.sessionId);
      await approvals.require({
        scope: `perfetto.session.remove:${args.sessionId}:${session.instanceId}`,
        summary: `Remove Perfetto session ${args.sessionId}`,
        details: { action: 'remove', instanceId: session.instanceId },
        displayDetails: { action: 'remove', sessionId: args.sessionId, instanceKey: session.instanceId.slice(-12) },
        sessionId: approvalSessionId,
      });
      return perfetto.removeSession(args.sessionId, session.instanceId);
    }
    throw new Error('Unsupported Perfetto session action');
  }

  async align(args, approvalSessionId = null) {
    const { config, perfetto, perfettoStore, approvals } = this.context;
    const session = perfettoStore.get(args.sessionId);
    const refSnapshot = this.targetSnapshot({ sessionId: session.id, role: 'ref' });
    const dutSnapshot = this.targetSnapshot({ sessionId: session.id, role: 'dut' });
    const ref = perfetto.assertSnapshot(refSnapshot);
    const dut = perfetto.assertSnapshot(dutSnapshot);
    const refSql = boundedSql(config, args.refSql);
    const dutSql = boundedSql(config, args.dutSql);
    const refBinding = perfetto.approvalBinding(ref);
    const dutBinding = perfetto.approvalBinding(dut);
    const queryHash = crypto.createHash('sha256').update(`${args.refSql}\0${args.dutSql}`).digest('hex');
    const alignmentOptions = serviceAlignmentOptions(args.options);
    const applySelection = args.applySelection !== false;
    if (applySelection && !args.operationId) {
      throw new Error('operationId is required when perfetto_align applies the DUT selection');
    }
    await approvals.require({
      scope: `perfetto.align.read:${session.id}:${session.instanceId}:${refBinding}:${dutBinding}`,
      summary: `Read REF/DUT trace features for alignment session ${session.id}`,
      details: { queryHash, refBinding, dutBinding, instanceId: session.instanceId },
      displayDetails: {
        action: 'align-read',
        sessionId: session.id,
        instanceKey: session.instanceId.slice(-12),
        refTraceKey: refBinding.slice(0, 12),
        dutTraceKey: dutBinding.slice(0, 12),
        queryHash: queryHash.slice(0, 12),
      },
      sessionId: approvalSessionId,
    });
    perfetto.assertSnapshot(refSnapshot);
    perfetto.assertSnapshot(dutSnapshot);
    perfetto.assertSessionInstance(session.id, session.instanceId);
    const timestampColumn = args.timestampColumn || 'ts';
    const valueColumns = args.valueColumns?.length ? args.valueColumns : ['value'];
    let refStart = args.refStart;
    let refEnd = args.refEnd;
    if (refStart === undefined || refEnd === undefined) {
      const selection = await perfetto.requestSnapshot(refSnapshot, 'selection.getArea');
      if (!selection?.startNs || !selection?.endNs) throw new Error('REF client must have an area selection, or provide refStart/refEnd');
      refStart = selection.startNs;
      refEnd = selection.endNs;
    }
    const startNs = BigInt(integerString(refStart, 'refStart'));
    const endNs = BigInt(integerString(refEnd, 'refEnd'));
    if (startNs >= endNs) throw new Error('REF selection range is invalid');
    let execution = null;
    if (applySelection) {
      const prepared = this.context.connectors.preparePerfettoMutation(dutSnapshot, 'select_range', {
        source: 'perfetto_align',
        sessionId: session.id,
        sessionInstanceId: session.instanceId,
        refTraceResource: refSnapshot.traceResourceBinding,
        refSql,
        dutSql,
        timestampColumn,
        valueColumns,
        refStart: String(refStart),
        refEnd: String(refEnd),
        trackUris: args.trackUris ?? [],
        options: alignmentOptions,
      }, args.operationId);
      await approvals.require({
        scope: `perfetto.align.apply:${session.id}:${session.instanceId}:${refBinding}:${dutBinding}`,
        summary: `Apply REF/DUT alignment selection in session ${session.id}`,
        details: {
          refClientId: ref.id, dutClientId: dut.id, refStart: String(refStart), refEnd: String(refEnd),
          operationId: args.operationId, argumentsHash: prepared.argsHash, instanceId: session.instanceId,
        },
        displayDetails: {
          action: 'align-apply',
          sessionId: session.id,
          instanceKey: session.instanceId.slice(-12),
          refTraceKey: refBinding.slice(0, 12),
          dutTraceKey: dutBinding.slice(0, 12),
          argumentsHash: prepared.argsHash.slice(0, 12),
        },
        sessionId: approvalSessionId,
      });
      perfetto.assertSnapshot(refSnapshot);
      perfetto.assertSnapshot(dutSnapshot);
      execution = await this.context.connectors.beginPerfettoMutation(
        prepared,
        () => {
          perfetto.assertSessionInstance(session.id, session.instanceId);
          perfetto.assertSnapshot(refSnapshot);
          return perfetto.assertSnapshot(dutSnapshot);
        },
        () => dutSnapshot.connection.close(4002, 'operation reconciled; reconnect required'),
      );
      if (execution.duplicate) return await execution.outcome;
    }
    try {
      perfetto.assertSessionInstance(session.id, session.instanceId);
      const [referenceResult, dutResult] = await Promise.all([
        perfetto.requestSnapshot(refSnapshot, 'trace.query', { sql: refSql, maxRows: config.perfetto.maxQueryRows }),
        perfetto.requestSnapshot(dutSnapshot, 'trace.query', { sql: dutSql, maxRows: config.perfetto.maxQueryRows }),
      ]);
      if (referenceResult?.truncated || dutResult?.truncated) {
        throw new Error('Alignment query was truncated; aggregate or bucket the SQL so each side returns at most maxQueryRows');
      }
      const referenceSeries = rowsToSeries(referenceResult, timestampColumn, valueColumns, config.perfetto.maxQueryRows);
      const dutSeries = rowsToSeries(dutResult, timestampColumn, valueColumns, config.perfetto.maxQueryRows);
      const start = safeRelativeNumber(startNs - referenceSeries.origin, 'REF selection start');
      const end = safeRelativeNumber(endNs - referenceSeries.origin, 'REF selection end');
      const result = await alignInWorker({
        referenceRows: referenceSeries.rows,
        dutRows: dutSeries.rows,
        selection: { start, end },
      }, alignmentOptions);
      const mappedStart = addOrigin(dutSeries.origin, result.mappedRange.start, 'mapped start');
      const mappedEnd = addOrigin(dutSeries.origin, result.mappedRange.end, 'mapped end');
      const response = {
        sessionId: session.id,
        refClientId: ref.id,
        dutClientId: dut.id,
        mappedRange: { start: mappedStart, end: mappedEnd },
        applied: applySelection,
        confidence: result.confidence,
        diagnostics: result.diagnostics,
        mapping: absoluteMapping(result.mapping, referenceSeries.origin, dutSeries.origin),
      };
      if (!applySelection) return response;
      return await this.context.connectors.completePerfettoMutation(
        execution,
        () => {
          perfetto.assertSessionInstance(session.id, session.instanceId);
          perfetto.assertSnapshot(refSnapshot);
          return perfetto.assertSnapshot(dutSnapshot);
        },
        async () => perfetto.withSessionInstance(session.id, session.instanceId, async () => {
          perfetto.assertSnapshot(refSnapshot);
          perfetto.assertSnapshot(dutSnapshot);
          await perfetto.requestSnapshot(dutSnapshot, 'selection.selectMappedArea', {
            startNs: mappedStart,
            endNs: mappedEnd,
            trackUris: args.trackUris ?? [],
            focus: true,
          });
          perfetto.assertSnapshot(dutSnapshot);
          await perfettoStore.recordAlignment(session.id, {
            confidence: result.confidence,
            refStart,
            refEnd,
            dutStart: mappedStart,
            dutEnd: mappedEnd,
            method: 'coarse+constrained-dtw',
          }, session.instanceId);
          return response;
        }),
      );
    } catch (error) {
      if (execution && !execution.duplicate) {
        await this.context.connectors.cancelPerfettoMutation(execution, error);
      }
      throw error;
    }
  }

  async call(name, args = {}, requestContext = {}) {
    const { config, perfetto, approvals } = this.context;
    const approvalSessionId = requestContext.mcpSessionId ?? null;
    if (name === 'perfetto_clients') return { clients: perfetto.listClients() };
    if (name === 'perfetto_sessions') return this.sessionAction(args, approvalSessionId);
    if (name === 'perfetto_trace_info') {
      const snapshot = this.targetSnapshot(args);
      await this.requireTraceRead(snapshot, 'trace-info', {}, approvalSessionId);
      return perfetto.requestSnapshot(snapshot, 'trace.getInfo');
    }
    if (name === 'perfetto_get_selection') {
      const snapshot = this.targetSnapshot(args);
      await this.requireTraceRead(snapshot, 'selection-read', {}, approvalSessionId);
      return perfetto.requestSnapshot(snapshot, 'selection.getArea');
    }
    if (name === 'perfetto_query') {
      const snapshot = this.targetSnapshot(args);
      const sqlHash = crypto.createHash('sha256').update(String(args.sql ?? '')).digest('hex');
      await this.requireTraceRead(snapshot, 'query', {
        sqlHash,
        display: { sqlHash: sqlHash.slice(0, 12) },
      }, approvalSessionId);
      return perfetto.requestSnapshot(snapshot, 'trace.query', {
        sql: boundedSql(config, args.sql),
        maxRows: config.perfetto.maxQueryRows,
      });
    }
    if (name === 'perfetto_select_area') {
      const snapshot = this.targetSnapshot(args);
      const start = integerString(args.start, 'start');
      const end = integerString(args.end, 'end');
      if (BigInt(start) >= BigInt(end)) throw new Error('start must be less than end');
      const binding = snapshot.traceBinding;
      const parameters = {
        startNs: start,
        endNs: end,
        trackUris: args.trackUris ?? [],
        focus: true,
      };
      const prepared = this.context.connectors.preparePerfettoMutation(
        snapshot, 'select_range', parameters, args.operationId,
      );
      await approvals.require({
        scope: `perfetto.selection:${binding}`,
        summary: `Allow mapped selections in Perfetto trace ${binding.slice(0, 12)}`,
        details: { start, end, trackUris: args.trackUris ?? [], operationId: args.operationId },
        displayDetails: { action: 'select-area', traceKey: binding.slice(0, 12) },
        sessionId: approvalSessionId,
      });
      return this.context.connectors.executePerfettoMutation(
        prepared,
        () => perfetto.assertSnapshot(snapshot),
        () => perfetto.requestSnapshot(snapshot, 'selection.selectMappedArea', parameters),
        () => snapshot.connection.close(4002, 'operation reconciled; reconnect required'),
      );
    }
    if (name === 'perfetto_align') return this.align(args, approvalSessionId);
    throw new Error(`Unknown Perfetto tool: ${name}`);
  }
}
