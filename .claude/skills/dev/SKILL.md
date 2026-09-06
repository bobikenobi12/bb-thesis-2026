---
name: dev
description: How to run the Alethia app — the console, its backends, a runner, or the E2E/browser flows. Use whenever you need a RUNNING app rather than a passing test: starting the console, reproducing a bug in the browser, checking a UI change, wiring Stripe/OAuth, or when a command like `pnpm dev:up` is blocked. The Mac is not a runtime; environments run on the sandbox box via `pnpm env:*`.
license: AGPL-3.0-only
---

# Running Alethia

**The Mac is not a runtime.** It keeps the editor, git, and the cheap checks (`tsc`,
`lint`, `vitest`). Everything that *runs the product* — the console, Postgres, OpenFGA,
object storage, runners — lives on a Hetzner sandbox box, one environment per branch,
served over HTTPS.

This is not a preference. The laptop measured 92% disk and 86% swap with `go build`
failing on ENOSPC; `pnpm dev:up`, `pnpm dev:stack` and `pnpm compose:up` are blocked by
`.claude/hooks/guard-runtime.sh`.

## The loop

```bash
pnpm env:up          # this branch gets an env: database, storage, store, URL. Idempotent.
pnpm env:push        # after editing — rsync the working tree (uncommitted work included)
pnpm env:logs        # tail the console  ← SIGN-IN CODES ARE PRINTED HERE
pnpm env:open        # open it in a browser
pnpm env:down        # give the slot back when you're done with the branch
```

`env:up` prints the URL. Branch envs get a **slot** hostname —
`https://env1-dev.alethialabs.io`, `env2-dev…` — not a branch-named one, and
`pnpm env:status` shows which slot your branch holds.

That is not cosmetic. Cloudflare's Universal SSL covers the apex and **one** level of
subdomain, so `<slug>.dev.alethialabs.io` is outside the certificate and every request
fails the TLS handshake before it is sent. Only the integration env at
`dev.alethialabs.io` worked. One label deep, per slot, costs nothing and always resolves.

**There is no hot reload.** The sync is on command, so an edit on your Mac is invisible
to the box until `pnpm env:push`. If you are iterating tightly, run `pnpm env:push
--watch` in a second console (needs `brew install fswatch`).

## Signing in

No credential is copied to the box — every secret is minted there. That includes *not*
setting `ALETHIA_SES_REGION`, which makes `getEmailConfig()` return `ses: null` and
`sendEmail` **log** the message instead of sending it
(`packages/email/src/{config,send}.ts`).

So: request an email OTP, then read the six-digit code out of `pnpm env:logs`. This is
**verified working** on the live box, not a design intention.

**Social sign-in and Stripe webhooks only work on `dev.alethialabs.io`**, the primary
env. OAuth redirect URIs cannot contain wildcards, so they are registered against that
one hostname. Branch envs are email-OTP only. Don't debug "broken Google sign-in" on a
branch env — it was never wired.

## Browser tests

`pnpm env:test` runs Playwright **on the box** and rsyncs `playwright-report/` and
`test-results/` back into your worktree. It defaults to `--project=hero`, the project CI
gates on; pass another, e.g. `pnpm env:test --project=canvas`.

**They cannot run from your Mac against the public URL.** Sign-in scrapes the one-time code
out of the console's stdout, and that log exists only on the box
(`/var/log/alethia-<slug>.log`). The Playwright process has to read that file, so it has to
be the same machine. Browsers and their OS libraries install on first run, then cache.

`elench-live` and `elench-ai` **self-skip** on a branch env — the minted `.env` carries no
`ANTHROPIC_API_KEY` and no `ALETHIA_AI_MOCK`, deliberately. A skip is not a pass.

## Other things you may want

| Need | Command |
|---|---|
| `tsc` / `lint` / `vitest` for a worktree | `pnpm env:check` — worktrees are de-hydrated (no local `node_modules`) |
| **Browser tests** | `pnpm env:test` — Playwright on the box; report and traces come back to your worktree |
| A provisioning runner against your env | `pnpm env:runner` |
| A shell on the box | `pnpm env:ssh`, then `tmux attach -t alethia-<slug>` |
| Everything running, capacity, who holds what | `pnpm env:status` |
| A clean database | `pnpm env:up --fresh` — drops and recreates **only your** env's database |
| Local disk / Docker / worktree health | `pnpm dev:doctor` |

## Rules that will bite you

- **The box is SHARED — one box, one Postgres, one OpenFGA, for every instance and the
  maintainer.** It caps at **2** environments. That is a hard memory budget, not a
  policy: an env floors at **5.2 GB** and reaches **~7 GB** after a browser run (measured
  on the box; the earlier "~2–3 GB" was a guess, and wrong by 3x), against 15.6 GB of
  RAM. A third env OOMs the box. **`dev` permanently holds one** as the integration env
  at `dev.alethialabs.io`, so there is **one branch slot** for everyone else. The next
  one is refused with a list of who holds it — nothing is ever evicted automatically,
  because a silent swap kills someone else's run.
