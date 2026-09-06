<!-- SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io> -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# The CLI-only demo bar

Living status for one question: **can the whole product be driven from the terminal?**

Every other board here tracks whether the *platform* works. This one tracks whether the *product is
reachable* — whether a prospect gets from an empty account to a running, verified, torn-down cluster
using `alethia` alone. Until `test/e2e/t2_cli_demo.go` existed, nothing asserted it, and the
console-only gaps were discoverable only by trying them one at a time in front of an audience.

The bar has **two tiers**, and they answer different questions. Keeping them apart is the point:
one is free and runs on every leg, the other buys a cluster.

| tier | question | harness | gate | cost |
|---|---|---|---|---|
| **reachability** | does the command surface resolve? | `t2_cli_demo.go` (the table) · `t2_cli_demo_pure_test.go` (shape, every PR) · `t2_cli_demo_run_test.go` (`e2e_t2`, real binary) | `E2E_CLI_DEMO` repo variable, `E2E_CLI_BIN` naming the binary | seconds, no cloud |
| **provisioning** | has the product ever been provisioned THROUGH the binary? | `t2_cli_demo_provision.go` (the beats) · `t2_cli_demo_drive.go` (the driver) · `t2_cli_demo_provision_pure_test.go` (the cross-check) | the `cli-demo` **dimension**, which exports `ALETHIA_E2E_CLI_DEMO_PROVISION` | a floor-shaped cluster + a console build, dispatch-only |

The second is a dimension rather than a variable deliberately: it boots a console, seeds a service
token and provisions, so it must not ride along on a leg that did not ask for it.

## The bar

A cloud clears the bar when **every applicable step is CLI-driven**. Two verdicts fail it and one
does not:

| Verdict | Meaning | Scores |
|---|---|---|
| `CLIDriven` | completes through `alethia`, no console | ✅ |
| `CLIGap` | the product does it; the CLI cannot reach it — **our debt** | ❌ FAIL |
| `CloudManual` | no API exists cloud-side; a human must open a console | ❌ FAIL |
| `ConsoleOnly` | deliberately human-in-the-loop; must name why | — set aside |

`CLIGap` and `CloudManual` both fail **by maintainer ruling**: a prospect cannot tell whose fault the
click is, and neither can their procurement team. They are recorded apart because the remedies
differ — the same reason `MaxConfigStateProof` keeps `.Excluded` and `.Deferred` in separate lists.

## A ceiling is two claims, not one

A `CloudManual` step used to record one fact — *no cloud API can reach this* — and fail the bar on
it forever. That is only half of what a reader needs. The other half changes: **has the human
actually done it?**

