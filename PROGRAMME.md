<!-- SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io> -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# The MVP programme

**Read this first, every session.** It is the one file that answers _where is the programme, what is
proven, and what is next_ — so that nobody has to re-derive it by reading fifteen boards, and nobody
has to re-brief it after a context clear.

The programme is one sentence:

> Establish cloud parity across **hetzner · aws · gcp · azure · alibaba** for the full product
> capability surface, prove every demo scenario end-to-end on each cloud, and drive all of it through
> the `alethia` CLI — so the MVP is provably reached. Then, and only then, UI.

## How to rejoin it — four commands

```bash
git -C <the main checkout> pull --ff-only   # 1. hooks, CLAUDE.md AND this file load from app/,
                                            #    which is pinned to dev but never auto-pulled.
cat PROGRAMME.md                            # 2. intent, status, and the single mechanical next.
pnpm wt:who && scripts/coordinate.sh --report   # 3. who holds what; the live board delta.
scripts/claim-work.sh --issue <n>           # 4. claim. Never by hand.
```

Command 1 is first and it is not optional. A stale harness at least gets a SessionStart warning; a
stale **ledger** gets none, so reading this file out of an unpulled checkout means resuming the
programme as it stood days ago with nothing to tell you.

This file **ranks; it never claims.** The board claims, via `scripts/claim-work.sh`. If the
mechanical next names an issue that is closed or already claimed, that is a board fix — never a
reach-around to a different issue. If a cell has no issue at all, the first act is to decompose it
onto the board, because the ledger is not a work queue.

## §0 · What "MVP reached" means

Six predicates. They are written to be **checked by a script, not read as prose**, because the thing
that went wrong before was a board asserting a state the tree disagreed with.

1. **Capability parity is recorded, and the debt has a shrinking balance.** All three generated
   parity boards regenerate byte-identical, and every kind the product refuses on a cloud is either a
   documented ceiling with provider evidence or a debt item with an open issue.
2. **Every proof cell carries a real-apply proof.** For every (cloud × dimension) cell, the proof
   ledger's surviving claim must be a PASS whose bundle exists in the tree — never a green harness,
   never an expiring CI run tag.
3. **No `DeferredInProduct` cells remain** in `test/e2e/maxconfig.go` — the last product debt in the
   capability matrix.
