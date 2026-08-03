import assert from "node:assert/strict";
import { test } from "node:test";
import { stripAnsi } from "./ansi.js";

const ESC = "\x1b";

test("stripAnsi removes CSI color codes", () => {
  const input = `${ESC}[31mred${ESC}[0m plain`;
  assert.equal(stripAnsi(input), "red plain");
});

test("stripAnsi removes CSI cursor-movement codes", () => {
  const input = `${ESC}[2K${ESC}[1Gline`;
  assert.equal(stripAnsi(input), "line");
});

test("stripAnsi removes OSC sequences terminated by BEL", () => {
  const input = `${ESC}]0;window title${String.fromCharCode(7)}visible`;
  assert.equal(stripAnsi(input), "visible");
});

test("stripAnsi removes OSC sequences terminated by ESC \\\\", () => {
  const input = `${ESC}]8;;http://example.com${ESC}\\link${ESC}]8;;${ESC}\\`;
  assert.equal(stripAnsi(input), "link");
});

test("stripAnsi preserves newlines and tabs", () => {
  const input = "a\nb\tc";
  assert.equal(stripAnsi(input), "a\nb\tc");
});

test("stripAnsi is a no-op on plain text", () => {
  const input = "no escapes here";
  assert.equal(stripAnsi(input), input);
});
