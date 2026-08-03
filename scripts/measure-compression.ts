import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compressCallToolResult } from "../src/compress/index.js";

interface Sample { name: string; scale: "small" | "realistic"; command?: string; text: string; diagnostics?: string[]; }

const directory = path.dirname(fileURLToPath(import.meta.url));
const samples = JSON.parse(fs.readFileSync(path.join(directory, "fixtures/compression-samples.json"), "utf8")) as Sample[];
const rows = samples.map((sample) => {
  const compressed = compressCallToolResult({ content: [{ type: "text", text: sample.text }] }, { cli: { command: sample.command } });
  const output = compressed.content[0]?.type === "text" ? compressed.content[0].text : "";
  const diagnosticsKept = (sample.diagnostics ?? []).every((diagnostic) => output.includes(diagnostic));
  return { name: sample.name, scale: sample.scale, inputTokens: Math.ceil(sample.text.length / 4), outputTokens: Math.ceil(output.length / 4), needsArtifact: output !== sample.text, diagnosticsKept };
});
function totals(group: typeof rows) {
  const inputTokens = group.reduce((sum, row) => sum + row.inputTokens, 0);
  const outputTokens = group.reduce((sum, row) => sum + row.outputTokens, 0);
  return { inputTokens, outputTokens, outputRatio: outputTokens / inputTokens, artifactRequiredRate: group.filter((row) => row.needsArtifact).length / group.length, diagnosticsPreservedRate: group.filter((row) => row.diagnosticsKept).length / group.length };
}
console.log(JSON.stringify({ samples: rows, totals: Object.fromEntries(["small", "realistic"].map((scale) => [scale, totals(rows.filter((row) => row.scale === scale))])) }, null, 2));
