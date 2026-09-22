import {
  createAgentSession,
  type AgentSession,
  type AgentSessionEvent,
  type CreateAgentSessionOptions,
} from "@earendil-works/pi-coding-agent";
import { mapPiAgentEvent } from "./events.js";
import { createReportStatusTool } from "./status-tool.js";

export const PI_MOTTAINAI_PROVIDER = "pi" as const;

export type WorkerRuntimeLifecycleState = "starting" | "running" | "paused" | "completed" | "failed" | "stopped";
export type WorkerRuntimePhase =
  | "initializing"
  | "ready"
  | "executing"
  | "waiting"
  | "finalizing"
  | "complete"
  | "failed";
export type WorkerRuntimeActivityKind = "idle" | "working" | "waiting" | "blocked" | "finalizing";
export type WorkerRuntimeAttentionState = "none" | "attention" | "blocked";

export interface WorkerRuntimeIdentity {
  managerSessionId: string;
  runtimeId: string;
  taskId?: string;
  executionSessionId?: string;
  provider: string;
}

export interface WorkerRuntimeBinding {
  identity: WorkerRuntimeIdentity;
  boundAt: string;
}

export interface WorkerRuntimeStartInput {
  identity: WorkerRuntimeIdentity;
  requestedAt?: string;
}

export interface WorkerRuntimeStartResult {
  binding: WorkerRuntimeBinding;
}

export interface WorkerRuntimeBindInput {
  identity: WorkerRuntimeIdentity;
  boundAt?: string;
}

export interface WorkerRuntimeBindResult {
  binding: WorkerRuntimeBinding;
}

export interface WorkerRuntimeActivity {
  kind: WorkerRuntimeActivityKind;
  label?: string;
}

export interface WorkerRuntimeProgress {
  completed: number;
  current: string | null;
  remaining: number | null;
}

export interface WorkerRuntimeStatusReportInput {
  lifecycleState: WorkerRuntimeLifecycleState;
  phase: WorkerRuntimePhase;
  activity: WorkerRuntimeActivity;
  progress: WorkerRuntimeProgress;
  attention: WorkerRuntimeAttentionState;
  blocker?: { code: string; detail: string };
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  context?: { usedTokens?: number; limitTokens?: number };
}

export interface WorkerRuntimeObservation {
  binding: WorkerRuntimeBinding;
  status: WorkerRuntimeStatusReportInput;
  observedAt: string;
}

export type WorkerRuntimeObservationEvent =
  | { kind: "started"; binding: WorkerRuntimeBinding; observedAt: string }
  | { kind: "status"; binding: WorkerRuntimeBinding; status: WorkerRuntimeStatusReportInput; observedAt: string }
  | { kind: "stopped"; binding: WorkerRuntimeBinding; reason?: string; observedAt: string }
  | { kind: "failed"; binding: WorkerRuntimeBinding; blocker: { code: string; detail: string }; observedAt: string };

export interface WorkerRuntimeStopInput {
  binding: WorkerRuntimeBinding;
  reason?: string;
}

export interface WorkerRuntimeSteerInput {
  binding: WorkerRuntimeBinding;
  directive: string;
}

export interface WorkerRuntimeInput {
  binding: WorkerRuntimeBinding;
  input: string;
}

export interface WorkerRuntimeControlReceipt {
  operation: "start" | "bind" | "stop" | "steer" | "input";
  acceptedAt: string;
}

export interface WorkerRuntimeObservationPort {
  readonly observe: (binding: WorkerRuntimeBinding) => Promise<WorkerRuntimeObservation>;
  readonly events: (binding: WorkerRuntimeBinding) => AsyncIterable<WorkerRuntimeObservationEvent>;
}

export interface WorkerRuntimeControlPort {
  readonly start: (input: WorkerRuntimeStartInput) => Promise<WorkerRuntimeStartResult>;
  readonly bind: (input: WorkerRuntimeBindInput) => Promise<WorkerRuntimeBindResult>;
  readonly stop: (input: WorkerRuntimeStopInput) => Promise<WorkerRuntimeControlReceipt>;
  readonly steer: (input: WorkerRuntimeSteerInput) => Promise<WorkerRuntimeControlReceipt>;
  readonly sendInput: (input: WorkerRuntimeInput) => Promise<WorkerRuntimeControlReceipt>;
}

