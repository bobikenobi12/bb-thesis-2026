// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type {
  WorkloadAssertionRequest,
  WorkloadAssertionSource,
} from "@repo/workload-identity";
import {
  brokerAssertionResponseSchema,
  MAX_ASSERTION_TTL_SECONDS,
  WORKLOAD_SUBJECT,
  type WorkloadProvider,
} from "@repo/workload-identity";
import { decodeJwt } from "jose";
import { mintWorkloadToken, oidcIssuerConfigured } from "./issuer";

const BROKER_URL_ENV = "ALETHIA_E2E_ASSERTION_BROKER_URL";
const BROKER_AUDIENCE_ENV = "ALETHIA_E2E_ASSERTION_BROKER_AUDIENCE";
const GITHUB_REQUEST_URL_ENV = "ACTIONS_ID_TOKEN_REQUEST_URL";
const GITHUB_REQUEST_TOKEN_ENV = "ACTIONS_ID_TOKEN_REQUEST_TOKEN";

/** Production assertion source backed by the console's vault-held local issuer key. */
export const localAssertionSource: WorkloadAssertionSource = {
  async getAssertion(request: WorkloadAssertionRequest): Promise<string> {
    return mintWorkloadToken(request);
  },
};

/** Returns the local production source or the explicitly configured GitHub-Actions E2E broker. */
export function assertionSourceForProvider(
  provider: WorkloadProvider,
): WorkloadAssertionSource {
  return process.env[BROKER_URL_ENV]
    ? brokerAssertionSource(provider)
    : localAssertionSource;
}

/** Whether either the local issuer or a complete broker runtime is configured. */
export function workloadAssertionSourceConfigured(): boolean {
  return oidcIssuerConfigured() || brokerRuntimeConfigured();
}

/** Builds a provider-bound source that authenticates to the broker with GitHub OIDC. */
function brokerAssertionSource(
  provider: WorkloadProvider,
): WorkloadAssertionSource {
  return {
    async getAssertion(request: WorkloadAssertionRequest): Promise<string> {
      const config = brokerConfig();
      const githubToken = await requestGithubToken(
        config.githubRequestUrl,
        config.githubRequestToken,
        config.brokerAudience,
      );
      const response = await fetch(`${config.brokerUrl}/v1/assertions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${githubToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          provider,
          audience: request.audience,
          subject: request.subject ?? WORKLOAD_SUBJECT,
          ttlSeconds: request.ttlSeconds,
          run: config.run,
        }),
      });
      if (!response.ok) {
        throw new Error(
          `E2E assertion broker refused the request (HTTP ${response.status}).`,
        );
      }
      const parsed = brokerAssertionResponseSchema.safeParse(
        await response.json(),
      );
      if (!parsed.success)
        throw new Error("E2E assertion broker returned a malformed response.");
      validateBrokerAssertion(parsed.data, provider, request, config);
      return parsed.data.assertion;
    },
  };
}

interface BrokerConfig {
  brokerUrl: string;
  brokerAudience: string;
  githubRequestUrl: string;
  githubRequestToken: string;
  run: {
    repository: string;
    workflowRef: string;
    runId: string;
    runAttempt: number;
  };
}

/** Reads and validates the GitHub runtime metadata needed for a broker request. */
function brokerConfig(): BrokerConfig {
  const brokerUrl = httpsOrigin(requiredEnv(BROKER_URL_ENV), BROKER_URL_ENV);
  const githubRequestUrl = githubOidcUrl(requiredEnv(GITHUB_REQUEST_URL_ENV));
  const runAttempt = Number(requiredEnv("GITHUB_RUN_ATTEMPT"));
  if (!Number.isInteger(runAttempt) || runAttempt < 1) {
    throw new Error("GITHUB_RUN_ATTEMPT must be a positive integer.");
  }
  return {
    brokerUrl,
    brokerAudience: requiredEnv(BROKER_AUDIENCE_ENV),
    githubRequestUrl,
    githubRequestToken: requiredEnv(GITHUB_REQUEST_TOKEN_ENV),
    run: {
      repository: requiredEnv("GITHUB_REPOSITORY"),
      workflowRef: requiredEnv("GITHUB_WORKFLOW_REF"),
      runId: requiredEnv("GITHUB_RUN_ID"),
      runAttempt,
    },
  };
}

/** Requests a fresh, broker-audience-bound assertion from GitHub's runner endpoint. */
async function requestGithubToken(
  requestUrl: string,
  requestToken: string,
  audience: string,
): Promise<string> {
  const url = new URL(requestUrl);
  url.searchParams.set("audience", audience);
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${requestToken}` },
  });
  if (!response.ok) {
    throw new Error(
      `GitHub OIDC refused the assertion request (HTTP ${response.status}).`,
    );
  }
  const body: unknown = await response.json();
  if (
    !isObject(body) ||
    typeof body.value !== "string" ||
    body.value.length > 16_384
  ) {
    throw new Error("GitHub OIDC returned a malformed assertion response.");
  }
  return body.value;
}

