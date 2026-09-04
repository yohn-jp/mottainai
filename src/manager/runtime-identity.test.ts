import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorkflowStore } from "../test-support/workflow-store.js";
import type { ManagerRuntimeId, RegisterManagerRuntimeInput } from "../workflow/state/store.js";
import { ManagerError, ManagerSessionService } from "./service.js";
import type { ZellijObservedState, ZellijRuntime } from "./zellij.js";

class IdentityFakeRuntime implements ZellijRuntime {
  async checkAvailability(): Promise<{ version: string }> {
    return { version: "fake-zellij 0.0.0" };
  }
  async inspect(_sessionName: string): Promise<ZellijObservedState> {
    return "absent";
  }
  async start(): Promise<void> {}
  async attach(): Promise<void> {}
  async terminate(): Promise<void> {}
  binaryName(): string {
    return "fake-zellij";
  }
}

function runtimeInput(overrides: Partial<RegisterManagerRuntimeInput> = {}): RegisterManagerRuntimeInput {
  return {
    runtimeId: "runtime-a" as ManagerRuntimeId,
    targetKind: "remote",
    displayName: "Linux A",
    address: "ssh://runtime-a",
    ...overrides,
  };
}

test("Manager Runtime registry keeps canonical identity across display/address changes and restart", (t) => {
  const store = createWorkflowStore(t);
  const first = store.registerManagerRuntime(runtimeInput({ registeredAt: 10 }));
  const changed = store.registerManagerRuntime(
    runtimeInput({ displayName: "Renamed Linux A", address: "ssh://runtime-a-new", registeredAt: 20 }),
  );

  assert.equal(changed.runtimeId, first.runtimeId);
  assert.equal(changed.displayName, "Renamed Linux A");
  assert.equal(changed.address, "ssh://runtime-a-new");
  assert.equal(store.getManagerRuntime(first.runtimeId)?.runtimeId, "runtime-a");
  assert.equal(store.listManagerRuntimes().length, 2); // migrated canonical local Runtime plus runtime-a
  assert.equal(
    store.listManagerRuntimes().find((runtime) => runtime.runtimeId === "runtime-a")?.configProvenance,
    undefined,
  );
});

test("Manager Runtime registry rejects identity collisions instead of adopting another target", (t) => {
  const store = createWorkflowStore(t);
  store.registerManagerRuntime(runtimeInput());

  assert.throws(
    () => store.registerManagerRuntime(runtimeInput({ runtimeId: "runtime-b" as ManagerRuntimeId })),
    /identity collision/u,
  );
  assert.throws(() => store.registerManagerRuntime(runtimeInput({ targetKind: "existing" })), /identity collision/u);
  assert.throws(
    () => store.registerManagerRuntime(runtimeInput({ targetKind: "local", address: "local" })),
    /identity collision/u,
  );
});

test("Runtime registry persistence has no credential-bearing columns", (t) => {
  const store = createWorkflowStore(t);
  store.registerManagerRuntime(runtimeInput({ configProvenance: "profile-a", registeredAt: 100 }));
  const runtimes = store.listManagerRuntimes();
  assert.deepEqual(Object.keys(runtimes[0] ?? {}).sort(), [
    "address",
    "configProvenance",
    "createdAt",
    "displayName",
    "lastSeenAt",
    "runtimeId",
    "state",
    "targetKind",
    "updatedAt",
  ]);
  assert.equal(JSON.stringify(runtimes).includes("credential"), false);
  assert.equal(JSON.stringify(runtimes).includes("secret"), false);
});

test("Manager service binds sessions to its configured Runtime and preserves renamed identity", async (t) => {
  const store = createWorkflowStore(t);
  const runtime = new IdentityFakeRuntime();
  const first = new ManagerSessionService({
    workspaceRoot: "/workspace",
    store,
    runtime,
    runtimeConfig: { runtimeId: "remote-a", targetKind: "remote", address: "ssh://a", displayName: "A" },
  });
  await first.initialize();
  assert.equal(first.health().runtime.runtimeId, "remote-a");
  assert.equal(first.health().runtime.state, "available");

  const renamed = new ManagerSessionService({
    workspaceRoot: "/workspace",
    store,
    runtime,
    runtimeConfig: {
      runtimeId: "remote-a",
      targetKind: "remote",
      address: "ssh://a-new",
      displayName: "A renamed",
    },
  });
  await renamed.initialize();
  assert.deepEqual(renamed.health().runtime, {
    runtimeId: "remote-a",
    targetKind: "remote",
    displayName: "A renamed",
    address: "ssh://a-new",
    configProvenance: undefined,
    state: "available",
    createdAt: first.health().runtime.createdAt,
    updatedAt: renamed.health().runtime.updatedAt,
    lastSeenAt: renamed.health().runtime.lastSeenAt,
  });

  const conflicting = new ManagerSessionService({
    workspaceRoot: "/workspace",
    store,
    runtime,
    runtimeConfig: { runtimeId: "remote-b", targetKind: "remote", address: "ssh://a-new" },
  });
  await assert.rejects(
    conflicting.initialize(),
    (error: unknown) => error instanceof ManagerError && error.code === "runtime_identity_collision",
  );
});