export interface WorkerRuntimeAdapter extends WorkerRuntimeObservationPort, WorkerRuntimeControlPort {}

/** Provider-neutral supervision receives only bounded observation events. */
export type WorkerRuntimeObservationSink = (event: WorkerRuntimeObservationEvent) => void;

/** The SDK surface used by the adapter; a small structural port keeps fakes simple in tests. */
export type PiAgentSession = Pick<AgentSession, "subscribe" | "steer" | "prompt" | "abort" | "dispose">;

export type PiAgentSessionFactory = (options: CreateAgentSessionOptions) => Promise<PiAgentSession>;

export interface PiMottainaiRuntimeOptions {
  sessionFactory?: PiAgentSessionFactory;
  sessionOptions?: CreateAgentSessionOptions;
  now?: () => Date;
  observationSink?: WorkerRuntimeObservationSink;
}

const defaultSessionFactory: PiAgentSessionFactory = async (options) => {
  const result = await createAgentSession(options);
  return result.session;
};

function identityKey(identity: WorkerRuntimeIdentity): string {
  return [
    identity.managerSessionId,
    identity.runtimeId,
    identity.taskId ?? "",
    identity.executionSessionId ?? "",
    identity.provider,
  ].join("\u0000");
}

function bindingKey(binding: WorkerRuntimeBinding): string {
  return `${identityKey(binding.identity)}\u0000${binding.boundAt}`;
}

class EventChannel<T> {
  private readonly queued: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];

  push(value: T): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ done: false, value });
    } else {
      this.queued.push(value);
    }
  }

  iterable(): AsyncIterable<T> {
    const channel = this;
    return {
      [Symbol.asyncIterator](): AsyncIterator<T> {
        return {
          next(): Promise<IteratorResult<T>> {
            const value = channel.queued.shift();
            if (value !== undefined) return Promise.resolve({ done: false, value });
            return new Promise<IteratorResult<T>>((resolve) => channel.waiters.push(resolve));
          },
        };
      },
    };
  }
}

function idleStatus(): WorkerRuntimeStatusReportInput {
  return {
    lifecycleState: "running",
    phase: "ready",
    activity: { kind: "idle" },
    progress: { completed: 0, current: null, remaining: null },
    attention: "none",
  };
}

export class PiMottainaiRuntime implements WorkerRuntimeAdapter {
  private readonly sessionFactory: PiAgentSessionFactory;
  private readonly sessionOptions: CreateAgentSessionOptions;
  private readonly now: () => Date;
  private readonly observationSink: WorkerRuntimeObservationSink | undefined;
  private readonly channel = new EventChannel<WorkerRuntimeObservationEvent>();
  private session: PiAgentSession | undefined;
  private unsubscribe: (() => void) | undefined;
  private binding: WorkerRuntimeBinding | undefined;
  private status: WorkerRuntimeStatusReportInput | undefined;

  public constructor(options: PiMottainaiRuntimeOptions = {}) {
    this.sessionFactory = options.sessionFactory ?? defaultSessionFactory;
    this.sessionOptions = options.sessionOptions ?? {};
    this.now = options.now ?? (() => new Date());
    this.observationSink = options.observationSink;
  }

  public async start(input: WorkerRuntimeStartInput): Promise<WorkerRuntimeStartResult> {
    if (this.session) throw new Error("Pi Mottainai runtime is already started");

    const binding: WorkerRuntimeBinding = {
      identity: { ...input.identity },
      boundAt: input.requestedAt ?? this.timestamp(),
    };
    const reportStatusTool = createReportStatusTool({ onStatus: (status) => this.acceptStatus(status) });
    const session = await this.sessionFactory({
      ...this.sessionOptions,
      customTools: [...(this.sessionOptions.customTools ?? []), reportStatusTool],
    });
    this.session = session;
    this.binding = binding;
    this.status = idleStatus();
    this.unsubscribe = session.subscribe((event) => this.projectEvent(event));
    this.publishEvent({ kind: "started", binding, observedAt: this.timestamp() });
    return { binding };
  }

