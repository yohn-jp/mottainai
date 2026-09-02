import assert from "node:assert/strict";
import test from "node:test";
import { findLinkedIssueNumber, extractAcceptanceCriteria } from "../src/lib/markdown.mjs";

test("finds a GitHub closing keyword reference", () => {
  assert.equal(findLinkedIssueNumber("## Linked issue\nCloses #704\n"), 704);
  assert.equal(findLinkedIssueNumber("Fixes #12 and more text"), 12);
  assert.equal(findLinkedIssueNumber("resolved #99"), 99);
});

test("returns null when there is no linked issue", () => {
  assert.equal(findLinkedIssueNumber("no reference here"), null);
  assert.equal(findLinkedIssueNumber(""), null);
  assert.equal(findLinkedIssueNumber(null), null);
});

test("extracts checklist items under an Acceptance criteria heading", () => {
  const body = [
    "## Problem",
    "irrelevant",
    "## Acceptance criteria",
    "- [ ] first item",
    "- [x] second item",
    "- [X] third item",
    "## Non-goals",
    "- [ ] not counted",
  ].join("\n");

  assert.deepEqual(extractAcceptanceCriteria(body), [
    { text: "first item", checked: false },
    { text: "second item", checked: true },
    { text: "third item", checked: true },
  ]);
});

test("returns an empty list when there is no such heading", () => {
  assert.deepEqual(extractAcceptanceCriteria("## Problem\nno checklist here"), []);
});
