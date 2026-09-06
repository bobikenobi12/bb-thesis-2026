// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import fs from "node:fs/promises";
import path from "node:path";
import { withPostHogConfig } from "@posthog/nextjs-config";
import type { NextConfig } from "next";

// Cross-origin dev/proxy origins to allow (the public tunnel — Cloudflare quick tunnel /
// ngrok — that `dev:stack`, or the sandbox box's tunnel, front the app with). Without this, Next blocks
// cross-origin requests from the tunnel host (server actions, /_next/*, HMR) and the
// browser reports "Load failed". The exact host comes from the env dev-stack injects; the
// wildcards cover a new random quick-tunnel URL without re-editing.
const PUBLIC_DEV_ORIGINS = (() => {
	const out = new Set<string>([
		"*.trycloudflare.com",
		"*.ngrok-free.app",
		"*.ngrok.app",
	]);
	const raw =
		process.env.ALETHIA_PUBLIC_URL ||
		process.env.NEXT_PUBLIC_APP_URL ||
		process.env.BETTER_AUTH_URL;
	if (raw) {
		try {
			out.add(new URL(raw).host);
		} catch {
			// Ignore an unparseable URL — the wildcards still cover the tunnel.
		}
	}
	return [...out];
})();

const nextConfig: NextConfig = {
	output: "standalone",
	// `next build` type-checks against tsconfig.build.json — tsconfig.json minus every file the
	// image does not ship (tests, e2e + its helpers, scripts, tooling configs). The production
	// image installs a PRUNED closure, so a non-shipped file can resolve in CI's full install and
	// fail in the image; #2521 fixed the instance, this narrows the class. `check-types` still
	// covers all of it. ⚠️ `extends` in that file silently disables Next's own tsconfig
	// verification — see the note there before editing either.
	typescript: { tsconfigPath: "tsconfig.build.json" },
	// The dev indicator defaults to bottom-left, where it lands on the sidebar
	// profile (avatar + name). Same reason ReactQueryDevtools moved — see providers.tsx.
	devIndicators: { position: "bottom-right" },
	// Don't 308-redirect a trailing slash. Without this, the PostHog reverse-proxy paths
	// (`/ingest/e/`, `/ingest/flags/` — posthog-js sends them WITH a trailing slash) get a
	// Next trailing-slash redirect before the rewrite runs, adding a hop to every captured
	// event. Recommended by PostHog's Next.js reverse-proxy guide.
	skipTrailingSlashRedirect: true,
	// Allow the tunnel host to make cross-origin dev requests (server actions, /_next/*).
	allowedDevOrigins: PUBLIC_DEV_ORIGINS,
	// Also allow the Server Action Origin check behind the proxy (production-mode renders).
	//
	// ⚠️ Do NOT add `staleTimes` here without reading `resolveOrgScope` first (#4089).
	// `app/(private)/[org]/layout.tsx` resolves the URL's org segment and WRITES the
	// session's active organization; the rest of the request, and the next write the
	// user makes, are scoped by that. It only happens because Next 16's default
	// `staleTimes.dynamic = 0` re-runs the dynamic segment on every navigation.
	// Setting `staleTimes.dynamic > 0` serves `/{org}/…` from the client Router Cache
	// instead, so the layout does not re-run — and the session is then NEVER re-scoped
	// on a soft navigation between two orgs. Nothing errors, no check goes red: the
	// user simply keeps writing into whichever org they were last hard-loaded under.
	// `tests/hooks/use-active-org-slug.test.tsx` asserts this key stays absent.
	experimental: { serverActions: { allowedOrigins: PUBLIC_DEV_ORIGINS } },
	// Monorepo: trace workspace files from the repo root so the standalone
	// bundle is self-contained inside Docker.
	outputFileTracingRoot: path.join(__dirname, "../../"),
	// next@16.3.1's output-file-tracing copies the CJS half of a dual-package export and misses the
	// ESM half. `@swc/helpers` declares
	//     "./_/_interop_require_default": { import: "./esm/…js", default: "./cjs/….cjs" }
	// so the tracer followed `default` (cjs) while the runtime resolved `import` (esm) — the
	// standalone bundle shipped `cjs/` + package.json and nothing else, 3 files out of 438.
	//
	// Every Next app in this repo then crash-looped at boot with
	//     Cannot find module '…/@swc/helpers/esm/_interop_require_default.js'
	// and prod served 502 behind a healthy caddy for ~45 minutes on 2026-08-26. The deploy reported
	// SUCCESS throughout, because nothing between `next build` and Cloudflare ever asked whether the
	// image could start.
	//
	// It broke on the @swc/helpers 0.5.15 -> 0.5.23 bump in #2405 (a 38-package batch), not on a
	// Next upgrade — so pinning Next would not have prevented it and will not prevent the next one.
	//
	// The whole package is included rather than just `esm/**`: it is ~438 small files, and naming
	// one subdirectory would re-create the same guess the tracer already got wrong. The version is
	// globbed so a future bump does not silently reintroduce this.
	outputFileTracingIncludes: {
		"/**/*": ["../../node_modules/.pnpm/@swc+helpers@*/node_modules/@swc/helpers/**"],
	},
	// Shared workspace packages ship raw TS/TSX — Next must transpile them.
	// Every @repo/* here ships raw TypeScript from `src/`, so it is compiled by the app, not
	// pre-built. A package added to package.json but forgotten HERE resolves in tests and dies
	// in `next build` — which is why the list is worth reading before adding a dependency.
	//
	// The list is not self-explanatory: @repo/privacy and @repo/platform also ship raw TS, are
	// NOT listed, and build fine. The asymmetric cost is what decides it — listing a package
	// that does not need an entry costs nothing, omitting one that does breaks the build.
	transpilePackages: [
		"@repo/ui",
		"@repo/brand",
		"@repo/format",
		"@repo/legal",
		"@repo/plan-catalog",
		"@repo/email",
		"@repo/support",
	],
	// The enterprise package is loaded at runtime via createRequire (lib/enterprise.ts),
	// never statically bundled — keep it external so a community build (where the
	// package is absent) doesn't try to resolve it.
	// pino resolves its transport/worker files at runtime — keep it external so the
	// bundler doesn't try to statically trace those dynamic requires.
	// The OpenTelemetry SDK (traces + metrics, wired in instrumentation.ts) similarly
	// resolves exporters/context managers at runtime and is node-only — keep it external
	// so the server bundle doesn't statically trace it (and so an OTLP-less build carries
	// no telemetry weight in the client/edge graphs).
	serverExternalPackages: [
		"@alethia/ee",
		"pino",
		// Sentry error tracking is server-only (booted in instrumentation.ts, DSN-gated). Keep it
		// external — like the OTel packages below — so it is not statically bundled into the
		// client/edge graphs and a DSN-less build carries no error-tracking weight there.
		"@sentry/nextjs",
		"@opentelemetry/api",
		"@opentelemetry/resources",
		"@opentelemetry/sdk-trace-node",
		"@opentelemetry/sdk-metrics",
		"@opentelemetry/exporter-trace-otlp-http",
		"@opentelemetry/exporter-metrics-otlp-http",
		"@opentelemetry/api-logs",
		"@opentelemetry/sdk-logs",
		"@opentelemetry/exporter-logs-otlp-http",
	],
	async rewrites() {
		// Serve the CLI install script at the root of get.alethialabs.io
		// (`curl -fsSL https://get.alethialabs.io | sh`). install.ps1 is reached
		// directly at /install.ps1. Both files live in public/.
		const getHost = [
			{
				source: "/",
				has: [{ type: "host" as const, value: "get.alethialabs.io" }],
				destination: "/install.sh",
			},
		];
		const docsUrl = process.env.DOCS_URL;
		const docs = docsUrl
			? [
					{ source: "/docs", destination: `${docsUrl}/docs` },
					{ source: "/docs/:path*", destination: `${docsUrl}/docs/:path*` },
				]
			: [];
		// PostHog reverse-proxy: serve analytics ingestion from our own origin so ad-blockers
		// (which block eu.i.posthog.com) stop dropping events. The browser SDK points at
		// `/ingest` (NEXT_PUBLIC_POSTHOG_HOST). PostHog's EU assets live on a separate host from
		// ingest, so the /static/* rule must target eu-assets.
		const posthog = [
			{
				source: "/ingest/static/:path*",
				destination: "https://eu-assets.i.posthog.com/static/:path*",
			},
			{ source: "/ingest/:path*", destination: "https://eu.i.posthog.com/:path*" },
		];
		// The root `.well-known` OAuth discovery documents (#3318, #3511). Better Auth serves both
		// from plugin onRequest hooks that match the ABSOLUTE pathname, but it is mounted at
		// /api/auth, so Next never routed those requests to it: they fell through to the catch-all
		// page render and answered 200 text/html to a discovery request.
		//
		// BOTH prefixes, because discovery is a chain — the 401 points at the protected-resource
		// document, whose `authorization_servers` sends the client to the RFC 8414 §3
		// authorization-server document, which is a root path too. Rewriting only the first left a
		// client failing one hop later, at the same HTML shell.
		//
		// `beforeFiles`, not `afterFiles`: the console owns the `/{org}` wildcard, so a page route
		// otherwise claims these paths — which is exactly how the shell came to answer them. The
		// `:path*` rules are deliberately broad so a request naming some OTHER resource or issuer
		// gets the handler's JSON 404 instead of the same HTML.
		const oauthMetadata = ["oauth-protected-resource", "oauth-authorization-server"].flatMap(
			(document) => [
				{
					source: `/.well-known/${document}`,
					destination: `/api/oauth-metadata/${document}`,
				},
				{
					source: `/.well-known/${document}/:path*`,
					destination: `/api/oauth-metadata/${document}/:path*`,
				},
			],
		);
		return {
			beforeFiles: [...getHost, ...oauthMetadata],
			afterFiles: [...docs, ...posthog],
		};
	},
};

