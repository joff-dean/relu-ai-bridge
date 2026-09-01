export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface CapabilityExecution {
  signal: AbortSignal;
  operationId: string | null;
  contextGuard: {
    fields: string[];
    projection: Record<string, JsonValue>;
    binding: string;
  };
}

export type ReluWebConnectorState =
  | 'stopped'
  | 'connecting'
  | 'authenticating'
  | 'connected'
  | 'disconnected'
  | 'reconnecting'
  | 'resetting'
  | 'rejected';

export interface ReluWebConnectorStatus {
  state: ReluWebConnectorState;
  sessionId?: string;
  errorCode?: string;
  detail?: string;
}

export interface ReluWebConnectorOptions {
  serviceId: string;
  token: string;
  /** Exact page Origin. Required outside a browser and must match location.origin in a browser. */
  origin?: string;
  connectorVersion?: string;
  bridgeUrl?: string;
  getContext: () => JsonValue | Promise<JsonValue>;
  capabilities: Record<string, (parameters: Record<string, JsonValue>, execution: CapabilityExecution) => JsonValue | Promise<JsonValue>>;
  onStatus?: (status: ReluWebConnectorStatus) => void;
}

export declare class ReluWebConnector {
  constructor(options: ReluWebConnectorOptions);
  readonly serviceId: string;
  readonly origin: string;
  clientId: string;
  sessionId: string | null;
  state: ReluWebConnectorState;
  start(): Promise<void>;
  stop(): void;
  updateContext(context?: JsonValue): Promise<boolean>;
  markActive(active?: boolean): boolean;
}
