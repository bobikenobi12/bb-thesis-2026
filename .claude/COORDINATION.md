# Instance coordination — the claimable board

Many AI instances (Claude, Codex, and humans) drive the north star in parallel. Isolation and integration are already
solved by the multi-instance rules in `CLAUDE.md` (one worktree per instance via `pnpm wt`; PR → `dev`;
**Mergify auto-queues + squash-merges every non-draft, conflict-free `dev` PR on green** — you run no
`gh pr merge` and never merge directly; lock-guarded
migrations). **This file is the missing third half: how work is
distributed** so N instances claim disjoint work without collision, respect dependencies, and never tangle
each other's files.

It is the runner job-model applied to instances: a **claimable job table** (GitHub Issues), an **atomic
claim** (mkdir-lock), a **lease + reclaim** for a dead instance's work (like #534 orphan-reclaim), a **mutex**
on shared state (migrations, like `db:generate`), and **serialize-per-state-object** (disjoint file lanes,
like #530). You already built and debugged this for provisioning — this reuses its lessons.

## The board (hybrid)

- **GitHub Issues = the live execution board.** One issue per claimable work unit. Labels:
  - `wave:<name>` — which programme. **The set is DATA, in `scripts/lib/board-labels.json`** — that
    file is what `coordinate.sh --init-labels` mints and what `decompose-validate.mjs` accepts, so
    it is the answer, and any list retyped in prose here is a copy that will decay. It already has:
    the enumeration below once named seven tracks while thirteen were live. `jq -r '.labels[]
    | select(.kind=="wave") | .name' scripts/lib/board-labels.json` for the real set;
    `scripts/coordinate.sh --report` for which of them carry open work.
  - `lane:*` — the file-ownership lanes, **also from that file** (`select(.kind=="lane")`). Two are
    easy to confuse: `lane:canvas` owns `apps/console/components/design-project/canvas/**` and
    `apps/console/lib/canvas/**`; `lane:console` owns the rest of the console's pages and
    components and must EXCLUDE that subtree, or the two lanes are not disjoint and the anti-tangle
    invariant means nothing.
  - `class:backend` or `class:ui` — the routing rule (below).
  - `claimed` — set when an instance holds it; carries a **lease comment**.
  - `blocked` — maintained by `coordinate.sh`: present while any `blocked-by` is still open.
  - `mutex:migration` — this unit generates a drizzle migration (serialized; see below).
  - `needs:design` / `needs:human` — a UI unit awaiting the human/Claude-Design pipeline.
  - `epic` — an umbrella/tracking issue. **Never directly built or claimed**: it is decomposed
    into sub-issues, and claiming it would collide with every one of them.
- The issue **body** declares machine-read lines. Each must start its own line at column 0 — the
  parsers scan the whole body, so writing one of these tokens in prose (even inside backticks, even
  in a sentence saying the line was removed) re-declares it. That has already happened once, on
  #3617; #3639 tracks anchoring the parsers.
  - `blocked-by: #12 #14` — units that must close first.
  - `scope: apps/console/lib/db/schema/** packages/core/types/**` — the files this unit owns (globs). No two
    open+claimable issues in a wave may share a scope glob — that is how the mega-commit tangle is prevented.
    Like `blocked-by:`, this is a MACHINE-READ line: it must start at column 0 and must not be wrapped in
    backticks, or every parser reads the unit as unscoped and the invariant goes unenforced for it.
    `scripts/coordinate.sh` names such units under "NOT CHECKED" rather than counting them as disjoint.
  - `check: pnpm check:shared-surface` — **required on a `lane:console` or `lane:canvas` unit that
    is `class:backend`**, and enforced by `decompose-validate.mjs`. Those are the lanes that own
    rendered UI, so routing one to `class:backend` is the decision that skips the human design gate
    (see "The two work classes"); it is sound only because something else measures the claim. The
    command need not be new — naming the existing one that fails if the adoption regresses is the
    point. Both lanes carry the rule because a one-lane version is escapable by relabelling.
- **The ledger = the plan.** Wave design docs live in the private `alethialabs-io/dataroom` repo
  (`spec/features/`), not in this one. Board = execution state; ledger = design. An issue links
  its wave doc by URL.

## The two work classes (the routing rule)

**`class:backend`** — server actions, runner, schema, core, tofu, tests, docs. **Fully autonomous:**
claim → `pnpm wt` → build → **open a non-draft PR into `dev`** → **Mergify lands it on green** (it auto-queues
every non-draft, conflict-free `dev` PR and squash-merges it in order, validating each on its own branch — you
run NO `gh pr merge`). The human is NOT in the loop.

**`class:ui`** — canvas, components, anything visual. **Human-in-the-loop.** A UI unit starts with a **UI
design spec grounded in the data model** the backend lanes define (the seams issue + `project_*` schema),
authored per the `alethia-design` skill and shaped for **Claude Design** ingestion. Its implementation PR MUST
open as a **draft**. Draft is the mechanical gate Mergify already honours: the agent never runs `gh pr ready`,
and only the maintainer marks the PR ready after accepting the design decision. Once ready, the ordinary queue
may land it on green. A `class:ui` issue lands `needs:design` and surfaces to the human. Because backend lanes
define the data model first, UI specs always have a stable model to consume (never pixels-before-schema). This
operationalizes the "UI work is a spec" rule without pretending the issue label itself controls Mergify.

**The line is whether a design decision is still open — not whether the diff touches a `.tsx`.** "Anything
visual is `class:ui`" was written when every UI unit was a new surface, and read literally it routes
*conformance* work — replacing a hand-rolled `<h2>` with `SectionHeading`, a bespoke centred div with
`EmptyState` — into a design-spec queue that has nothing to decide. CLAUDE.md §6 already made those calls; the
unit is adopting them. So:

- **Adopting a decided primitive, with a gate that proves it → `class:backend`.** The shared-surface table in
  CLAUDE.md §6 *is* the spec, and the unit ships the check that keeps it true. No `needs:design`.
- **Changing a page's information architecture, or inventing a pattern the table does not name →
  `class:ui`.** Rebuilding a page, adding a surface, choosing a new interaction: those still surface to the
  human with a design spec.

The test to apply: *could two competent implementations of this unit disagree about how it should look?* If
yes it is `class:ui`. If the answer is written down and the unit's job is to make the tree match it, it is
`class:backend` — and a unit that routes itself `class:backend` on this rule **must** land the check alongside
the change, because "we adopted the primitive everywhere" is a claim, and an unmeasured claim is how the
drift got here. That is not left to good intentions: a `lane:console`/`lane:canvas` + `class:backend` unit
without a `check:` line is rejected by `decompose-validate.mjs` before the board can be seeded.

## The protocol

Every instance, at kickoff, reads this file, then:

```
scripts/claim-work.sh --class backend      # atomically claim the next ready backend unit
cd ../wt-<slug>                             # the script prints the pnpm wt slug
# ... build; open a NON-DRAFT PR into dev with "Closes #<n>"; Mergify auto-queues + squash-merges on green (run NO gh pr merge) ...
scripts/complete-work.sh <n>               # usually unnecessary — see below; a manual backstop that closes + de-claims
scripts/claim-work.sh --class backend      # loop
```

- **Closing is automatic — but only on a CLOSING KEYWORD.**
  `.github/workflows/close-on-dev-merge.yml` parses every merged dev PR's title and body for
  `close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved #<n>` and closes those issues.
  GitHub's own auto-close does not fire here because `dev` is not the default branch, which is
  why the Action exists.

  **A bare `(#n)` does NOT close.** The squash-merge convention appends `(#n)` to the PR title,
  and that is a *mention*, not a delivery — as is `Part of #n`. Both are deliberately excluded
  (a mention closing an issue is how you close unfinished work), and `claim-work.sh --self-test`
  pins it. So: **a multi-tier unit's final PR must carry `Closes #<n>` in the body.** Putting the
  number in the title is not enough, and nothing will tell you at merge time.

  When it is missed anyway, the backstops are `complete-work.sh <n>`, `coordinate.sh
  --close-shipped` (keyword-strict, mutating), and the **possibly-shipped advisory** in the board
  report — which *does* match a bare title ref, flags it `LIKELY`, and mutates nothing. Verify
  against `origin/dev` before closing on it: a reference is not a delivery in either direction.

- **Atomic claim** (`claim-work.sh`): acquires `/tmp/alethia-claim.lock` (atomic `mkdir`, stale-reclaim by
  pid — same primitive as `compose-up.sh`), picks the next issue that is `open`, not `claimed`, not `blocked`,
  in the requested class, honoring the migration mutex, then assigns `@me` + `claimed` + posts a lease comment,
  then releases the lock. The lock serializes the pick-and-assign critical section across all **same-box**
  instances.
- **Cross-box safety (claim-work.sh, two guards).** The mkdir-lock is a same-box mutex, and every instance
  authenticates as the **same GitHub user** (so the assignee can't distinguish them) — nothing stops two
  *different machines* from claiming one unit (this caused the #587 / #611 / #842 duplicate builds). Two guards
  close it:
  - **Pre-claim PR guard** — before assigning a candidate, skip it if an **open or merged** PR already closes
    it (`Closes #n`). Catches work in flight on another box, and the stale-open case (an issue whose PR merged
    but GitHub never auto-closed, e.g. #687 → merged #824).
  - **Claim-and-verify (earliest-lease-wins)** — after assigning + leasing, wait `ALETHIA_CLAIM_VERIFY_DELAY`
    (default 5s), re-read the issue's lease comments, and let the lease with the **earliest GitHub-server
    `createdAt`** win (tiebreak: lowest `instance`). Server timestamps are skew-free, so every contender
    computes the *same* winner: the first claimer keeps it, later claimers **cede** (post a `ceded:` comment and
    re-pick — they do NOT remove the shared `claimed` label/assignee, which the winner also set). `--self-test`
    exercises the winner logic against fixtures; set `ALETHIA_CLAIM_VERIFY_DELAY=0` to disable (same-box-only).
- **NEVER hand-claim a unit** (assigning `@me` / adding `claimed` by hand): it bypasses BOTH the lock and the
  claim-and-verify, which is exactly how the #842 dup happened. If `claim-work.sh` offers a stale or wrong unit
  (e.g. its work already merged, or it needs a maintainer decision), **fix the board so the script skips it** —
  `gh issue close <n>` the done one, or `gh issue edit <n> --remove-label class:backend` an un-actionable one —
  don't reach around the script to grab a different issue.
- **Working a `needs:human` / `class:ui` unit: `scripts/claim-work.sh --issue <n>`.** Those units are excluded
  from autonomous picking (they await a maintainer decision) but they are NOT exempt from claiming — that was
  the gap behind #1247: unclaimable meant unprotected, so the only path was the forbidden hand-claim, leaving
  no lease and nothing to stop a second instance starting the same unit. `--issue` runs the full lock + lease +
  verify on one named unit; it refuses if the unit is closed, already claimed, or already has a closing PR.
  A `class:ui` implementation PR opens as a **draft** and stays draft until the maintainer marks it ready; the
  building agent must never run `gh pr ready`. This is the actual merge gate — Mergify does not read the class
  label, and will auto-queue any non-draft, conflict-free `dev` PR once its review threads are resolved.
- **A worktree is leased too, separately from the issue.** `pnpm wt:who` shows holders; another instance cannot
  write in, remove, or commit from a worktree you hold. See CLAUDE.md → "One worktree per instance". The two
  leases answer different questions — the issue lease says *who is building this unit*, the worktree lease says
  *whose files these are right now* — and #1247 needed both.
- **Lease + reclaim**: the lease comment carries `instance · pid · branch · UTC-timestamp`. Refresh it on each
  PR push (the worker) — or let `coordinate.sh` reclaim a unit whose lease is older than `ALETHIA_LEASE_TTL`. Reclaim
  skips a unit that already has an **open closing PR** (evidence the holder is alive despite a stale lease) and
  a unit whose lease timestamp is unreadable. Reclaim = clear assignee + `claimed`, comment "reclaimed".
- **Stalled units** (`⚠ stalled` in the report): claimed, lease long dead, and the PR that stops the reclaim is
  itself stuck — CONFLICTING, or untouched for `ALETHIA_PR_IDLE_TTL` (default `4 × LEASE_TTL`). These are
  **reported, never auto-reclaimed**, deliberately. The board↔PR guards are fail-closed by contract, and
  reclaiming would not even help: `claim-work.sh` Guard 1 skips any unit with an open closing PR, so stripping
  the label would only make the unit *look* ready while the loop kept skipping it. Take one over with
  `scripts/claim-work.sh --issue <n>`, then rebase or close its PR. Both `--report` and the default full run
  print this; only the reclaim writes are full-only.
- **Migration mutex**: only ONE open issue may hold `mutex:migration` claimed at a time. `claim-work.sh`
  refuses to claim a second. Never run `pnpm -F console db:generate` in two worktrees at once — the drizzle
  snapshot chain is un-mergeable (this is the board-level guard on top of `scripts/db-generate.sh`).
- **File-scope discipline**: only claim/build within your issue's `scope:` globs. Never `git add -A`; stage
  only your scope. If you need a file outside your scope, it belongs to another unit — coordinate, don't grab.

## The coordinator (hybrid — you-in-loop-for-UI)

`scripts/coordinate.sh` is the light shared brain any instance or the maintainer runs (on demand, or wrapped
in `/loop` for an always-on backend engine):

- **Reclaim** stale leases (dead instances).
- **Unblock**: recompute the `blocked` label from each issue's `blocked-by` (remove it once all blockers close).
- **Report** the board: per-wave open/claimed/blocked/done counts, who holds what and for how long, the ready
  (claimable) set, and any **collisions** to eyeball — two claimed issues sharing `mutex:migration`, and two
  simultaneously-workable issues (claimed or ready) whose `scope:` globs overlap.
  **Both halves print a verdict either way, and there are three of them, not two:** overlap found · compared
  and clean · *could not compare*. That last one is a unit with no `scope:` line, one whose declaration is
  wrapped in backticks (invisible to the parser, though it reads as scoped to a human), or a glob that is not
  a path. An unread scope is not a disjoint one, so those units are named rather than dropped out of the
  comparison — the report says "compared 17 of 22", never a bare silence.
  *This sentence described behaviour that did not exist until #4115: the scope half had never been written,
  and the absence of a warning line — which meant only "at most one claimed migration unit" — read as "no two
  claimed units share a scope".* The predicate itself is `scripts/lib/scope-overlap.mjs`, the same one
  `decompose-validate.mjs` applies at seed time, so the continuous check and the seed-time check cannot
  disagree.
- **Surface UI**: list `needs:design` units for the human.

Backend flows without you. UI surfaces to you. The coordinate pass is not an always-on single point of
failure — it is stateless over the board, so any instance can run it.

## Bootstrapping a wave

1. Author the wave design doc in `management/spec/features/` and grill it.
2. Create the labels (once): `scripts/coordinate.sh --init-labels` (or `gh label create …`).
3. Seed **interface-first**: one small `class:backend` "seams" issue (the shared types/schema/contract) with
   no `blocked-by`; then the fine lanes (`blocked-by:` the seams issue), each with a disjoint `scope:`.
4. Merge the seams issue fast → downstream unblocks → instances claim and go.

## The toolchain

Everything below already exists; none of it was reachable from this file.

| Tool | What it is for |
|---|---|
| `scripts/engine.sh` | The autonomous build-loop driver: `claim` · `heartbeat <n>` · `complete <n>` · `coordinate` · `status`. **Exit code 3 from `claim` means the board is drained — stop the loop.** It never merges, never applies IaC. |
| `.claude/skills/foundry/SKILL.md` | What an agent invokes to *drive* `engine.sh` in a loop. This, not `/loop`, is the always-on backend engine. |
| `.claude/skills/decompose/SKILL.md` | Turns a wave spec into a well-formed board as a dry-run proposal you approve. This is the "Bootstrapping a wave" workflow below, automated. |
| `scripts/decompose-validate.mjs` | Validates a proposed board: disjoint scopes (with prefix-subsumption detection), `blocked-by` presence, known labels, acyclic DAG. Has `--self-test`. |
| `scripts/lib/scope-overlap.mjs` | The ONE scope-glob matcher (normalize · `**` as zero-or-more · prefix subsumption · wildcard segments) plus the live-board audit behind coordinate.sh's report. Shared by all three surfaces after each answered the question differently. `--report` reads a board on stdin; `--json`; `--self-test` (fixtures + mutation controls). |
| `scripts/board-dashboard.mjs` | Read-only HTML dashboard: per-wave READY/CLAIMED/BLOCKED/DONE, in-flight dev PRs with check rollups, scope collisions, and a "NEEDS YOU" panel. `--out`, `--open`, `--json`. |
| `scripts/lib/board-pr.sh` | Shared, fail-closed board↔PR predicates. Extracted after two copies drifted and silently stopped matching `Fixes #n`. |
| `scripts/merge-signal-health.sh` | Tracks whether the observe-only heavy E2Es are reliable enough to promote to required. |

**Environment knobs:** `ALETHIA_LEASE_TTL` (3600s) · `ALETHIA_PR_IDLE_TTL` (4× lease TTL) ·
`ALETHIA_CLAIM_VERIFY_DELAY` (5s; `0` disables the verify pass) · `ALETHIA_CLAIM_WINDOW` (45s) ·
`ALETHIA_INSTANCE_ID` (overrides the derived instance identity).