// Console is the default zone: it owns the residual (incl. the `/{org}` wildcard). The
// marketing-owned root paths are stitched to the marketing app by Caddy at the edge
// (deploy/prod/Caddyfile.tunnel + deploy/caddy/marketing.caddy), NOT by Next — the path
// map still lives in microfrontends.json (source for RESERVED_SLUGS + the Caddy mirror).
// PostHog source-map upload for Error tracking: when a build-time personal API key is present (CI, via
// a BuildKit secret), withPostHogConfig injects chunk ids + uploads source maps during `next build` so
// prod stack traces symbolicate. Gated on the key so OSS/local builds are a plain no-op (never fail).
// deleteAfterUpload keeps the .map files out of the shipped image. releaseVersion = the deploy SHA
// (NEXT_PUBLIC_APP_VERSION), matching the `release` the browser tags errors with (analytics-provider);
// releaseName is the stable app identifier. posthog-cli requires BOTH release fields (or a git/CI env,
// neither of which exists inside the Docker build) — omitting releaseName fails `next build` with
// "Release fields are incomplete". We also gate `enabled` on a real releaseVersion so a build without
// VERSION (releaseVersion falsy) no-ops the upload instead of erroring — the upload never breaks a deploy.
const posthogApiKey = process.env.POSTHOG_API_KEY;
const releaseVersion = process.env.NEXT_PUBLIC_APP_VERSION;