  public async bind(input: WorkerRuntimeBindInput): Promise<WorkerRuntimeBindResult> {
    this.requireSession();
    const binding: WorkerRuntimeBinding = {
      identity: { ...input.identity },
      boundAt: input.boundAt ?? this.timestamp(),
    };
    this.binding = binding;
    return { binding };
  }

  public async observe(binding: WorkerRuntimeBinding): Promise<WorkerRuntimeObservation> {
    this.requireBinding(binding);
    return {
      binding: this.binding as WorkerRuntimeBinding,
      status: this.status as WorkerRuntimeStatusReportInput,
      observedAt: this.timestamp(),
    };
  }

  public events(binding: WorkerRuntimeBinding): AsyncIterable<WorkerRuntimeObservationEvent> {
    this.requireBinding(binding);
    return this.channel.iterable();
  }

  public async steer(input: WorkerRuntimeSteerInput): Promise<WorkerRuntimeControlReceipt> {
    const session = this.requireSessionFor(input.binding);
    await session.steer(input.directive);
    return { operation: "steer", acceptedAt: this.timestamp() };
  }

  public async sendInput(input: WorkerRuntimeInput): Promise<WorkerRuntimeControlReceipt> {
    const session = this.requireSessionFor(input.binding);
    await session.prompt(input.input);
    return { operation: "input", acceptedAt: this.timestamp() };
  }

  public async stop(input: WorkerRuntimeStopInput): Promise<WorkerRuntimeControlReceipt> {
    const session = this.requireSessionFor(input.binding);
    await session.abort();
    this.status = {
      ...(this.status as WorkerRuntimeStatusReportInput),
      lifecycleState: "stopped",
      phase: "complete",
      activity: { kind: "idle" },
    };
    this.publishEvent({
      kind: "stopped",
      binding: this.binding as WorkerRuntimeBinding,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      observedAt: this.timestamp(),
    });
    return { operation: "stop", acceptedAt: this.timestamp() };
  }

  /** Dispose the owned SDK session and remove its event subscription. */
  public dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.session?.dispose();
    this.session = undefined;
    this.binding = undefined;
    this.status = undefined;
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  private requireSession(): PiAgentSession {
    if (!this.session) throw new Error("Pi Mottainai runtime is not started");
    return this.session;
  }

  private requireSessionFor(binding: WorkerRuntimeBinding): PiAgentSession {
    this.requireBinding(binding);
    return this.requireSession();
  }

  private requireBinding(binding: WorkerRuntimeBinding): void {
    if (!this.binding || bindingKey(binding) !== bindingKey(this.binding)) {
      throw new Error("Pi Mottainai runtime binding is not active");
    }
  }

  private projectEvent(event: AgentSessionEvent): void {
    if (!this.binding || !this.status) return;
    const status = mapPiAgentEvent(event);
    if (status !== undefined) this.emitStatus(status);
  }

  private emitStatus(status: Pick<WorkerRuntimeStatusReportInput, "lifecycleState" | "phase" | "activity">): void {
    this.status = {
      ...(this.status as WorkerRuntimeStatusReportInput),
      ...status,
    };
    this.publishEvent({
      kind: "status",
      binding: this.binding as WorkerRuntimeBinding,
      status: this.status,
      observedAt: this.timestamp(),
    });
  }

  private acceptStatus(status: WorkerRuntimeStatusReportInput): void {
    if (!this.binding || !this.status) throw new Error("Pi Mottainai runtime is not started");
    this.status = status;
    this.publishEvent({
      kind: "status",
      binding: this.binding,
      status,
      observedAt: this.timestamp(),
    });
  }

  private publishEvent(event: WorkerRuntimeObservationEvent): void {
    this.channel.push(event);
    this.observationSink?.(event);
  }
}

export const createPiMottainaiRuntime = (options?: PiMottainaiRuntimeOptions): PiMottainaiRuntime =>
  new PiMottainaiRuntime(options);