- **Take a slot only when you need a RUNNING app** — reproducing a bug, checking UI,
  testing auth. Building, type-checking, linting and unit tests do not need one. With
  one shared branch slot this is now a courtesy to whoever is waiting, not just tidiness.
- **`pnpm env:down` before you finish with a branch.** Nothing reclaims it for you.
- **The box costs money by the hour it EXISTS, running or idle.** Deleting it is the only
  thing that stops the meter — €69.49/mo left up 24/7 against **€0.72/mo reaped**. So
  `pnpm env:reap --now` when you finish for the day, and if the box is up and idle it is
  costing money right now. `pnpm env:timer` installs a launchd job that reaps it after
  90 idle minutes; the session banner warns once the box has been up 12h.
- **REAPING DELETES THE BOX FOR EVERYONE — check `pnpm env:status` first.** Every
  environment on it goes: the slot, the database, the OpenFGA store, the tunnel. `env:box`
  restores the *box*, not the envs. `env:reap` prints what it is about to destroy, and
  then refuses in two cases:
  - **someone else's env was touched in the last 60 minutes** — refused, and `--now` is
    not a way around it. Ask them to `pnpm env:down`, or wait for it to go idle.
  - **your own env is still live** — also refused, because it dies too. Release it with
    `pnpm env:down` and reap, or say you meant both: `pnpm env:reap --now --include-mine`.

  `pnpm env:reap --dry-run` decides and prints without touching anything, and works from a
  worktree. Until 2026-09-02 that first refusal could not fire between two instances on one
  Mac: ownership was recorded as `user@host`, which every agent, worktree and shell here
  shares. It is now the same instance identity `pnpm wt:who` uses, so `env:status` marks
  which env is **← you**, and an environment written before the fix carries a bare
  `user@host` owner that is deliberately counted as **someone else's** — `pnpm env:up`
  rewrites it, `pnpm env:down` releases it (#3841).
- **Never `docker compose down -v` or `pnpm db:reset`.** `docker-compose.yml` pins
  `name: alethia`, so those delete the volumes *every* window is using. Blocked.
- **Never run `docker compose` from an env's tree on the box.** Each env is a different
  checkout; a branch that touched the compose file would re-converge the shared
  containers under every other env. `scripts/box/env-shared.sh` owns the shared tier.
- **Never build fleet runner images on the box.** `pnpm env:runner` uses `MODE=native`
  deliberately — an image built for the wrong architecture is what churned ~100 fleet
  VMs in 8 hours.
- **The box is billed BY THE HOUR, and only while it exists.** A stopped Hetzner server
  bills in full — *"you pay for a server for as long as it exists, regardless of whether
  it is turned on or not"* — so removing it is the only thing that stops the meter. On
  cpx42 that is **69.49 EUR/mo left up 24/7 against 0.72 reaped**, and it is not
  hypothetical: the box ran continuously for its first day because nothing stopped it.
- **Reaping is automatic if someone installed the timer — check, do not assume.**
  `pnpm env:timer status` says whether it is loaded; `pnpm env:timer` installs it (launchd,
  every 30 min, reaps after 90 idle minutes). It is a per-machine opt-in, so on a fresh
  machine there is nothing scheduled. Either way run `pnpm env:reap --now` when you finish
  for the day — the timer is a backstop for forgetting, not a substitute for finishing.
  While the box is down the hostnames return a Cloudflare origin error, and the only things
  still billing are the Primary IP (0.50 EUR/mo) and the snapshots (~0.22).
- **The address is stable across the cycle.** A Primary IP is held separately from the
  server, so a restored box comes back on the same address — no DNS change, no
  `known_hosts` surprise. That 0.50 EUR is what makes routine teardown safe.
- **If the box is down, an agent cannot fix it — ask the maintainer.** `pnpm env:box`
  runs `tofu apply`, which is a human action here; both `.claude/hooks/guard-iac.sh` and
  `scripts/env.sh` itself refuse it for agents. Do not look for a way around that: from a
  worktree it would apply against empty state and build a **second** box, breaking
  `dev.alethialabs.io`.
- **"box: down" from a worktree used to be a lie.** State is gitignored and lives only in
  the main checkout; `env.sh` now resolves it there. If you ever see a state-read error,
  that is a bug in the script, not something to work around.

## What still runs locally

Building, type-checking, linting, unit tests, git, and every read-only Docker command.
`pnpm db:up` (Postgres only, ~30 MB) is still allowed for local integration tests.

If you genuinely need a local runtime, `export ALETHIA_LOCAL_DEV=1` **before launching
`claude`** — an inline `VAR=1 pnpm dev:up` prefix cannot work, because the guard is a
PreToolUse hook spawned before the command runs.

## Reference

- `infra/sandbox/README.md` — the box, sizing, cost, and why it is x86 rather than ARM
- `scripts/env.sh` — the entry point; `scripts/box/*` runs on the box
- `CLAUDE.md` → *Running the app*