The cost of collapsing the two was measured. On 2026-08-26 the bar was FAILing on every cloud, on
every run, with **zero** CLI gaps. The entire failure was two ceilings, and both had already been
met: `e2e.alethialabs.io` was delegated and ACM had issued against it ([#1773] closed), and the
Hetzner Object Storage keys had been minted and stored ([#2332] closed). Nothing the bar could
observe had changed, so nothing it reported could change either.

Every ceiling now carries a `SatisfiedBy` probe, and the probe reads something **outside** the
table that would be false if the work had not been done:

| Probe | Reads | Why it cannot be faked |
|---|---|---|
| `zone_delegated` | an `NS` lookup on the public internet | a hosted zone you created answers with an **empty** name-server set; only a parent delegation answers with one |
| `env_truthy` | a presence boolean rendered from a repo secret | the workflow passes `secrets.X != ''`, never the secret; and the probe demands **truthy**, because `"false"` is exactly what a *missing* secret renders |

A satisfied ceiling **passes** the bar and is **still printed** — a prospect deserves to know the
manual step exists before they hit it. An outstanding one fails and prints both what the probe read
and what would satisfy it, so the proof bundle carries a remedy rather than only a complaint.

Every direction fails closed: unset, empty, whitespace, `"false"`, an empty answer, a resolver error
and a timeout all read as **unsatisfied**. `ScoreCLIDemo` stays pure and never runs a probe, so a
caller that forgets to evaluate gets the strict answer, never a laxer one.

## Status

> **Status is not here.** It rots, and this table proved it: it printed a verdict per cloud dated
> 2026-08-26, counted "19 of 20" steps where `programme.json` carries 28, and cited #1871 and
> #2333 as open when both are closed.
>
> The proof grid, the per-cell evidence and the open blockers are derived in **`PROGRAMME.md`**,
> below its generated marker. Read it there. What stays below is the reasoning the ledger cannot
> hold — decisions, post-mortems and measurements.

### The CLI gap that closed — [#2331]

**`alethia verify receipt` shipped.** It pulls a job's signed evidence receipt, checks its ed25519
signature, and exits non-zero when it cannot — so a customer can gate their own pipeline on it.
`alethia verify show` prints the per-control report behind the verdict, `not_evaluable` controls and
any `RecordedException` included.

The signature is checked against a key the control plane **vouches for** — the organization's own
recorded signing key, or the platform key — and not merely against the public key the receipt
carries about itself. That distinction is the entire value of the command: a receipt always
verifies under its own embedded key, whoever made it, so self-verification would have proved only
that the document was not altered in transit. `GET /api/cli/signing-keys` serves the trusted set,
and `--key` / `--key-file` pin a key supplied out of band for an auditor who trusts nothing the
control plane says about itself.

Proof is a headline differentiator (#845 asks the demo to *surface the verify receipt*), and
`docs/compliance/soc2-e2e-matrix.md` is explicit that the receipt ledger — not the test suite — is
the operating-effectiveness record an auditor samples. The answer to "let me verify one" is now a
command, not "open the console".

### The cloud ceilings

| Ceiling | Clouds | Issue |
|---|---|---|
| Public DNS zone delegation — a registrar action, outside every cloud's API. The full bar proves the `dns` kind but **not** the cert path, on any cloud | all | [#1773] |
| Hetzner Object Storage keys — Hetzner ships no API that mints them | hetzner | [#2332] |
| GCP billing-budgets publisher binding — an out-of-band Cloud Console grant | gcp | [#1871] |
| Alibaba prepaid CR EE release — `payment_type = "Subscription"`, not released by `tofu destroy`, and teardown reports clean anyway | alibaba | [#2333] |

**All four of those trackers are CLOSED, and that is correct.** The maintainer's ruling on #3591 is
that the `Issue` field means two different things depending on the verdict:

| Verdict | Contract | Why |
|---|---|---|
| `CLIGap` | the tracker must still be **OPEN** | it is *our* debt, and debt must be able to close. A tracker that closes while the gap still stands is how debt becomes permanent by being forgotten — the same failure the must-be-OPEN rule on `test/e2e/addon_exclusions.go` exists to prevent |
| `CloudManual` | the tracker need only be **FILED** | it is a fact about a cloud. Hetzner still ships no key-minting API and a prepaid CR EE instance is still released by hand; the ceiling does not lift because somebody closed the issue, and reopening one to satisfy a guard would be the guard editing reality to match itself |

`scripts/check-exclusion-issues.mjs` enforces exactly that split — it is the only guard in the tree
with three modes, and the third is this one. The state question cannot live in
`t2_cli_demo_pure_test.go` because it needs the network and that file runs credential-free on every
PR; the pure test checks the *shape*, the script checks the *state*.

The table has **zero `CLIGap` rows** today (#2331 cleared the CLI debt), so the enforced arm covers
nothing on a live run. It says so in those words rather than printing a tick, and its power to
discriminate is proven by `node scripts/check-exclusion-issues.mjs --self-test`, which flips a real
`CloudManual` row in the shipped source to `CLIGap` and asserts the arm reds.

### The one deliberate console step

**Promotion approval.** `alethia promotion` is list/get only, and the approve verb is deliberately
absent: a gate whose whole value is that a named human saw and accepted a change must not be
scriptable, or it stops being a control. `alethia ops approve` exists for break-glass and is audited
as such.

This is the only verdict in the table that is a design decision rather than a gap. It is also the
verdict an author would reach for to turn a red table green, so it carries the burden of proof — if
it ever stops being true it becomes a `CLIGap`, not a quietly-edited `Why`.

## What each tier does NOT claim

- **The reachability tier does not provision.** Its question is whether a human at a terminal can
  REACH each step, and that is answered by the command surface. Re-driving the apply on every leg
  would double the bill to re-prove what the base T2 spine already proves.
- **The provisioning tier does not prove the surface AREA.** It drives a FLOOR-shaped cluster, on
  purpose: what is under test is the ACTOR, not the eleven kinds or the eighteen add-ons, which
  `maxconfig` and `addons` prove at their own price. A green `cli-demo` cell says "the CLI was the
  actor", and nothing more.
- **Neither tier performs `login`.** The device flow needs a human at a browser by design, and
  `ALETHIA_TOKEN` is the documented non-interactive substitute. The provisioning tier records that
  in `cliDemoNotDriven` rather than counting it — a bar that quietly counted `login` as performed
  would be claiming the one thing it cannot do.
- **MCP is not a demo driver.** `apps/console/app/api/mcp/route.ts` exposes only read/both tools —
  HITL proposals, canvas tools and job-queuing writes are excluded by construction. MCP is a
  **read/verify** surface. Any claim that the product is "drivable from MCP" must say that.

## What stops the provisioning tier from proving nothing

Two guards, because a bar that provisions is worth exactly as much as its accounting.

**Every `CLIDriven` step is accounted for in exactly one of a beat or a written reason.** Never
both, never neither — `ValidateCLIDemoBeats` fails on a step with two answers ("one of the two is a
lie") and on a step with none. The reasons are sentences a reader can disagree with; "n/a" is
indistinguishable from an oversight.

**The dimension cannot go green without a driver.** `cli_demo_wiring_pure_test.go` holds exactly one
of {the beats are driven, `t2_provision_test.go` REFUSES the dimension} — and it asserts the refusal
as a SHAPE (an `if` on the gate whose body terminates the test), because turning a `t.Fatalf` into a
`t.Logf` would otherwise restore a vacuous run in one edit. Before a driver existed, a `cli-demo`
dispatch would have provisioned a floor, asserted the floor, and been recorded as a CLI-driven
proof: an assertion that is TRUE and about the wrong thing.

## One hazard worth knowing before you drive the CLI from any test

`types.ResolveWebOrigin()` is env > persisted config > **the hosted default,
`https://alethialabs.io`**, and `api.NewClient` appends `/api`. So a harness that exports the wrong
variable name — or none — does **not** fail. Every command authenticates against PRODUCTION with
whatever token it was given, and the run reports the CLI as broken while pointing at a console
nobody meant to touch. Nothing downstream can catch it; from the CLI's side it is an ordinary
request.

`ResolveCLIDemoRun` therefore REFUSES a production origin outright. The hazard is not specific to
this bar, so the refusal lives on the resolution path any CLI-driving test would use.

## The ratchet

The run half asserts every verdict in both directions. A `CLIDriven` step must resolve
(`alethia <cmd> --help` exits 0), and a `CLIGap` step must NOT — so a gap cannot be quietly left in
the report after somebody closes it, and a claim cannot be quietly left in after somebody renames
the command. #2331 is the ratchet working as designed: shipping `alethia verify receipt` turned
`TestT2CLIDemoReachability` red on purpose, and going green again required editing this table.

`TestCLIDemoBarFailsOnlyOnCloudCeilings` pins the same thing from the other side, and its two
assertions are deliberately opposed:

- **zero `CLIGap`s** — the CLI debt is cleared, so a new gap must be a deliberate, visible edit
  with an issue and a row here, never a silent regression;
- **still not `Passed()`** — nobody declares the bar met while a ceiling forces a human into a
  cloud console mid-demo.

Deleting it is how somebody states, on the record, that the bar is met.

[#1773]: https://github.com/alethialabs-io/alethialabs/issues/1773
[#1871]: https://github.com/alethialabs-io/alethialabs/issues/1871
[#2331]: https://github.com/alethialabs-io/alethialabs/issues/2331
[#2332]: https://github.com/alethialabs-io/alethialabs/issues/2332
[#2333]: https://github.com/alethialabs-io/alethialabs/issues/2333
