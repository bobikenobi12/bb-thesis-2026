// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

// Unmount + reset the DOM between tests (Vitest globals are off, so RTL's automatic
// afterEach cleanup isn't registered for us).
afterEach(() => cleanup());

// Better Auth (lib/config/auth.ts) and the DB client (lib/config/database.ts)
// validate env at import. Provide test-safe values; no real connection is made
// (postgres-js connects lazily).
const TEST_ENV: Record<string, string> = {
  BETTER_AUTH_SECRET: "test-secret-not-used",
  NEXT_PUBLIC_APP_URL: "http://localhost:3000",
  ALETHIA_DATABASE_URL: "postgres://test:test@localhost:5432/test",
};
Object.assign(process.env, TEST_ENV);

// ── Better Auth 1.7's MCP plugin talks to the database while `auth` is being BUILT ──
//
// The note above ("no real connection is made — postgres-js connects lazily") stopped being true
// in 1.7. `mcp({ resource })` upserts that resource into `oauth_resource`, so simply importing
// `@/lib/auth` now issues a SELECT. In a unit test there is no database behind
// ALETHIA_DATABASE_URL, and the query is a floating promise inside the plugin — so it surfaces as
// an UNHANDLED REJECTION (`connect ECONNREFUSED ... :5432`) that fails the whole run, in tests
// that never meant to touch auth at all and cannot catch it.
//
// Stub the plugin for unit tests. This is the right layer: the DB is already absent by design
// here, and the alternative — teaching production code to behave differently under NODE_ENV —
// would be worse. A test that wants to assert on the real plugin config declares its own
// `vi.mock("@better-auth/mcp", ...)`, which takes precedence over this one (see
// tests/lib/auth/index.test.ts). Integration tests, which DO have a database, use a separate
// config and never load this file.
// The third parameter — `{ resource }`, the audience the route verifies tokens against — is
// DISCARDED here, and that is load-bearing to notice: with only this stub in place, deleting the
// argument in app/api/mcp/route.ts left the whole suite green while remote MCP auth was dead
// (#3511). tests/app/api/mcp-route-audience.test.ts declares its own mock, captures all three
// arguments, and is the only thing standing between that argument and a future refactor.
vi.mock("@better-auth/mcp", () => ({
  mcp: () => ({ id: "mcp" }),
  requireMcpAuth: (_auth: unknown, handler: unknown, _opts?: unknown) => handler,
}));
vi.mock("@better-auth/cimd", () => ({ cimd: () => ({ id: "cimd" }) }));
vi.mock("@better-auth/cimd/node", () => ({ fetchClientMetadataResource: () => undefined }));

// next-runtime-env's env() throws for non-public vars in a browser (jsdom) runtime;
// resolve straight from process.env in tests so server-only config (auth/db) loads.
vi.mock("next-runtime-env", () => ({
  env: (key: string) => process.env[key],
}));

// jsdom lacks a few DOM APIs that Radix UI / cmdk touch on mount (ResizeObserver, layout
// measurement, pointer capture). Stub them so dialog/command/select-based components render in
// component tests. Purely additive — only fills gaps jsdom doesn't provide.
if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
// Element only exists in the jsdom project; node-environment tests skip these DOM stubs.
if (typeof Element !== "undefined") {
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = () => {};
  }
  // jsdom doesn't implement the Web Animations `Element.getAnimations()`. base-ui's ScrollArea
  // (via @repo/ui/scroll-area, and any component that renders it — agent chat panels, dialogs,
  // data-table, widget grid, …) schedules a post-mount `useTimeout(0)` whose callback calls
  // `viewport.getAnimations({ subtree: true })` to recompute the scrollbar thumb once popup
  // animations settle (ScrollAreaViewport.js:259). When that macrotask fires — which happens
  // whenever a test yields to the event loop (`await` / `waitFor` / `userEvent`) while a
  // ScrollArea is mounted — the missing method throws INSIDE the timer, before base-ui's
  // `.catch()`, surfacing as an "Unhandled Error" that flips `pnpm -C apps/console run test` to exit 1
  // even though every test passes (intermittent, because it races the test's unmount/cleanup).
  // Returning [] makes the callback a harmless `Promise.all([]).then(...)`, killing the flake at
  // the root for every ScrollArea-rendering test — no per-test workaround, no error swallowing.
  if (!Element.prototype.getAnimations) {
    Element.prototype.getAnimations = () => [];
  }
  if (!Element.prototype.setPointerCapture) {
    Element.prototype.setPointerCapture = () => {};
  }
}

// jsdom doesn't implement `PointerEvent`. base-ui's overlays (Menu/Popover/Select/Tooltip/…) open on
// pointer interactions (their Floating-UI `useClick`/`useHover` listen for `pointerdown`), so without
// a `PointerEvent` constructor a `userEvent.click`/`fireEvent` never drives them open — the trigger
// stays `aria-expanded="false"` and the popup never mounts, failing any interaction test. Polyfill a
// minimal `PointerEvent` (extends `MouseEvent`) so those gestures reach base-ui. Keyboard already works.
if (
  typeof globalThis !== "undefined" &&
  typeof (globalThis as { PointerEvent?: unknown }).PointerEvent ===
    "undefined" &&
  typeof MouseEvent !== "undefined"
) {
  class PointerEventPolyfill extends MouseEvent {
    public pointerId: number;
    public pointerType: string;
    public width: number;
    public height: number;
    public isPrimary: boolean;
    constructor(type: string, params: PointerEventInit = {}) {
      super(type, params);
      this.pointerId = params.pointerId ?? 1;
      this.pointerType = params.pointerType ?? "mouse";
      this.width = params.width ?? 1;
      this.height = params.height ?? 1;
      this.isPrimary = params.isPrimary ?? true;
    }
  }
  (globalThis as { PointerEvent: unknown }).PointerEvent = PointerEventPolyfill;
}
