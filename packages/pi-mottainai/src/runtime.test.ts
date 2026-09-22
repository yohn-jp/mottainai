import assert from "node:assert/strict";
import test from "node:test";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import {
  PiMottainaiRuntime,
  type PiAgentSession,
  type WorkerRuntimeBinding,
  type WorkerRuntimeIdentity,
} from "./runtime.js";

class FakeSession implements PiAgentSession {
  public readonly calls: string[] = [];
  private listener: ((event: AgentSessionEvent) => void) | undefined;
  private unsubscribed = false;

  public subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.calls.push("subscribe");
    this.listener = listener;
    return () => {
      this.unsubscribed = true;
      this.calls.push("unsubscribe");
    };
  }

  public async steer(_text: string): Promise<void> {
    this.calls.push("steer");
  }

  public async prompt(_text: string): Promise<void> {
    this.calls.push("prompt");
  }

  public async abort(): Promise<void> {
    this.calls.push("abort");
  }

  public dispose(): void {
    this.calls.push("dispose");
  }

  public emit(event: AgentSessionEvent): void {
    this.listener?.(event);
  }

  public get wasUnsubscribed(): boolean {
    return this.unsubscribed;
  }
}

const identity: WorkerRuntimeIdentity = {
  managerSessionId: "manager-session",
  runtimeId: "runtime-1",
  taskId: "task-1",
  provider: "pi",
};

async function startedRuntime(session: FakeSession): Promise<{ runtime: PiMottainaiRuntime; binding: WorkerRuntimeBinding }> {
  const runtime = new PiMottainaiRuntime({
    sessionFactory: async () => session,
    now: () => new Date("2026-01-01T00:00:00.000Z"),
  });
  const { binding } = await runtime.start({ identity });
  return { runtime, binding };
}

test("starts an injected AgentSession and projects subscription events", async () => {
  const session = new FakeSession();
  const { runtime, binding } = await startedRuntime(session);
  const events = runtime.events(binding)[Symbol.asyncIterator]();

  assert.deepEqual((await events.next()).value, {
    kind: "started",
    binding,
    observedAt: "2026-01-01T00:00:00.000Z",
  });

  session.emit({ type: "agent_start" });
  assert.deepEqual((await events.next()).value, {
    kind: "status",
    binding,
    status: {
      lifecycleState: "running",
      phase: "executing",
      activity: { kind: "working" },
      progress: { completed: 0, current: null, remaining: null },
      attention: "none",
    },
    observedAt: "2026-01-01T00:00:00.000Z",
  });

  assert.deepEqual((await runtime.observe(binding)).status.activity, { kind: "working" });
  assert.deepEqual(session.calls, ["subscribe"]);
});

test("keeps observation read-only and delegates explicit controls", async () => {
  const session = new FakeSession();
  const { runtime, binding } = await startedRuntime(session);

  await runtime.observe(binding);
  assert.deepEqual(session.calls, ["subscribe"]);

  await runtime.steer({ binding, directive: "Continue" });
  await runtime.sendInput({ binding, input: "Run the task" });
  await runtime.stop({ binding, reason: "finished" });
  assert.deepEqual(session.calls, ["subscribe", "steer", "prompt", "abort"]);
});

test("disposes the owned session and subscription", async () => {
  const session = new FakeSession();
  const { runtime } = await startedRuntime(session);

  runtime.dispose();
  assert.equal(session.wasUnsubscribed, true);
  assert.deepEqual(session.calls, ["subscribe", "unsubscribe", "dispose"]);
});