4. **Driven from the CLI**: zero `CLIGap` verdicts, and a committed `cli-demo` proof row per cloud
   (the bar's real-binary half must actually have executed).
5. **Every demo scenario is asserted** — a set difference, both directions, between the runbook beats
   plus the per-cloud tutorial pages and the harness steps that assert them.
6. **Nothing is standing, and the boards are fresh** — the orphan reaper reports no leaks per cloud,
   and no board cites a closed issue as open.

**Declared ratchet ceilings** — human-set, machine-enforced, may only ever decrease:

| ratchet | ceiling | meaning |
| --- | --- | --- |
| `template_parity.baseline` | 301 | grandfathered asymmetric root variables |
| `cli_gap` | 0 | CLI debt is cleared and must stay cleared |
| `deferred_in_product` | 0 | no kind is chart-backed-but-unwired on any cloud |

## §1 · Ordering, and why this order

The phases below are **intent**. Their state is rendered under the marker; do not restate it here.

1. **Make the boards true.** A board that disagrees with the tree makes every later spend decision
   wrong, and correcting one costs nothing. This comes first even though it touches no cloud.
2. **Unblock the cadence.** Every later phase is a loop of _dispatch → read → fix_, so the loop's
   period is the programme's period. See decision D1.
3. **The floor, on all five clouds.** Nothing above the floor is measurable until a cloud provisions
   and converges at all.
4. **Parity ratchets** — fully parallel with 3 and 5, because per-cloud template trees are disjoint
   and touch no credential and no migration. This is where N-way agent parallelism actually lives.
5. **The full bar, per cloud, by dispatch** — blocked on a durable ledger and on that cloud's floor.
6. **Scenario layers, then the CLI bar** — one gate per dispatch, then unset it.
7. **The MVP predicate, then UI.** See decision D5 — the UI conformance wave is qualified out of this
   ordering, not exempted from it.

## §2 · Standing decisions

Dated and numbered. Superseded in place, never deleted — a decision whose reasoning has been
overtaken is more useful than a gap.

- **D1 · 2026-08-17 · Real applies may federate from `dev` via a branch-restricted Environment.**
  The nightly's OIDC subjects pin `refs/heads/main`, but the work happens on `dev`, so every
  iteration otherwise serialises on a maintainer promotion — and promoting to `main` to iterate on a
  _test_ also ships the _product_ (release-please, the console and fleet deploys, the CLI release all
  trigger there). So: a GitHub Environment restricted to `dev`, trusted additionally by the e2e
  roles. `infra/aws-oidc` and `infra/azure-e2e` already support an `environment:` subject;
  `infra/alibaba-e2e`'s trust was verified live on 2026-08-27 and is ALREADY a list, admitting
  both `ref:refs/heads/main` and `environment:e2e-dev`; `infra/gcp-e2e` still needs its scalar
  subject widened.
  **The compensating control is load-bearing**: a branch-protection ruleset on `dev` requiring
  CODEOWNERS review for `.github/workflows/**` and `infra/**` only. Widening the trust is dangerous
  precisely because Mergify auto-lands PRs and CODEOWNERS is advisory off `main`; two globs remove
  that one path and leave every other lane autonomous. Required _reviewers_ stay off — that would
  reintroduce a human in every run, which is the thing being removed. The cron keeps its `main`-only
  ref subject, so scheduled spend does not widen at all.

- **D2 · 2026-08-17 · The parity axis is the 19 canvas `NodeKind`s; the proof axis is the 11
  provisionable kinds.** The 19 are what the product offers and what `alethia project component
  kinds` lists, with availability driven by one file
  (`apps/console/lib/cloud-providers/unsupported-kinds.ts`). The 11 are the subset a real apply can
  demonstrate in tofu state or as a named Application. The 18 marketplace add-ons are one dimension
  of the proof grid, not a third axis.

- **D3 · 2026-08-17 · All four cloud ceilings are in MVP scope.** Delegating a real DNS zone
  (registrar action) is the highest-leverage single action available: it is the only ceiling failing
  the CLI bar on every cloud, and it is what makes the certificate path provable at all. Hetzner's
  two deferred kinds close. The Azure full-bar quota is checked and raised if needed. Hetzner object
  storage keys and the GCP billing-budgets grant are obtained.

- **D4 · 2026-08-17 · The full bar is dispatch-only; no timer starts it.** The weekly cron fanned the
  whole 11-kind surface across five clouds while the pre-apply cost ceiling was wired for one, and
  bought a standing monthly prepaid resource on alibaba each week. A CI guard now fails the build if
  a scheduled cron resolves to the full bar unless every cloud in the matrix is priced — see #2385,
  which also tracks pricing the four unpriced clouds. Restoring a schedule is a per-cloud decision
  gated on that cloud being priced _and_ having a committed full-bar proof row.

- **D5 · 2026-09-01 · Console UI conformance runs as its own wave, in parallel — the phase ordering
  above is not amended, it is qualified.** §1 puts UI last, and the one-sentence intent says "then,
  and only then, UI". That ordering is about *spend and proof*: a UI phase that competes for the
  five-cloud dispatch budget, the single branch-env slot, or the maintainer's review attention would
  push the proof cells out, and that is still refused.

  `wave:console-ui` (epic #3613) competes for **no cloud dispatch budget** — that is the resource the
  ordering exists to protect, and the one this wave genuinely does not touch. Its recurring gate runs
  in CI rather than against a real cloud, and its instrument half is pure-Node static analysis. Note
  that gate is not free to wire: the config is `apps/console/playwright.config.ts` (there is no root
  copy), Postgres comes from a per-job `services:` block in `ci.yml` rather than from the config, and
  `assertNoDeadZone()` fails a run whose project has no CI job — so the wave needs a NEW ci.yml job,
  which is #3632's scope. "Already boots one" understated that.

  That is the whole of the argument; the two stronger claims an earlier draft made are not true and
  are recorded here as refused rather than quietly dropped:

  - **Its scopes are NOT disjoint from the rest of the tree.** They are mostly `apps/console/**`, but
    #3614 owns a route-manifest module in the shared `scripts` tree, #3617 owns the sandbox env
    scripts, and #3632 owns the CI workflow — and those last two are exactly the shared files a
    disjointness argument would need to exclude. `ci.yml` was edited by e2e/infra/coverage work three
    times last month (#3586, #3457, #3298) and `scripts/env.sh` by the isolation-ladder work (#3449).
    Collision is possible and the mitigation is the ordinary one — `scripts/claim-work.sh` refuses an
    overlapping claim — not a property of this wave.
  - **It DOES compete for the maintainer's review attention**, the third protected resource. Four of
    its units (#3628–#3631) carry `class:ui` + `needs:design`, which `.claude/COORDINATION.md`
    defines as human-in-the-loop with a human-gated merge. That is a real cost and it is the one to
    weigh when deciding whether to run this wave now.

  On the branch-env slot: #3633 needs it; #3632 does not (its own body says it costs CI minutes, not
  a sandbox box), so the `#3617 → #3632 → #3633` chain serialises correctly but its middle term is
  ordering, not contention. Those edges live on the board and are hand-maintained — read them there
  rather than trusting this paragraph, which is exactly the "this file ranks; it never claims"
  rule from the preamble.

  The decision is recorded here because the alternative is worse than the reordering: a ledger that
  reads "then, and only then, UI" while a UI wave is being built is a ledger disagreeing with the
  tree, which §1's own first phase exists to prevent. The ordering claim that remains true, and is
  the one worth keeping: **no cell of the proof grid may be deferred for it.**

## §3 · Anti-patterns

Each one is a mistake this repo has already paid for.

- **Never hand-edit below the marker.** Status is derived. `pnpm gen:programme` regenerates it, and
  CI diff-gates the result — a typed number is a number that will rot.
- **Never write status into the intent half.** The rollup greps for verdict glyphs, derived counts and
  "is green"/"is proven" phrasing, and fails the build. If it trips on a _definition_ rather than a
  claim, reword the definition imperatively ("every cell must carry a proof") rather than loosening
  the guard — the phrasing is cheaper to change than the protection. That grep
  is the only structural reason a sixteenth hand-maintained board cannot re-emerge inside this file.
- **Never promote a cell by asserting it.** A proof is a surviving ledger claim plus a bundle that
  exists. Four rows once claimed PASS on runs that had skipped at the gate, and had to be retracted.
- **Never correct a ledger row in place.** Append a `RETRACTED` row naming what it supersedes and the
  evidence that invalidates it. History is not rewritten.
- **Never widen a ceiling to clear a red.** A ceiling is a fact about a cloud. If a chart in this
  repo backs the capability, it is our debt and must read as debt.
- **Never re-derive programme state by exploring the tree.** That burns the context this file exists
  to save, and produces a second, unreviewed answer that will disagree with this one.
- **Never turn a cloud gate on from an agent session.** Enabling real spend is the maintainer's.
  Surface it and stop.

## §4 · How the live half stays honest

Two things cannot be derived from the tree — **whether a gate variable is set**, and **whether a cited
issue is still open**. Both now come from `docs/testing/programme-snapshot.json`, refreshed by
`.github/workflows/programme.yml` (which opens a PR; it never pushes) and carrying variable and secret
**names only, never values**.

The snapshot is a *committed file*, so everything downstream stays a deterministic function of the
tree and the PR diff gate never depends on a live GitHub read. Three rules keep it from lying:

- **`unknown` never collapses.** With no snapshot, a gate is not "unwired" and a red is not "stale" —
  a cell may not be reclassified on the strength of a file nobody fetched.
- **A closed citation is information, not a lint.** A cell whose last verdict is FAIL but whose issue
  is closed has had its cause fixed and needs a **re-run**, so it renders `stale` and ranks first — a
  re-run is the cheapest action available. The ledger row is append-only and is never rewritten: it
  was true when written; what was wrong was reading it as open work.
- **Staleness is an error eventually.** A broken refresh produces no signal at all, so the age lives
  in the snapshot: it warns past 48 hours and **fails past 7 days**.

A gate the workflow *derives from the dimension* (`ALETHIA_E2E_MAX_CONFIG`, `_ALL_ADDONS`, `_SOAK`)
is never reported unwired — there is no variable to set, and a dispatch reaches it. Only a gate a
maintainer must actually wire can be `unwired`, and a gate the workflow never mentions is
`no vehicle`, which is a different remedy.

## §5 · The CLI programme — epic #3612

Predicate #4 asks for a `cli-demo` proof row per cloud. Reaching it is not one unit of work, so it
is decomposed as a programme, and **#3612** is the umbrella: the census it starts from, the rulings
the maintainer has made, the wave ordering, and the resume protocol.

Two things sit under that predicate, and only the first is obvious:

- **The CLI cannot be driven comfortably.** The bar asks whether `alethia <cmd> --help` exits 0,
  which the enterprise-demo tutorial satisfies while asking a reader to hand-assemble a four-field
  colon tuple three times and copy four opaque IDs between commands. So a `cli_ux` ratchet **will
  join** `cli_gap` — it is not declared yet, and §0's ceiling table is the place it becomes real,
  in the wave that implements it. Its intended numbers: copied placeholders in the golden-path
  docs, commands with no interactive path, entries in the CLI surface allowlist, and `Mirrors the
  Go X` claims with no mechanism behind them. Each may only decrease, and each must fail loudly at
  a zero census.
- **The CLI and the console are two implementations of one product.** A census of pure-logic pairs
  found rules written twice on both sides, several of them disagreeing — including both ends of a
  fail-closed gate and a path-traversal grammar looser than the shared one beside it. The tally
  lives on #3612, where closing a lane updates it; a number typed here would be stale the first
  time a wave lands and nothing would regenerate it.

Sharing is decided by what the thing *is*, not by which language reached it first. Data — enums,
vocabulary, regexes, limits, tokens — is codegen'd TS to Go and diff-gated. An algorithm gets a
generated conformance table both sides are tested against, because what must agree is the output.
A struct crossing the wire gets a fixture plus a strict decode in both directions.

**Direction follows authority.** The console owns formatting, so TypeScript generates the formatter
table; Go owns the apply gate, so Go generates the compat fixture. And the CLI's own validation is
a provable subset: it may only ever reject what the server would certainly reject, so drift can
make it too permissive — which the server catches — but never too strict.

Work is claimed from the board, never hand-picked: `scripts/coordinate.sh --report`, then
`scripts/claim-work.sh --class backend`.

<!-- BEGIN GENERATED: programme-rollup · tree-derived · DO NOT EDIT BELOW -->

## Where the programme actually is

**23 of 35 proof cells are proven.** 1 failing · 0 contested (the ledger and the board disagree) · 0 stale (cause fixed, needs a re-run) · 0 blocked · 11 never run.

A cell is `proven` only when the proof ledger's surviving claim is PASS **and** its bundle is a committed path that exists. A PASS carrying an expiring CI run tag is not a proof — that is why every 2026-07-22 row was retracted, and the rule is enforced here rather than remembered.

### Proof grid — cloud × dimension

| cloud | floor | all kinds | 18 add-ons | GitOps repos | BYO-IaC | day-2 | CLI-driven |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **aws** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | · |
| **gcp** | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | · |
| **azure** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | · |
| **alibaba** | · | · | · | · | · | · | · |
| **hetzner** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | · |

Legend: ✅ proven · ❌ failing · ⛔ blocked · · never-run · ♻️ stale · ⚠️ contested · — ceiling · 🔶 deferred · 💰 cost

<details><summary>Every cell that has any evidence at all</summary>

- `aws/floor` **proven** — ledger 2026-08-28, bundle `demos/proofs/aws/20260828T125612Z`
- `aws/maxconfig` **proven** — ledger 2026-08-26, bundle `demos/proofs/aws/20260826T114712Z`
- `aws/addons` **proven** — ledger 2026-08-30, bundle `demos/proofs/aws/20260830T100243Z`
- `aws/gitops` **proven** — ledger 2026-08-28, bundle `demos/proofs/aws/20260828T142417Z`
- `aws/byo-iac` **proven** — ledger 2026-08-28, bundle `demos/proofs/aws/20260828T155743Z`
- `aws/day2` **proven** — ledger 2026-08-28, bundle `demos/proofs/aws/20260828T190408Z`
- `gcp/floor` **failing** — ledger 2026-09-02 (#3855)
- `gcp/maxconfig` **proven** — ledger 2026-08-28, bundle `demos/proofs/gcp/20260828T124233Z`
- `gcp/addons` **proven** — ledger 2026-08-29, bundle `demos/proofs/gcp/20260829T093816Z` (⚠️ argocd counts unmeasured: pre-#3281 binary (A0.6's convergence loop wrote no summary); the assertion DID run and pass — run 33243600150 logs `all 20 asserted ArgoCD Applications are Healthy+Synced (1 withheld)`)
- `gcp/gitops` **proven** — ledger 2026-08-25, bundle `demos/proofs/gcp/20260825T200519Z`
- `gcp/byo-iac` **proven** — ledger 2026-08-28, bundle `demos/proofs/gcp/20260828T110456Z`
- `gcp/day2` **proven** — ledger 2026-08-26, bundle `demos/proofs/gcp/20260825T210602Z`
- `azure/floor` **proven** — ledger 2026-08-27, bundle `demos/proofs/azure/20260827T215237Z`
- `azure/maxconfig` **proven** — ledger 2026-08-27, bundle `demos/proofs/azure/20260827T211849Z`
- `azure/addons` **proven** — ledger 2026-08-30, bundle `demos/proofs/azure/20260830T005214Z`
- `azure/gitops` **proven** — ledger 2026-08-26, bundle `demos/proofs/azure/20260825T210320Z`
- `azure/byo-iac` **proven** — ledger 2026-08-27, bundle `demos/proofs/azure/20260827T204358Z`
- `azure/day2` **proven** — ledger 2026-08-26, bundle `demos/proofs/azure/20260825T235236Z`
- `hetzner/floor` **proven** — ledger 2026-08-27, bundle `demos/proofs/hetzner/20260827T192915Z`
- `hetzner/maxconfig` **proven** — ledger 2026-08-29, bundle `demos/proofs/hetzner/20260829T105705Z`
- `hetzner/addons` **proven** — ledger 2026-08-29, bundle `demos/proofs/hetzner/20260829T085104Z`
- `hetzner/gitops` **proven** — ledger 2026-08-25, bundle `demos/proofs/hetzner/2026-08-25T175213Z`
- `hetzner/byo-iac` **proven** — ledger 2026-08-27, bundle `demos/proofs/hetzner/20260827T210204Z`
- `hetzner/day2` **proven** — ledger 2026-08-25, bundle `demos/proofs/hetzner/20260825T192100Z`

</details>

### The mechanical next

**`gcp/floor`** — failing. ledger 2026-09-02

Failing cells rank above never-run ones: a red cell already has a diagnosed cause and costs nothing new to re-drive, where a never-run cell needs its gate enabled first. This RANKS; it never claims — `scripts/claim-work.sh` claims.

<details><summary>The next 10</summary>

1. `gcp/floor` — failing
1. `alibaba/floor` — never_run
1. `alibaba/maxconfig` — never_run
1. `alibaba/addons` — never_run
1. `alibaba/gitops` — never_run
1. `alibaba/byo-iac` — never_run
1. `alibaba/day2` — never_run
1. `aws/cli-demo` — never_run
1. `gcp/cli-demo` — never_run
1. `azure/cli-demo` — never_run

</details>

### Capability surface

**Proof grid (11 provisionable kinds × 5 clouds = 55 cells):** 47 carried by tofu · 7 carried in-cluster · 0 cloud ceilings · **0 deferred (our debt)** · 1 excluded by cost.

Excluded by **cost** — the cloud offers the kind and the product ships it, but provisioning it in the harness would buy something not billed by the hour. These are spend decisions, not capability limits, and the price is printed so the decision can be re-taken rather than inherited:

- `alibaba/registry` → alicloud_cr_ee_instance — 150 USD/month (Basic, eu-central-1; 1800/year, no term discount; Advanced 617; no tier below Basic), bought PER RUN because instance_name carries the environment

**Parity grid (19 canvas NodeKinds × 5 clouds):** every cloud backs every kind.

### Driven from the CLI

**23 steps CLI-driven · 0 CLI gaps (our debt) · 4 cloud ceilings · 1 console by design.**

The CLI debt is **zero** — every remaining blocker is a thing the cloud offers no API for, not a thing Alethia has not built. That distinction is the one worth carrying into a demo.

⚠️ Reachability only. The bar asserts the command surface resolves; it does **not** provision, and its real-binary half runs only when `E2E_CLI_DEMO` is set.

| step | verdict | clouds | issue |
|---|---|---|---|
| `hetzner-s3-keys` | cloud_manual | hetzner | #2332 |
| `dns-delegation` | cloud_manual | all | #1773 |
| `gcp-budget-publisher` | cloud_manual | gcp | #1871 |
| `alibaba-cr-sweep` | cloud_manual | alibaba | #2333 |

### Gate reality

Whether a dimension can run at all. A gate the workflow never mentions cannot be turned on by setting a variable.

**Which clouds can provision at all.** A leg whose gate is unwired green-skips every night.

| cloud | gate | state | evidence |
|---|---|:---:|---|
| **aws** | `E2E_AWS_ROLE_ARN` | ✅ wired | a leg reached the gate — run 33605830312 |
| **gcp** | `E2E_GCP_WIF_PROVIDER` | ✅ wired | a leg reached the gate — run 33605830312 |
| **azure** | `E2E_AZURE_CLIENT_ID` | ✅ wired | a leg reached the gate — run 33605830312 |
| **alibaba** | `E2E_ALIBABA_ROLE_ARN` | ✅ wired | a leg reached the gate — run 33605830312 |
| **hetzner** | `HCLOUD_TOKEN` | ✅ wired | a leg reached the gate — run 33605830312 |

**Which dimensions can run.** A gate the nightly never mentions has no vehicle — setting a variable would not turn it on.

| dimension | gate | state | what it proves |
|---|---|:---:|---|
| floor | `(the cloud gate alone)` | n/a | real apply → cluster_ready → ArgoCD Healthy+Synced over the derived app set |
| all kinds | `ALETHIA_E2E_MAX_CONFIG` | ✅ by dimension: `ALETHIA_E2E_MAX_CONFIG` | every kind this cloud offers lands in tofu state (or converges as its named Application) |
| 18 add-ons | `ALETHIA_E2E_ALL_ADDONS` | ✅ by dimension: `ALETHIA_E2E_ALL_ADDONS` | all 18 marketplace add-ons Healthy+Synced |
| GitOps repos | `E2E_ARGO_APPS_REPO + E2E_GIT_TOKEN` | ✅ wired: `E2E_ARGO_APPS_REPO`<br>✅ wired: `E2E_GIT_TOKEN` | a customer apps-destination repo and a BYO Helm chart converge, and each manages at least one real resource |
| BYO-IaC | `ALETHIA_E2E_BYO_IAC` | ✅ by dimension: `ALETHIA_E2E_BYO_IAC` | a customer OpenTofu root module is refused when unsafe, applied through the state proxy, drifts, heals and destroys — with state cleared |
| day-2 | `ALETHIA_E2E_SOAK (dimension) / E2E_DAY2_ACCESS` | ✅ by dimension: `ALETHIA_E2E_SOAK`<br>✅ wired: `E2E_DAY2_ACCESS` | a real access path beyond the soak — kubeconfig / ArgoCD surface |
| CLI-driven | `ALETHIA_E2E_CLI_DEMO_PROVISION` | ✅ by dimension: `ALETHIA_E2E_CLI_DEMO_PROVISION` | a floor-shaped cluster provisioned through the real `alethia` binary rather than a seeded job row — the ACTOR, not the surface area |

### Open REDs

⚠️ **This snapshot predates the truncation check**, so whether its issue list is complete is unknown — and it is not evidence that it is: the query that wrote it was capped at 500 and reported the same count whether or not it dropped the tail. The next refresh answers it.

| cell | state | issue | issue state |
|---|---|---|:---:|
| `gcp/floor` | failing | #3855 | open |


### Orphan reaper — nothing standing

**0 of 5 clouds are verified clean.** A real reclaim result stays current for 48 hours.

A run that reclaimed an orphan may still finish clean; the incident counts remain visible. Dry runs, skipped gates, failed or missing logs, unverifiable checks and unattributable resources never count as clean.

| cloud | state | durable evidence |
|---|:---:|---|
| **aws** | ? indeterminate | no durable reclaim result |
| **gcp** | ? indeterminate | no durable reclaim result |
| **azure** | ? indeterminate | no durable reclaim result |
| **alibaba** | ? indeterminate | no durable reclaim result |
| **hetzner** | ? indeterminate | no durable reclaim result |

### Blocked on a human

- #3754 — fix(authz): members stuck ungranted by the toOrgRole gap are not backfilled — and a naive backfill would restore revoked access
- #3524 — e2e(addons): remove external-dns from addOnExclusions once a paid gcp/azure addons run is green
- #3438 — release(runner): `release-runner` has never once succeeded — the ECR repo it pushes to does not exist, and nothing creates it
- #3321 — feat(fleet): Hetzner Robot pools — held against the #3268 NO-GO, with the conditions that would reopen it
- #3292 — infra: ssh_allowed_cidrs defaults to 0.0.0.0/0 on three boxes, two of which CI applies unattended
- #3291 — infra(cp-hetzner): 11 email-routing resources are gated on a default CI takes on every push to main
- #3290 — infra(azure): the state account's network default is Allow when its allowlist is empty — the unset value is the permissive one
- #3145 — cli: two projects may share a name — silent-oldest is deterministic, but is it the contract?
- #3038 — feat(e2e): the CLI demo bar proves reachability, not the demo — drive a real provision through the real binary
- #2759 — ci: workflows red on every recent run
- #2545 — e2e nightly: alibaba RED (floor)
- #2482 — release: the console never learns about a new CLI version — the notification's credentials cannot mint from a tag
- #2462 — infra(e2e): make the e2e-dev OIDC trust widening authoritative — four applies, currently hand-applied
- #2385 — feat(e2e): price the full bar on gcp/azure/alibaba/hetzner, so a schedule can be restored
- #2384 — e2e nightly: alibaba RED (full-bar)
- #2283 — probe(alibaba-cr): does an AUTO scan rule fire with no VPC endpoint? (#2265 shipped the wiring, not the proof)
- #1513 — feat(keyless): GA — default-on rollout and delete ALETHIA_KEYLESS_DB_AUTH_ENABLED
- #1450 — test(e2e): azure-mysql keyless real-apply on Azure (main-gated)
- #1268 — test(e2e): cross-account keyless cloud-SM in-cluster read — AWS/GCP/Azure/Alibaba (main-gated)
- #1065 — feat(e2e): P2-C all-19-add-ons Healthy+Synced on GCP + Azure
- #845 — test(fabric): W-h prove enterprise-demo on all 4 partner clouds (acceptance gate)

### Debt ratchets

| board | recorded debt |
|---|---|
| `infra/offer-exclusions.yaml` | exclusions: 26 · baseline: 0 · wired: 2 · carried_in_cluster: 6 |
| `infra/config-carriage-exclusions.yaml` | exclusions: 31 · baseline: 0 · wired: 2 · carried_in_cluster: 6 |
| `infra/template-parity-exclusions.yaml` | exclusions: 0 · baseline: 301 · uniform: 13 |

### Provenance

Every number above is derived from these, and from nothing else:

- `test/e2e/generated/programme.json`
- `demos/proofs/provisioning-e2e-log.md`
- `.github/workflows/e2e-nightly.yml`
- `scripts/e2e/resolve-dimension.sh`
- `apps/console/lib/cloud-providers/unsupported-kinds.ts`
- `demos/proofs/<cloud>/<stamp>/`
- `docs/testing/programme-snapshot.json`

Live board snapshot: taken **2026-09-02T11:16:57Z** — refreshed by `.github/workflows/programme.yml`, which opens a PR rather than pushing. Warns past 48h, fails past 7 days.

The timestamp is printed VERBATIM from the snapshot, never as an age. An age is computed from the current clock, so it would drift with no change to any input and make this diff-gated region stale an hour after every refresh — redding CI for everyone. The clock is only ever used to FAIL on a snapshot older than 7 days, which is a deliberate exception: a refresh that has silently stopped produces no other signal.

Gate inventory observed: **2026-08-27T19:15:55Z** — carried forward on every refresh whose token cannot list repo variables or secrets. Past 7 days behind the snapshot it stops being a measurement of today, and every declared gate degrades to `unknown`.

Ledger rows read: **62** · surviving claims: **27** (a `RETRACTED` row voids a claim rather than replacing it, so surviving < rows is expected).

_Generated by `scripts/programme-rollup.mjs`. Do not edit below the marker — run `pnpm gen:programme`._

<!-- END GENERATED: programme-rollup -->
