import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { test } from "node:test";
import os from "node:os";
import path from "node:path";
import { closeDashboard, parseDashboardOptions, startDashboard } from "./command.js";
import { DASHBOARD_PROVIDER_ENV } from "./provider.js";

test("dashboard startup gives an explicit provider precedence over the process environment", async () => {
  const previous = process.env[DASHBOARD_PROVIDER_ENV];
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "mottainai-dashboard-provider-"));
  try {
    process.env[DASHBOARD_PROVIDER_ENV] = "fixture";
    const cliOptions = parseDashboardOptions(["--no-open", "--port", "0", "--provider", "live"]);
    const cliHandle = await startDashboard({ ...cliOptions, viewerHtml: "", workspaceRoot });
    try {
      const cliProject = (await fetch(`${cliHandle.url}api/v1/project`).then((response) => response.json())) as {
        provenance: { provider: string };
      };
      assert.equal(cliProject.provenance.provider, "live-repository-model");
    } finally {
      await closeDashboard();
    }
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
    if (previous === undefined) delete process.env[DASHBOARD_PROVIDER_ENV];
    else process.env[DASHBOARD_PROVIDER_ENV] = previous;
  }
});

test("dashboard startup serves Wabachi over the semantic query API and shared stylesheet", async () => {
  const handle = await startDashboard({ noOpen: true, port: 0, provider: "fixture" });
  try {
    const viewerResponse = await fetch(handle.url);
    assert.equal(viewerResponse.status, 200);
    const viewer = await viewerResponse.text();
    assert.match(viewer, /Wabachi — Semantic Investigation Desk v2/);
    assert.match(viewer, /<body class="wabachi">/);
    assert.match(viewer, /\/api\/v1\/project/);
    assert.match(viewer, /\/api\/v1\/changes/);
    assert.match(viewer, /\/api\/v1\/projections\/review/);
    assert.doesNotMatch(viewer, /Semantic Project Viewer/);
    assert.doesNotMatch(viewer, /semantic-project-viewer-v\d+/);

    const styleResponse = await fetch(`${handle.url}styles.css`);
    assert.equal(styleResponse.status, 200);
    assert.match(styleResponse.headers.get("content-type") ?? "", /^text\/css/);
    assert.match(await styleResponse.text(), /\/\* WABACHI \*\//);
  } finally {
    await closeDashboard();
  }
});
