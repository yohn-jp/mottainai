import assert from "node:assert/strict";
import { test } from "node:test";
import { HandleRegistry } from "./handles.js";

test("register returns an opaque id that resolves back to the stored value", () => {
  const registry = new HandleRegistry<string>();
  const id = registry.register("payload");
  assert.notEqual(id, "payload");
  assert.equal(registry.get(id), "payload");
});

test("unknown id resolves to undefined (invalid handle)", () => {
  const registry = new HandleRegistry<string>();
  assert.equal(registry.get("mh_does-not-exist"), undefined);
});

test("a handle from one registry is not resolvable in another (cross-connection rejection)", () => {
  const a = new HandleRegistry<string>();
  const b = new HandleRegistry<string>();
  const id = a.register("secret");
  assert.equal(b.get(id), undefined);
});

test("register never reuses ids across calls (accidental collision avoidance)", () => {
  const registry = new HandleRegistry<number>({ createId: (() => {
    let n = 0;
    return () => String(n++);
  })() });
  const first = registry.register(1);
  const second = registry.register(2);
  assert.notEqual(first, second);
});

test("delete removes the entry and calls its disposer exactly once", () => {
  const registry = new HandleRegistry<string>();
  let disposed = 0;
  const id = registry.register("value", () => { disposed += 1; });
  registry.delete(id);
  assert.equal(registry.get(id), undefined);
  assert.equal(disposed, 1);
  registry.delete(id);
  assert.equal(disposed, 1);
});

test("dispose tears down every remaining entry via its disposer and empties the registry", () => {
  const registry = new HandleRegistry<string>();
  const disposedValues: string[] = [];
  registry.register("a", (value) => disposedValues.push(value));
  registry.register("b", (value) => disposedValues.push(value));
  assert.equal(registry.size, 2);
  registry.dispose();
  assert.equal(registry.size, 0);
  assert.deepEqual(disposedValues.sort(), ["a", "b"]);
});
