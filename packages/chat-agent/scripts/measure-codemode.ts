/**
 * Offline tool-surface measurement (task 722e12 verification).
 *
 * Builds the trimmed codemode tool with stub host/executor and prints
 * its description size + composition. No deploy needed — every
 * input is static.
 *
 * Run: pnpm --filter @data-agent/chat-agent exec tsx scripts/measure-codemode.ts
 */
import { createCodeTool } from "@cloudflare/codemode/ai";
import { artifactTools, chartTools } from "../src/tools/artifact-tools";
import { dbTools } from "../src/tools/db-tools";

// artifact/chart tools only read .name + .workspace for url / path
// composition, never inside `description` generation. Stubs are fine.
const host = { name: "measure", workspace: {} as never };
const fakeGetDb = async () => {
  throw new Error("not invoked");
};

const tools = [dbTools(fakeGetDb), artifactTools(host), chartTools(host)];
const fakeExecutor = { execute: async () => ({ result: null }) } as never;
const tool = createCodeTool({ tools, executor: fakeExecutor });
const desc = tool.description ?? "";

const report = {
  totalChars: desc.length,
  approxTokens: Math.round(desc.length / 4),
  namespaces: {
    db: desc.includes("declare const db"),
    artifact: desc.includes("declare const artifact"),
    chart: desc.includes("declare const chart"),
    state: desc.includes("declare const state"), // expect false
    vegaLite: desc.includes("declare const vegaLite"), // expect false
  },
  chartSurface: {
    save: /chart:\s*\{[\s\S]*?save\(/.test(desc),
    bar: /chart:\s*\{[\s\S]*?bar\(/.test(desc), // expect false
    line: /chart:\s*\{[\s\S]*?line\(/.test(desc), // expect false
    histogram: /chart:\s*\{[\s\S]*?histogram\(/.test(desc), // expect false
    spec: /chart:\s*\{[\s\S]*?spec\(/.test(desc), // expect false
  },
};

console.log(JSON.stringify(report, null, 2));
