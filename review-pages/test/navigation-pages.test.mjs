import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { refreshNavigationPages } from "../src/navigation-pages.mjs";

function tempSite() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-review-pages-nav-"));
}

function publishNavigation(siteDir, prNumber, headSha, shortId = headSha.slice(0, 12)) {
  const prDir = path.join(siteDir, "reviews", "pr", String(prNumber));
  fs.mkdirSync(prDir, { recursive: true });
  const prIndex = { number: prNumber, latest: { headSha, shortId } };
  fs.writeFileSync(path.join(prDir, "index.json"), JSON.stringify(prIndex));
  refreshNavigationPages(siteDir, prNumber, prIndex);
}

test("stable PR route points at the latest immutable revision", () => {
  const siteDir = tempSite();
  try {
    const first = "1".repeat(40);
    const second = "2".repeat(40);
    publishNavigation(siteDir, 747, first);
    let html = fs.readFileSync(path.join(siteDir, "reviews", "pr", "747", "index.html"), "utf8");
    assert.match(html, new RegExp(`${first}/`, "u"));

    publishNavigation(siteDir, 747, second);
    html = fs.readFileSync(path.join(siteDir, "reviews", "pr", "747", "index.html"), "utf8");
    assert.match(html, new RegExp(`${second}/`, "u"));
    assert.doesNotMatch(html, new RegExp(`${first}/`, "u"));
  } finally {
    fs.rmSync(siteDir, { recursive: true, force: true });
  }
});

test("site root lists stable routes for every published PR", () => {
  const siteDir = tempSite();
  try {
    publishNavigation(siteDir, 701, "a".repeat(40), "aaaaaaaaaaaa");
    publishNavigation(siteDir, 747, "b".repeat(40), "bbbbbbbbbbbb");

    const html = fs.readFileSync(path.join(siteDir, "index.html"), "utf8");
    assert.match(html, /reviews\/pr\/701\//u);
    assert.match(html, /reviews\/pr\/747\//u);
    assert.ok(html.indexOf("PR #747") < html.indexOf("PR #701"), "newer PR numbers are listed first");
  } finally {
    fs.rmSync(siteDir, { recursive: true, force: true });
  }
});

test("invalid PR index data is omitted from root navigation", () => {
  const siteDir = tempSite();
  try {
    publishNavigation(siteDir, 747, "c".repeat(40));
    const invalidDir = path.join(siteDir, "reviews", "pr", "748");
    fs.mkdirSync(invalidDir, { recursive: true });
    fs.writeFileSync(path.join(invalidDir, "index.json"), JSON.stringify({ latest: { headSha: "not-a-sha" } }));

    publishNavigation(siteDir, 747, "d".repeat(40));
    const html = fs.readFileSync(path.join(siteDir, "index.html"), "utf8");
    assert.match(html, /PR #747/u);
    assert.doesNotMatch(html, /PR #748/u);
  } finally {
    fs.rmSync(siteDir, { recursive: true, force: true });
  }
});
