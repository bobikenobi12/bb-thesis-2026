// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Drizzle migration-history guard. drizzle snapshots are a LINEAR, un-mergeable
// chain: if two branches/worktrees each run `db:generate` off the same parent and
// then merge, two snapshots end up claiming the same prevId — which permanently
// jams `db:generate` with a "collision" error (and people then hand-author SQL
// without snapshots, widening the drift). This check catches that the moment it
// lands instead of weeks later. It validates three invariants:
//   1. journal ↔ .sql parity — every journal tag has a `<tag>.sql`, and vice-versa;
//   2. no two journal entries share an `idx`;
//   3. the present `*_snapshot.json` files form a valid linear chain — unique ids,
//      no two sharing a `prevId` (the fork detector), every non-genesis prevId
//      resolving to a present snapshot id.
// NOTE: snapshots may have historical gaps (a one-time repair grafts a fresh
// current-schema snapshot onto an earlier parent), so we do NOT require one
// snapshot per journal entry — only that the present ones chain cleanly.

import { execSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "../lib/db/migrations");
const metaDir = join(migrationsDir, "meta");
const GENESIS = "00000000-0000-0000-0000-000000000000";

const errors = [];

// ── journal ↔ .sql parity + duplicate idx ──────────────────────────────────
const journal = JSON.parse(readFileSync(join(metaDir, "_journal.json"), "utf8"));
const entries = journal.entries ?? [];

const seenIdx = new Set();
for (const e of entries) {
	if (seenIdx.has(e.idx)) errors.push(`duplicate journal idx ${e.idx}`);
	seenIdx.add(e.idx);
}

const sqlFiles = new Set(
	readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")),
);
const journalTags = new Set(entries.map((e) => e.tag));

for (const e of entries) {
	if (!sqlFiles.has(`${e.tag}.sql`)) {
		errors.push(`journal entry "${e.tag}" has no matching ${e.tag}.sql`);
	}
}
for (const f of sqlFiles) {
	if (!journalTags.has(f.replace(/\.sql$/, ""))) {
		errors.push(`migration ${f} is not referenced by _journal.json (it will never run)`);
	}
}

// ── snapshot chain integrity (the fork detector) ────────────────────────────
const snapshotFiles = readdirSync(metaDir)
	.filter((f) => /^\d+_snapshot\.json$/.test(f))
	.sort();

const ids = new Map(); // id -> file
const prevIds = new Map(); // prevId -> file
for (const f of snapshotFiles) {
	const snap = JSON.parse(readFileSync(join(metaDir, f), "utf8"));
	const { id, prevId } = snap;

	if (ids.has(id)) errors.push(`snapshots ${ids.get(id)} and ${f} share id ${id}`);
	ids.set(id, f);

	if (prevIds.has(prevId)) {
		// The exact corruption that jams db:generate.
		errors.push(
			`snapshots ${prevIds.get(prevId)} and ${f} share prevId ${prevId} — ` +
				`migration history forked (two migrations generated off the same parent). ` +
				`Rebase onto the target branch and re-generate so it chains off the latest snapshot.`,
		);
	}
	prevIds.set(prevId, f);
}

// Every non-genesis prevId must resolve to a present snapshot id.
for (const [prevId, file] of prevIds) {
	if (prevId !== GENESIS && !ids.has(prevId)) {
		errors.push(`snapshot ${file} points at missing parent snapshot id ${prevId}`);
	}
}

// ── 4. cross-branch collision: an idx `dev` already uses under a DIFFERENT tag ──────
// Invariants 1-3 only see THIS tree, so a branch stays internally consistent right up to the
// moment it merges — which is exactly how #1355 happened: it added 0128_nifty_boom_boom while
// dev had already landed 0128_striped_agent_zero. git can only surface that as a conflict in
// meta/_journal.json AFTER the work is done, and the remedy (delete + rebase + RE-GENERATE,
// not "resolve the conflict") is non-obvious. Catch it at PR time instead.
//
// Deliberately tolerant in two directions: a branch merely BEHIND dev shares idx→tag exactly
// and passes — that is the overwhelmingly common case and must never be flagged. And if dev's
// journal cannot be read (shallow clone, no remote, a fresh checkout before fetch) we SKIP
// rather than fail: a guard that wedges CI on a checkout quirk is worse than the bug it stops.
try {
	const devJournalRaw = execSync(
		"git show origin/dev:apps/console/lib/db/migrations/meta/_journal.json",
		{ cwd: here, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
	);
	const devByIdx = new Map(
		(JSON.parse(devJournalRaw).entries ?? []).map((e) => [e.idx, e.tag]),
	);
	for (const e of entries) {
		const devTag = devByIdx.get(e.idx);
		if (devTag && devTag !== e.tag) {
			errors.push(
				`migration index ${e.idx} collides with origin/dev — this branch has "${e.tag}", dev has "${devTag}"`,
			);
		}
	}
} catch {
	// origin/dev unreadable here — skip this invariant rather than fail the build.
}

if (errors.length > 0) {
	const collided = errors.some((e) => e.includes("collides with origin/dev"));
	console.error("✗ migration history check failed:\n");
	for (const e of errors) console.error(`  • ${e}`);
	if (collided) {
		// The fix is NOT to resolve the conflict by hand — the snapshot chain cannot be merged.
		console.error(
			"\n  Another migration already claims that index on dev, so this chain cannot merge.\n" +
				"  Do NOT hand-resolve meta/_journal.json or the snapshot. Instead:\n" +
				"    1. delete your migration's .sql AND its meta/<idx>_snapshot.json\n" +
				"    2. take dev's meta/_journal.json + snapshot, then rebase onto origin/dev\n" +
				"    3. re-run `pnpm -C apps/console run db:generate` — it re-emits your change at the next\n" +
				"       free index, chained off dev's latest snapshot\n",
		);
	} else {
		console.error(
			"\n  drizzle snapshots are a linear chain — never run `db:generate` in two\n" +
				"  worktrees/branches off the same base. Rebase first, then re-generate.\n",
		);
	}
	process.exit(1);
}

console.log(
	`✓ migrations OK — ${entries.length} journal entries, ${sqlFiles.size} SQL files, ` +
		`${snapshotFiles.length} snapshots chain cleanly`,
);
