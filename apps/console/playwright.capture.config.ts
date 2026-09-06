// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Isolated Playwright config for MARKETING CAPTURE — crisp, high-DPI, dark-theme
// stills of the REAL console driven against the seeded demo org (see
// `pnpm -C apps/console run seed:demo`). Kept separate from `playwright.config.ts` so it
// never touches the CI-gating projects. Run:
//   pnpm -F console exec playwright test --config playwright.capture.config.ts
// Requires a console running on :3000 with the demo org seeded and SES
// unconfigured (so the sign-in OTP is logged) — i.e. `pnpm dev:up`.

import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:3000";
export const CAPTURE_STATE = path.join(__dirname, "e2e", ".auth", "capture.json");

export default defineConfig({
	testDir: "./e2e/capture",
	fullyParallel: false,
	workers: 1,
	retries: 0,
	reporter: [["list"]],
	timeout: 120_000,
	use: {
		baseURL,
		channel: "chrome", // use system Google Chrome — no bundled-browser download needed
		viewport: { width: 1920, height: 1080 },
		deviceScaleFactor: 2, // 3840×2160 stills → sharp under ffmpeg Ken Burns zoom
		colorScheme: "dark",
		navigationTimeout: 60_000,
	},
	projects: [
		{ name: "capture-setup", testMatch: /capture\.setup\.ts/ },
		{
			name: "capture-shots",
			testMatch: /shots\.capture\.ts/,
			dependencies: ["capture-setup"],
			use: { ...devices["Desktop Chrome"], storageState: CAPTURE_STATE },
		},
	],
	// Reuse the already-running `pnpm dev:up` console on :3000.
});