/**
 * Marks a `runAfterProductionCompile` hook that {@link withNonFatalSourcemapUpload} has wrapped.
 *
 * Exists so the guard's attachment is *observable*. The bug below was invisible precisely because a
 * wrapped hook and an unwrapped one were indistinguishable from the outside.
 */
const NON_FATAL_SOURCEMAP_UPLOAD: unique symbol = Symbol.for(
	"alethia.posthog.nonFatalSourcemapUpload",
);

/** The metadata Next hands `runAfterProductionCompile` (next/dist/server/config-shared). */
interface CompileMeta {
	projectDir: string;
	distDir: string;
}

/**
 * A Next config, or the config *function* Next also accepts — which is what `withPostHogConfig`
 * actually returns, whatever its type declaration says. See {@link withNonFatalSourcemapUpload}.
 */
export type NextConfigInput =
	| NextConfig
	| ((
			phase: string,
			ctx: { defaultConfig: NextConfig },
	  ) => NextConfig | Promise<NextConfig>);

/** Options for {@link withNonFatalSourcemapUpload}. */
interface NonFatalOptions {
	/**
	 * Whether a source-map upload hook is expected to be present. True when sourcemaps are enabled.
	 * Finding none while this is true means the guard is attached to nothing, which is reported
	 * rather than passed over in silence.
	 */
	expectHook?: boolean;
}

/** True when `hook` is a hook this module has made non-fatal. */
export function isNonFatalSourcemapHook(hook: unknown): boolean {
	return typeof hook === "function" && NON_FATAL_SOURCEMAP_UPLOAD in hook;
}

/**
 * Deletes every `.map` left under the build output, returning how many went.
 *
 * A missing directory is not an error — there is simply nothing to remove.
 */
async function deleteSourceMaps(meta: CompileMeta): Promise<number> {
	const root = path.resolve(meta.projectDir ?? process.cwd(), meta.distDir ?? ".next");
	let removed = 0;

	const walk = async (dir: string): Promise<void> => {
		const entries = await fs.readdir(dir, { withFileTypes: true });
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				await walk(full);
			} else if (entry.name.endsWith(".map")) {
				await fs.rm(full, { force: true });
				removed += 1;
			}
		}
	};

	try {
		await walk(root);
	} catch (err) {
		if (err instanceof Error && "code" in err && err.code === "ENOENT") return removed;
		throw err;
	}
	return removed;
}