/** Validates broker claims before an assertion crosses into a cloud SDK. */
function validateBrokerAssertion(
  response: {
    assertion: string;
    issuer: string;
    audience: string;
    subject: string;
    expiresAt: string;
    run: BrokerConfig["run"];
  },
  provider: WorkloadProvider,
  request: WorkloadAssertionRequest,
  config: BrokerConfig,
): void {
  let claims: ReturnType<typeof decodeJwt>;
  try {
    claims = decodeJwt(response.assertion);
  } catch {
    throw new Error("E2E assertion broker returned a malformed assertion.");
  }
  const expectedSubject = request.subject ?? WORKLOAD_SUBJECT;
  const expectedTtl = request.ttlSeconds ?? MAX_ASSERTION_TTL_SECONDS;
  const expiresAt = Math.floor(Date.parse(response.expiresAt) / 1000);
  const now = Math.floor(Date.now() / 1000);
  if (
    response.issuer !== config.brokerUrl ||
    claims.iss !== config.brokerUrl ||
    response.audience !== request.audience ||
    claims.aud !== request.audience ||
    response.subject !== expectedSubject ||
    claims.sub !== expectedSubject ||
    claims.provider !== provider ||
    typeof claims.iat !== "number" ||
    typeof claims.exp !== "number" ||
    claims.exp !== expiresAt ||
    claims.exp - claims.iat !== expectedTtl ||
    claims.iat < now - 30 ||
    claims.iat > now + 30 ||
    claims.repository !== config.run.repository ||
    claims.workflow_ref !== config.run.workflowRef ||
    claims.run_id !== config.run.runId ||
    Number(claims.run_attempt) !== config.run.runAttempt ||
    response.run.repository !== config.run.repository ||
    response.run.workflowRef !== config.run.workflowRef ||
    response.run.runId !== config.run.runId ||
    response.run.runAttempt !== config.run.runAttempt
  ) {
    throw new Error(
      "E2E assertion broker returned claims outside the requested scope.",
    );
  }
}

/** Whether every runtime-only broker input is present. */
function brokerRuntimeConfigured(): boolean {
  return [
    BROKER_URL_ENV,
    BROKER_AUDIENCE_ENV,
    GITHUB_REQUEST_URL_ENV,
    GITHUB_REQUEST_TOKEN_ENV,
    "GITHUB_REPOSITORY",
    "GITHUB_WORKFLOW_REF",
    "GITHUB_RUN_ID",
    "GITHUB_RUN_ATTEMPT",
  ].every((name) => Boolean(process.env[name]));
}

/** Reads one required runtime value without including its contents in failures. */
function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value)
    throw new Error(`${name} is required for the E2E assertion broker.`);
  return value;
}

/** Accepts only an HTTPS origin so assertion requests cannot be redirected to an arbitrary path. */
function httpsOrigin(value: string, name: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/"
  ) {
    throw new Error(`${name} must be an HTTPS origin.`);
  }
  return url.origin;
}

/** Restricts the GitHub OIDC callback to GitHub's HTTPS Actions host family. */
function githubOidcUrl(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !url.hostname.endsWith(".actions.githubusercontent.com")
  ) {
    throw new Error(
      `${GITHUB_REQUEST_URL_ENV} is not a GitHub Actions HTTPS URL.`,
    );
  }
  return url.toString();
}

/** Narrows unknown JSON to an addressable non-null object. */
function isObject(value: unknown): value is { [key: string]: unknown } {
  return typeof value === "object" && value !== null;
}
