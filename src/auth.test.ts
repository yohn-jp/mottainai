import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadOAuthCredentialProvider, resolveBrokerEndpoint } from "./auth.js";

test("loads a generic OAuth credential provider module and resolves a broker endpoint", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-oauth-"));
  const modulePath = path.join(directory, "provider.mjs");
  fs.writeFileSync(modulePath, "export default { resolveEndpoint: async () => 'http://127.0.0.1:9393/mcp' };\n");
  try {
    const provider = await loadOAuthCredentialProvider("./provider.mjs", directory);
    assert.ok(provider !== undefined);
    assert.equal(
      (await resolveBrokerEndpoint(provider, new URL("https://mcp.example.test/mcp"), "example")).toString(),
      "http://127.0.0.1:9393/mcp",
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("sanitizes OAuth provider failures and rejects non-HTTP broker endpoints", async () => {
  await assert.rejects(
    () => resolveBrokerEndpoint({ resolveEndpoint: async () => { throw new Error("secret-token"); } }, new URL("https://mcp.example.test/mcp"), "example"),
    /oauth broker resolution failed: example/,
  );
  await assert.rejects(
    () => resolveBrokerEndpoint({ resolveEndpoint: async () => "file:///tmp/mcp" }, new URL("https://mcp.example.test/mcp"), "example"),
    /oauth broker returned invalid endpoint: example/,
  );
});
