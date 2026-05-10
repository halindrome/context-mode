#!/usr/bin/env node
// Sync version from package.json to all manifest files.
// Runs automatically via npm `version` lifecycle hook.

import { readFileSync, writeFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const version = pkg.version;

console.log(`→ syncing version ${version} to manifests...`);

const targets = [
  ".claude-plugin/plugin.json",
  ".claude-plugin/marketplace.json",
  ".cursor-plugin/plugin.json",
  ".openclaw-plugin/openclaw.plugin.json",
  ".openclaw-plugin/package.json",
  "openclaw.plugin.json",
  ".pi/extensions/context-mode/package.json",
];

for (const file of targets) {
  try {
    const content = JSON.parse(readFileSync(file, "utf8"));
    if (content.version !== undefined) content.version = version;
    if (content.metadata?.version !== undefined) content.metadata.version = version;
    if (content.plugins) {
      for (const p of content.plugins) {
        if (p.version !== undefined) p.version = version;
      }
    }
    writeFileSync(file, JSON.stringify(content, null, 2) + "\n");
    console.log(`  ✓ ${file}`);
  } catch (e) {
    console.log(`  ⚠ ${file} — ${e.message}`);
  }
}

// Root package.json hosts the OMP plugin manifest under the `omp` field
// (read by upstream loader via `pkg.omp || pkg.pi` per refs/platforms/
// oh-my-pi/packages/coding-agent/src/extensibility/plugins/loader.ts:75).
// The loader stamps `manifest.version = pluginPkg.version` at load time, so
// in practice version is implicit. We still keep an explicit `omp.version`
// in sync here so an inspector reading package.json sees the right number
// without needing to run the loader.
try {
  const rootPkgRaw = readFileSync("package.json", "utf8");
  const rootPkg = JSON.parse(rootPkgRaw);
  let touched = false;
  if (rootPkg.omp && typeof rootPkg.omp === "object") {
    if (rootPkg.omp.version !== version) {
      rootPkg.omp.version = version;
      touched = true;
    }
  }
  if (touched) {
    // Preserve the trailing newline npm writes so diffs stay clean.
    const trailing = rootPkgRaw.endsWith("\n") ? "\n" : "";
    writeFileSync("package.json", JSON.stringify(rootPkg, null, 2) + trailing);
    console.log(`  ✓ package.json (omp.version → ${version})`);
  }
} catch (e) {
  console.log(`  ⚠ package.json omp.version sync — ${e.message}`);
}

console.log(`✓ all manifests at v${version}`);
