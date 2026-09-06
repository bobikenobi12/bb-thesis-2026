// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const files = execFileSync("git", ["ls-files"], { encoding: "utf8" })
  .split("\n")
  .filter(Boolean);
// Files permitted to mention `@alethia/ee` as a quoted string.
//
// The string rule below is deliberately BROAD — any quoted occurrence — and it must stay that
// way. It is NOT a sloppy stand-in for the import-syntax rule beneath it. The one file that
// genuinely loads the package does so through a VARIABLE, on purpose (lib/enterprise.ts:181-183):
// it assigns the package name to `pkg` as a plain string, then calls
// `createRequire(import.meta.url)(pkg)`,
// so the bundler cannot statically resolve it in a community build. No `from`/`require(`/
// `import(` pattern can see that, which means narrowing this rule to import syntax would let a
// copy of the codebase's own idiom cross the boundary undetected. Measured, not assumed: a
// resolution-syntax regex matches ZERO files in this repo, `lib/enterprise.ts` included.
//
// The cost of staying broad is that a file which merely NAMES the package — a manifest, a config
// list, or a guard reasoning about whether ee/dist gets built — trips it. That is what this
// allowlist is for, and it is the cheaper half of the trade.
const allowedPackageReference = new Set([
  // Genuinely resolves it (via the variable idiom above).
  "apps/console/lib/enterprise.ts",
  // Names it as an external, never imports it.
  "apps/console/next.config.ts",
  // Manifests and images.
  "apps/console/package.json",
  "apps/console/Dockerfile",
  "apps/console/README.md",
  "scripts/dev-up.sh",
  "scripts/box/env-mode.sh",
  "pnpm-workspace.yaml",
  "pnpm-lock.yaml",
  // Reads dependency stanzas to decide whether a CI job builds ee/dist. Imports nothing: its
  // whole import list is `node:fs` and `node:path`, and its occurrences are comments plus a
  // property lookup on parsed JSON.
  "scripts/check-floors-reproducible.mjs",
  // Declares `@alethia/ee` as the one pnpm filter allowed to select NOTHING, because the
  // community application must build with ee/ absent (ee/README.md). Imports nothing: the name
  // is a Map key in an EXCEPTIONS ledger and a self-test fixture. Same shape as the entry above
  // — a guard reasoning ABOUT the package rather than reaching for it.
  "scripts/ci/check-pnpm-script-refs.mjs",
]);
const violations = [];

for (const file of files) {
  if (
    file.startsWith("ee/") ||
    file.endsWith(".md") ||
    file.endsWith(".mdx") ||
    allowedPackageReference.has(file)
  ) {
    continue;
  }
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  if (/['"]@alethia\/ee['"]/.test(text)) {
    violations.push(
      `${file}: imports or resolves @alethia/ee outside the boundary`,
    );
  }
  if (
    /\bfrom\s+['"][^'"]*\/ee(?:\/|['"])/.test(text) ||
    /\brequire\(\s*['"][^'"]*\/ee(?:\/|['"])/.test(text)
  ) {
    violations.push(`${file}: imports the enterprise directory by path`);
  }
}

const communityDocker = readFileSync(
  "apps/console/Dockerfile.community",
  "utf8",
);
for (const required of [
  "RUN rm -rf ee",
  "ALETHIA_EDITION=community",
  "pnpm install --frozen-lockfile --filter console...",
]) {
  if (!communityDocker.includes(required)) {
    violations.push(`Dockerfile.community: missing ${required}`);
  }
}

if (violations.length) {
  console.error("Open-core boundary violations:");
  for (const violation of violations) console.error(`  ${violation}`);
  process.exit(1);
}
console.log("OK — community/enterprise repository boundary is explicit.");
