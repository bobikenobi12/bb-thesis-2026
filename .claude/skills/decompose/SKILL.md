---
name: decompose
description: Turn a maintainer-authored feature/wave spec into a well-formed GitHub-Issues coordination board — an interface-first seams issue plus disjoint-scope lane issues — as a dry-run proposal the maintainer approves before any issue is created. Use when a maintainer wants to decompose a wave/feature spec onto the board, "seed the board", "break this spec into issues", or bootstrap a wave.
license: MIT
metadata:
  author: alethia
  source: alethialabs-io/skills (mirror the source-of-truth per .claude/skills/README.md)
  version: "1.0.0"
---

# Decompose a spec into a claimable board

Decomposition used to be 100% manual: the maintainer hand-authored the seams issue and every fine
lane, and hand-checked that no two claimable units shared a `scope:` glob. This skill does the draft
+ the mechanical check, then **hands a proposal back to the maintainer to approve** — the maintainer
keeps the judgement call, gets the typing time back. Read `.claude/COORDINATION.md` first (§"The board
(hybrid)", §"The two work classes", §"Bootstrapping a wave") — this skill emits exactly that contract.

**Never create issues before the maintainer approves the dry-run proposal.** The flow is
draft → validate → show → WAIT → (on approval) seed.

## 1. Read the spec

The input is a maintainer's feature/wave design doc — usually in the private **`dataroom`** repo under
`spec/features/`, or a doc pasted into the conversation. Identify:

- **The wave** it belongs to (`wave:W1`…`wave:W7`, or `wave:hygiene`) — the doc or `00-NORTH-STAR.md`
  says which.
- **The shared contract** — the types / DB schema / interface every lane depends on. This becomes the
  single **seams** issue.
- **The independent lanes** — server actions, runner, core/tofu, canvas, tests, docs — each owning a
  **disjoint** set of files. These become the fine issues, each `blocked-by:` the seams issue.

If the spec is thin or ambiguous, **grill it first** (the `grilling` skill) — a vague spec decomposes
into overlapping lanes, which is exactly the tangle this board prevents.

## 2. Draft the proposal (interface-first)

Produce a JSON array of proposed issues — the shape the validator consumes. One **seams** unit (title
says "seams", blocked by no other PROPOSED unit), then fine lanes each `blockedBy` the seams unit,
each with a **disjoint** `scope`:

```json
[
  {
    "id": 1,
    "title": "seams: project_placement shared types + schema contract",
    "labels": ["wave:W1", "lane:schema", "class:backend"],
    "scope": ["apps/console/lib/db/schema/project_placement.ts", "apps/console/types/jsonb.types.ts"],
    "blockedBy": []
  },
  {
    "id": 2,
    "title": "placement server actions",
    "labels": ["wave:W1", "lane:server", "class:backend"],
    "scope": ["apps/console/app/server/actions/placement/**"],
    "blockedBy": [1]
  },
  {
    "id": 3,
    "title": "placement canvas node config sheet",
    "labels": ["wave:W1", "lane:canvas", "class:ui"],
    "scope": ["apps/console/components/canvas/placement/**"],
    "blockedBy": [1]
  }
]
```

Rules the validator enforces (get them right up front):

- **One seams issue, `class:backend`, no `blocked-by`.** It lands fast so every lane unblocks. It owns
  the shared types/schema/contract — nothing else does.
- **Every lane is `blocked-by:` the seams issue** (reference it by its proposal `id`; the validator
  rewires these to real issue numbers on seed).
- **Disjoint scopes.** No two **co-claimable** units (siblings — neither blocks the other) may share a
  file glob. A lane may narrow a file the seams issue also owns (they are never claimable at once), but
  two sibling lanes must never overlap. Split by resource group / directory — `lib/db/schema/foo.ts`,
  `app/server/actions/foo/**`, `internal/agent/foo/**`, `components/.../foo/**`.
- **Correct labels** from the board set: one `wave:*`, one `class:*`, and a `lane:*`. The valid
  names are **data** — `scripts/lib/board-labels.json`, which is also what the validator reads, so
  ask it (`jq -r '.labels[]|select(.kind=="lane")|.name'`) rather than trusting a list typed here.
  A retyped list is how `lane:console` was minted and then never used by anyone following this
  file. Note `lane:canvas` owns the canvas subtree and `lane:console` owns the console *excluding*
  it. Add `mutex:migration` to the single lane that runs `pnpm -F console db:generate`. Do NOT set
  `claimed`/`blocked` — those are runtime labels.
- **Routing** — the full rule is `.claude/COORDINATION.md` §"The two work classes"; this is the
  short form, and if the two ever disagree that file wins. Infra/backend work is `class:backend`
  (autonomous). Visual work splits on **whether a design decision is still open**, not on whether
  the diff touches a `.tsx`:
  - *Adopting a primitive that is already decided* — a raw `<h2>` → `SectionHeading`, a
    bespoke centred div → `EmptyState` — is `class:backend`. CLAUDE.md §6 is the spec; the unit
    ships the check that keeps it true, and it **must** declare that check (see below).
  - *Changing a page's information architecture, or inventing a pattern the table does not name* is
    `class:ui` — deliverable is a data-model-grounded **design spec** (per `alethia-design`),
    human-gated, not an autonomous merge. Because the backend lanes define the model first, UI
    specs always have a stable model to consume.

  The test to apply: *could two competent implementations of this unit disagree about how it should
  look?* If yes it is `class:ui`.
- **A `lane:console` + `class:backend` unit MUST declare a `check:` line**, naming the command that
  proves the adoption. The validator enforces this. Routing conformance work away from the human
  gate is only safe if something else measures it — "we adopted the primitive everywhere" is a
  claim, and an unmeasured claim is how the drift being fixed got there.

## 3. Validate — refuse to seed on any collision

Pipe the proposal through the validator. It checks the anti-tangle invariant (no two co-claimable units
share a scope glob — overlap/prefix-subsumption, not just exact match), that every non-seams unit has a
`blocked-by`, that labels are from the known set, and that the `blocked-by` graph is acyclic. It also
reads the **live open board** and applies the same anti-tangle invariant against every open unit
`claim-work.sh` would hand out, because a proposal that is internally disjoint can still collide with a
lane someone is already holding:

```
echo "$PROPOSAL_JSON" | node scripts/decompose-validate.mjs
# or: node scripts/decompose-validate.mjs proposal.json
```

**If it prints `✗ FAIL`, do NOT seed.** Fix the proposal (split the overlapping scopes into disjoint
lanes, add the missing `blocked-by`, correct the label) and re-validate until it prints `✓ PASS`. The
validator is the same guard a human would run by eye — a failure means the board would tangle.

A collision with an **open board** issue that is genuinely intended — the new wave supersedes that
lane, say — is cleared by naming its number in the proposal unit's `blockedBy` (`"blockedBy": [900]`).
That ordering is inherited transitively, so putting it on the seams unit covers every lane behind it,
and a board number there does not stop a unit being the seams unit. `--no-board` skips the live read
entirely and is for a deliberate offline run, not for getting past a collision.

**That exemption is a promise you have to keep at seed time.** The validator judges the *proposal*;
it cannot see the issues you go on to create. The unit that named the board number must carry that
number on its own `blocked-by:` line in the seeded issue body (§5) — **including the seams issue**,
which otherwise has none. Seed it without and the ordering the `✓ PASS` was granted for never
reaches the board: `coordinate.sh` leaves the unit unblocked and `claim-work.sh` hands it out
alongside the very issue it overlaps. On PASS the validator prints one `⚠ board ordering` line per
unit with a board `blockedBy`, naming the exact line to seed; treat each as a seeding obligation.

## 4. Show the maintainer and WAIT

Present the full proposal for approval — do not create anything yet. Show:

- Each unit's **title · labels · scope globs**.
- The **blocked-by DAG** (seams at the root; lanes hanging off it).
- The validator's `✓ PASS` line.

Then **stop and wait for explicit approval.** The maintainer may re-scope a lane, re-label, or split
one further — re-validate after any edit. This is the human judgement the skill preserves.

## 5. Seed (only on approval)

Once the maintainer approves, ensure the labels exist and create the issues — **seams first**, capture
its number, then the lanes referencing that real number:

```bash
scripts/coordinate.sh --init-labels        # idempotent; ensures the board label set exists

# Seams issue first. It carries NO blocked-by *unless* its proposal unit named open board issues
# in `blockedBy` to clear a live-board collision (§3) — then those numbers go in its body too, on
# their own `blocked-by:` line, exactly as a lane's do. Capture its number.
SEAMS=$(gh issue create \
  --title "seams: project_placement shared types + schema contract" \
  --label "wave:W1" --label "lane:schema" --label "class:backend" \
  --body "$(cat <<'EOF'
<one-line intent; link the wave doc>

Wave doc: dataroom spec/features/<doc>.md

scope: apps/console/lib/db/schema/project_placement.ts apps/console/types/jsonb.types.ts
EOF
)" | grep -oE '[0-9]+$')

# Each lane — blocked-by the seams number, disjoint scope.
gh issue create \
  --title "placement server actions" \
  --label "wave:W1" --label "lane:server" --label "class:backend" \
  --body "$(cat <<EOF
<one-line intent>

Wave doc: dataroom spec/features/<doc>.md

blocked-by: #$SEAMS
scope: apps/console/app/server/actions/placement/**
EOF
)"
# … repeat per lane; class:ui lanes also carry --label "needs:design".
```

The issue **body** must carry the two machine-read lines exactly (this is what `claim-work.sh` and
`coordinate.sh` parse):

- `blocked-by: #<n> #<n>` — **every** prerequisite this unit is ordered behind. For a lane: the seams
  issue, plus any other. For the **seams issue**: normally absent — but if its proposal unit named
  open board issues in `blockedBy` to clear a collision (§3), those numbers MUST be written here.
  This line is the *only* thing that carries the ordering onto the board — `coordinate.sh` computes
  the `blocked` label from it and nothing else — so a seams issue seeded without one that its
  proposal claimed is unblocked from the moment it is created, and `claim-work.sh` hands it out
  concurrently with the open issue it overlaps. That is the mega-commit tangle, behind a `✓ PASS`.
- `scope: <glob> <glob>` — the disjoint file globs this unit owns.

After seeding, run `scripts/coordinate.sh` once so it computes the `blocked` labels from each
`blocked-by:` line (lanes show `blocked` until the seams issue closes). Then **read the labels back**:
every unit whose body names a still-open prerequisite — the seams issue included, when §3's escape
hatch was used — must now be labelled `blocked`. One that is not has a `blocked-by:` line the parser
did not see (wrong line, or inside a code fence), and it is claimable right now. Then merge the seams
issue fast → downstream unblocks → instances `scripts/claim-work.sh` and go.

## Alethia notes

- **Provenance:** skills are mirrored from `alethialabs-io/skills` (see `.claude/skills/README.md`) —
  land durable edits there and `bash scripts/sync-skills.sh` back, so every worktree/instance loads the
  same version.
- **This operationalizes** the "wayfind / never start coding without a plan" working-discipline rule and
  the `.claude/COORDINATION.md` bootstrap — the board **is** the wayfinder; this skill fills it.
- **The invariant is load-bearing.** A single shared `scope:` glob between two claimable units is how the
  mega-commit tangle happened (the "Shared-checkout entanglement" incident — one `git add -A` swept three
  features into one commit). The validator exists so a bad board is caught before it is seeded, not after.