/**
 * Wraps an already-resolved config so its source-map upload hook cannot fail the build.
 *
 * Split out from {@link withNonFatalSourcemapUpload} because the hook only exists *after* the
 * PostHog config function has been invoked by Next.
 */
function wrapResolved(config: NextConfig, expectHook: boolean): NextConfig {
	const hook = config.compiler?.runAfterProductionCompile;
	if (!hook) {
		// Not silence. "Nothing to guard" and "guarding" must never read the same, which is the
		// mistake that let this ship twice.
		if (expectHook) {
			console.error(
				"[posthog] INERT GUARD: source-map upload is enabled but no runAfterProductionCompile " +
					"hook was found to wrap. A failing upload can now fail this build. See #2485.",
			);
		}
		return config;
	}

	const wrapped = Object.assign(
		async (meta: CompileMeta): Promise<void> => {
			try {
				await hook(meta);
			} catch (err) {
				// Deliberately swallowed. Loud enough to find in a build log, never fatal.
				console.warn(
					`[posthog] source-map upload failed; continuing the build without symbolication. ` +
						`Stack traces will not symbolicate until this is fixed: ${err instanceof Error ? err.message : String(err)}`,
				);

				// posthog-cli is passed `--delete-after`, so the maps are removed as part of a
				// SUCCESSFUL upload — and the plugin's own strip step runs after the call that just
				// threw. Both are therefore skipped on this path, while turbopack has already set
				// productionBrowserSourceMaps and the Dockerfile copies .next/static into the runtime
				// image. Swallowing without this would publish the console's source at /_next/static.
				//
				// A cleanup failure IS fatal, unlike the upload: the choice there is between not
				// deploying and publishing our own source, and telemetry being expendable does not
				// make source disclosure expendable.
				const removed = await deleteSourceMaps(meta);
				console.warn(
					`[posthog] removed ${removed} un-uploaded source map(s) so the image does not ship them.`,
				);
			}
		},
		{ [NON_FATAL_SOURCEMAP_UPLOAD]: true },
	);

	return {
		...config,
		compiler: { ...config.compiler, runAfterProductionCompile: wrapped },
	};
}

/**
 * Makes the PostHog source-map upload unable to fail `next build`.
 *
 * The comment above has claimed "the upload never breaks a deploy" since the releaseName break, and
 * it was not true: the gate is on the key being PRESENT, not valid. An invalid POSTHOG_API_KEY threw
 * out of the upload and failed every production console build for ten days (#2244) — the image was
 * never produced, so nothing reaching `main` reached production, while the runner images built fine
 * and the run read as a partial success.
 *
 * The fix for that (#2246) then failed the same way for another ten days (#2485), because it looked
 * for the hook on the WRONG OBJECT. `withPostHogConfig` is declared `(…) => NextConfig` but returns
 * an async config FUNCTION, installing `compiler.runAfterProductionCompile` inside it. Reading
 * `.compiler` off a function yields undefined, so the guard's `if (!hook) return config` early
 * return fired on every build and handed back the config unwrapped. TypeScript could not catch it:
 * the package's own .d.ts states the return type that is not returned.
 *
 * So resolve first, wrap second — and never assume the shape, check it.
 *
 * Telemetry is not worth a release. A failed upload costs symbolicated stack traces until the key is
 * fixed; a failed build costs every deploy.
 */
export function withNonFatalSourcemapUpload(
	config: NextConfig,
	options?: NonFatalOptions,
): NextConfig;
export function withNonFatalSourcemapUpload(
	config: (
		phase: string,
		ctx: { defaultConfig: NextConfig },
	) => NextConfig | Promise<NextConfig>,
	options?: NonFatalOptions,
): (phase: string, ctx: { defaultConfig: NextConfig }) => Promise<NextConfig>;
export function withNonFatalSourcemapUpload(
	config: NextConfigInput,
	options: NonFatalOptions = {},
): NextConfigInput {
	const expectHook = options.expectHook ?? false;

	if (typeof config === "function") {
		return async (phase, ctx) => wrapResolved(await config(phase, ctx), expectHook);
	}
	return wrapResolved(config, expectHook);
}

export default posthogApiKey
	? withNonFatalSourcemapUpload(
			withPostHogConfig(nextConfig, {
				personalApiKey: posthogApiKey,
				projectId: process.env.POSTHOG_PROJECT_ID,
				host: process.env.POSTHOG_API_HOST || "https://eu.posthog.com",
				sourcemaps: {
					enabled: Boolean(releaseVersion),
					releaseName: "console",
					releaseVersion,
					deleteAfterUpload: true,
				},
			}),
			{ expectHook: Boolean(releaseVersion) },
		)
	: nextConfig;
