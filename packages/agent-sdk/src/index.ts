export type MosaicCapabilityOperation =
  | 'state.get' | 'state.put' | 'state.compareAndSet'
  | 'log.emit' | 'clock.now' | 'random.bytes'
  | 'xmtp.send' | 'xmtp.receive';

export interface StateValue<T = unknown> {
  revision: number;
  value: T | null;
}

export interface StateCompareAndSetResult<T = unknown> extends StateValue<T> {
  updated: boolean;
}

export interface XmtpMessage {
  resourceId: string;
  text: string;
  messageId?: string;
  sentAt?: string;
}

export interface MosaicApi {
  readonly log: {
    emit(entry: Record<string, unknown>): Promise<{ accepted: true }>;
  };
  readonly clock: {
    now(): Promise<string>;
  };
  readonly random: {
    /** Returns base64-encoded random bytes. */
    bytes(length: number): Promise<string>;
  };
  readonly state: {
    get<T = unknown>(key: string): Promise<StateValue<T>>;
    put<T = unknown>(key: string, value: T): Promise<StateValue<T>>;
    compareAndSet<T = unknown>(key: string, expectedRevision: number, value: T): Promise<StateCompareAndSetResult<T>>;
  };
  readonly xmtp: {
    address(): string;
    send(resourceId: string, text: string): Promise<{ messageId: string }>;
    onMessage(handler: (message: XmtpMessage) => void | Promise<void>): Promise<{ registered: true }>;
  };
  readonly capabilities: {
    has(operation: MosaicCapabilityOperation): boolean;
  };
  readonly resources: {
    has(slotId: string): boolean;
  };
  readonly runtime: {
    waitUntilStopped(): Promise<void>;
  };
}

export interface AgentDefinition {
  run(mosaic: MosaicApi): Promise<void>;
}

/** Defines an agent without starting it or touching any runtime authority. */
export function defineAgent(handler: (mosaic: MosaicApi) => Promise<void>): AgentDefinition {
  if (typeof handler !== 'function') throw new TypeError('agent handler must be a function');
  return Object.freeze({ run: handler });
}
