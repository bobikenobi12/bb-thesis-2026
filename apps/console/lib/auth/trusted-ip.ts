// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { isIP } from "node:net";
import { getAuthConfig, getAuthRateLimit } from "@/lib/config/auth";

/** Reads one valid client IP from the deployment's configured trusted header. */
export function trustedClientIp(headers: Headers): string | null {
  const value = headers.get(getAuthConfig().trustedIpHeader)?.trim();
  return value && isIP(value) !== 0 ? value : null;
}

/**
 * The CLI device-code routes that carry their own limiter bucket.
 *
 * Each route gets its OWN key rather than sharing one, because their honest traffic shapes
 * are nothing alike: `exchange` is polled every two seconds for the whole login, while
 * `start`, `generate`, `deny` and `request` are pressed once or twice. Bucketing them
 * together would mean one ordinary login's polling could throttle the very button the user
 * has to press to finish it.
 */
export type CliDeviceRoute =
  | "start"
  | "generate"
  | "exchange"
  | "deny"
  | "request";

/** Builds the in-memory limiter key for one CLI device-code request. */
export function cliDeviceRateLimitKey(
  route: CliDeviceRoute,
  headers: Headers,
): string | null {
  const ip = trustedClientIp(headers);
  return ip ? `cli-device:${route}:${ip}` : null;
}

/**
 * Refuses production auth traffic that would otherwise share Better Auth's
 * `no-trusted-ip` rate-limit bucket across the whole deployment.
 */
export function trustedIpFailure(request: Request): Response | null {
  if (
    process.env.NODE_ENV !== "production" ||
    getAuthRateLimit().enabled === false
  ) {
    return null;
  }
  if (trustedClientIp(request.headers) !== null) return null;

  const header = getAuthConfig().trustedIpHeader;
  return Response.json(
    {
      error: "trusted_ip_unavailable",
      message:
        `Authentication is unavailable because the trusted proxy did not provide a valid client IP in ${header}. ` +
        "Configure the ingress to overwrite that header before forwarding requests.",
    },
    { status: 503, headers: { "cache-control": "no-store" } },
  );
}
