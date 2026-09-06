// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import {
  brokerAssertionRequestSchema,
  type BrokerAssertionRequest,
} from "@repo/workload-identity/broker";

const GITHUB_ISSUER = "https://token.actions.githubusercontent.com";
const GITHUB_JWKS_URL = `${GITHUB_ISSUER}/.well-known/jwks`;
const CLOCK_SKEW_SECONDS = 30;
const MAX_REQUEST_BYTES = 32_768;

interface JsonWebKeyWithKid extends JsonWebKey {
  kid: string;
}

interface SigningKeySet {
  activeKid: string;
  keys: JsonWebKeyWithKid[];
}

interface DurableObjectId {}

interface DurableObjectStub {
  fetch(request: Request): Promise<Response>;
}

interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}

interface DurableObjectStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  setAlarm(timestamp: number): Promise<void>;
  deleteAll(): Promise<void>;
}

interface DurableObjectState {
  storage: DurableObjectStorage;
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
}

export interface Env {
  REPLAY_GUARD: DurableObjectNamespace;
  ISSUER_URL: string;
  GITHUB_TOKEN_AUDIENCE: string;
  ALLOWED_REPOSITORIES: string;
  ALLOWED_WORKFLOW_REFS: string;
  PROVIDER_AUDIENCES_JSON: string;
  SIGNING_KEYS_JSON: string;
}

interface JwtParts {
  header: { alg?: unknown; kid?: unknown; typ?: unknown };
  payload: { [key: string]: unknown };
  signingInput: Uint8Array;
  signature: Uint8Array;
}

/** Atomically consumes one GitHub token identifier until its expiry. */
export class ReplayGuard {
  constructor(private readonly state: DurableObjectState) {}

  /** Records the first use and refuses every subsequent use of this object id. */
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST")
      return new Response("method not allowed", { status: 405 });
    const body: unknown = await request.json();
    if (!isObject(body)) return new Response("invalid expiry", { status: 400 });
    const expiresAt = body.expiresAt;
    if (typeof expiresAt !== "number" || expiresAt <= Date.now()) {
      return new Response("invalid expiry", { status: 400 });
    }
    return this.state.blockConcurrencyWhile(async () => {
      if (await this.state.storage.get<boolean>("consumed")) {
        return new Response("replayed", { status: 409 });
      }
      await this.state.storage.put("consumed", true);
      await this.state.storage.setAlarm(expiresAt);
      return new Response(null, { status: 204 });
    });
  }

  /** Deletes expired replay state when Cloudflare fires the object alarm. */
  async alarm(): Promise<void> {
    await this.state.storage.deleteAll();
  }
}

/** Handles discovery, JWKS publication, and authenticated assertion minting. */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (
      request.method === "GET" &&
      url.pathname === "/.well-known/openid-configuration"
    ) {
      return json({
        issuer: normalizedIssuer(env.ISSUER_URL),
        jwks_uri: `${normalizedIssuer(env.ISSUER_URL)}/.well-known/jwks.json`,
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
      });
    }
    if (request.method === "GET" && url.pathname === "/.well-known/jwks.json") {
      const keySet = parseSigningKeys(env.SIGNING_KEYS_JSON);
      return json(
        { keys: keySet.keys.map(publicJwk) },
        200,
        "public, max-age=300",
      );
    }
    if (request.method !== "POST" || url.pathname !== "/v1/assertions") {
      return json({ error: "not_found" }, 404);
    }
    return mintAssertion(request, env);
  },
};

/** Authenticates one run-bound request and returns a short-lived broker assertion. */
async function mintAssertion(request: Request, env: Env): Promise<Response> {
  const requestId = crypto.randomUUID();
  let runId = "unknown";
  let provider = "unknown";
  try {
    const contentLength = Number(request.headers.get("content-length") ?? "0");
    if (contentLength > MAX_REQUEST_BYTES) {
      throw new HttpError(413, "request_too_large");
    }
    const authorization = request.headers.get("authorization");
    if (!authorization?.startsWith("Bearer "))
      throw new HttpError(401, "missing_bearer_token");
    const requestText = await request.text();
    if (new TextEncoder().encode(requestText).byteLength > MAX_REQUEST_BYTES) {
      throw new HttpError(413, "request_too_large");
    }
    let requestJson: unknown;
    try {
      requestJson = JSON.parse(requestText);
    } catch {
      throw new HttpError(400, "invalid_request");
    }
    const parsedBody = brokerAssertionRequestSchema.safeParse(requestJson);
    if (!parsedBody.success) throw new HttpError(400, "invalid_request");
    const body = parsedBody.data;
    runId = body.run.runId;
    provider = body.provider;
    assertAllowedRequest(body, env);

    const githubToken = authorization.slice("Bearer ".length);
    const githubClaims = await verifyGithubToken(
      githubToken,
      env.GITHUB_TOKEN_AUDIENCE,
    );
    assertRunBinding(githubClaims, body);
    await consumeReplay(githubClaims, githubToken, env.REPLAY_GUARD);

    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + body.ttlSeconds;
    const assertion = await signJwt(
      {
        iss: normalizedIssuer(env.ISSUER_URL),
        sub: body.subject,
        aud: body.audience,
        iat: now,
        nbf: now - CLOCK_SKEW_SECONDS,
        exp: expiresAt,
        jti: crypto.randomUUID(),
        repository: body.run.repository,
        workflow_ref: body.run.workflowRef,
        run_id: body.run.runId,
        run_attempt: body.run.runAttempt,
        provider: body.provider,
      },
      parseSigningKeys(env.SIGNING_KEYS_JSON),
    );
    logOutcome({ requestId, runId, provider, outcome: "minted" });
    return json({
      assertion,
      issuer: normalizedIssuer(env.ISSUER_URL),
      audience: body.audience,
      subject: body.subject,
      expiresAt: new Date(expiresAt * 1000).toISOString(),
      run: body.run,
    });
  } catch (error: unknown) {
    const failure =
      error instanceof HttpError ? error : new HttpError(500, "internal_error");
    logOutcome({ requestId, runId, provider, outcome: failure.code });
    return json({ error: failure.code, requestId }, failure.status);
  }
}

/** Refuses repositories, workflows, or cloud audiences outside the deployment policy. */
function assertAllowedRequest(body: BrokerAssertionRequest, env: Env): void {
  if (!csvSet(env.ALLOWED_REPOSITORIES).has(body.run.repository)) {
    throw new HttpError(403, "repository_not_allowed");
  }
  if (!csvSet(env.ALLOWED_WORKFLOW_REFS).has(body.run.workflowRef)) {
    throw new HttpError(403, "workflow_not_allowed");
  }
  const audiences: unknown = JSON.parse(env.PROVIDER_AUDIENCES_JSON);
  if (
    !isStringArrayMap(audiences) ||
    !audiences[body.provider]?.includes(body.audience)
  ) {
    throw new HttpError(403, "audience_not_allowed");
  }
}

/** Verifies GitHub's signature and the standard temporal and audience claims. */
async function verifyGithubToken(
  token: string,
  audience: string,
): Promise<{ [key: string]: unknown }> {
  const parts = parseJwt(token);
  if (parts.header.alg !== "RS256" || typeof parts.header.kid !== "string") {
    throw new HttpError(401, "invalid_github_token");
  }
  const response = await fetch(GITHUB_JWKS_URL);
  if (!response.ok) throw new HttpError(503, "github_jwks_unavailable");
  const document: unknown = await response.json();
  if (!hasJwks(document)) throw new HttpError(503, "github_jwks_invalid");
  const jwk = document.keys.find(
    (candidate) => candidate.kid === parts.header.kid,
  );
  if (!jwk) throw new HttpError(401, "invalid_github_token");
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    rsaImportAlgorithm(),
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    arrayBuffer(parts.signature),
    arrayBuffer(parts.signingInput),
  );
  if (!valid) throw new HttpError(401, "invalid_github_token");
  validateStandardClaims(parts.payload, audience);
  return parts.payload;
}

/** Cross-checks request metadata against authenticated GitHub OIDC claims. */
function assertRunBinding(
  claims: { [key: string]: unknown },
  body: BrokerAssertionRequest,
): void {
  if (
    claims.repository !== body.run.repository ||
    claims.workflow_ref !== body.run.workflowRef ||
    claims.run_id !== body.run.runId ||
    Number(claims.run_attempt) !== body.run.runAttempt
  ) {
    throw new HttpError(403, "run_binding_mismatch");
  }
}

/** Atomically consumes a stable digest of the upstream token. */
async function consumeReplay(
  claims: { [key: string]: unknown },
  token: string,
  namespace: DurableObjectNamespace,
): Promise<void> {
  const exp = claims.exp;
  if (typeof exp !== "number") throw new HttpError(401, "invalid_github_token");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  const name = base64Url(new Uint8Array(digest));
  const response = await namespace.get(namespace.idFromName(name)).fetch(
    new Request("https://replay.internal/consume", {
      method: "POST",
      body: JSON.stringify({ expiresAt: (exp + CLOCK_SKEW_SECONDS) * 1000 }),
    }),
  );
  if (response.status === 409)
    throw new HttpError(409, "github_token_replayed");
  if (!response.ok) throw new HttpError(503, "replay_guard_unavailable");
}

/** Signs a compact RS256 JWT with the configured active key. */
async function signJwt(
  payload: { [key: string]: unknown },
  keySet: SigningKeySet,
): Promise<string> {
  const jwk = keySet.keys.find(
    (candidate) => candidate.kid === keySet.activeKid,
  );
  if (!jwk || !jwk.d) throw new Error("active signing key is unavailable");
  const header = base64Url(
    new TextEncoder().encode(
      JSON.stringify({ alg: "RS256", typ: "JWT", kid: jwk.kid }),
    ),
  );
  const encodedPayload = base64Url(
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  const signingInput = new TextEncoder().encode(`${header}.${encodedPayload}`);
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    rsaImportAlgorithm(),
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    signingInput,
  );
  return `${header}.${encodedPayload}.${base64Url(new Uint8Array(signature))}`;
}

/** Validates issuer, audience, and bounded GitHub token timestamps. */
function validateStandardClaims(
  claims: { [key: string]: unknown },
  audience: string,
): void {
  const now = Math.floor(Date.now() / 1000);
  if (
    claims.iss !== GITHUB_ISSUER ||
    claims.aud !== audience ||
    typeof claims.exp !== "number" ||
    claims.exp < now - CLOCK_SKEW_SECONDS ||
    (typeof claims.nbf === "number" && claims.nbf > now + CLOCK_SKEW_SECONDS)
  ) {
    throw new HttpError(401, "invalid_github_token");
  }
}

/** Parses a compact JWT without trusting either decoded object. */
function parseJwt(token: string): JwtParts {
  const segments = token.split(".");
  if (segments.length !== 3) throw new HttpError(401, "invalid_github_token");
  const [encodedHeader, encodedPayload, encodedSignature] = segments;
  if (!encodedHeader || !encodedPayload || !encodedSignature) {
    throw new HttpError(401, "invalid_github_token");
  }
  try {
    return {
      header: JSON.parse(
        new TextDecoder().decode(decodeBase64Url(encodedHeader)),
      ),
      payload: JSON.parse(
        new TextDecoder().decode(decodeBase64Url(encodedPayload)),
      ),
      signingInput: new TextEncoder().encode(
        `${encodedHeader}.${encodedPayload}`,
      ),
      signature: decodeBase64Url(encodedSignature),
    };
  } catch {
    throw new HttpError(401, "invalid_github_token");
  }
}

/** Parses and validates the rotation-aware private signing-key bundle. */
function parseSigningKeys(value: string): SigningKeySet {
  const parsed: unknown = JSON.parse(value);
  if (
    !isObject(parsed) ||
    typeof parsed.activeKid !== "string" ||
    !Array.isArray(parsed.keys)
  ) {
    throw new Error("invalid signing key set");
  }
  const keys = parsed.keys.filter(isSigningJwk);
  if (
    keys.length !== parsed.keys.length ||
    !keys.some((key) => key.kid === parsed.activeKid && key.d)
  ) {
    throw new Error("invalid signing key set");
  }
  return { activeKid: parsed.activeKid, keys };
}

/** Removes private RSA parameters before a key is published. */
function publicJwk(key: JsonWebKeyWithKid): JsonWebKeyWithKid {
  return {
    kty: key.kty,
    n: key.n,
    e: key.e,
    alg: "RS256",
    use: "sig",
    kid: key.kid,
  };
}

/** Returns the Web Crypto parameters shared by RSA imports. */
function rsaImportAlgorithm(): RsaHashedImportParams {
  return { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
}

/** Produces a JSON response with explicit no-sniff and cache controls. */
function json(
  body: unknown,
  status = 200,
  cacheControl = "no-store",
): Response {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": cacheControl,
      "content-type": "application/json",
      "x-content-type-options": "nosniff",
    },
  });
}

/** Normalizes the configured public issuer to one stable origin. */
function normalizedIssuer(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.pathname !== "/")
    throw new Error("ISSUER_URL must be an HTTPS origin");
  return url.origin;
}

/** Converts a comma-separated allowlist to exact string members. */
function csvSet(value: string): Set<string> {
  return new Set(
    value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

/** Encodes bytes using the unpadded URL-safe Base64 alphabet. */
function base64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

/** Decodes unpadded URL-safe Base64 into bytes. */
function decodeBase64Url(value: string): Uint8Array {
  const padded = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

/** Copies bytes into an ArrayBuffer accepted consistently by Web Crypto runtimes. */
function arrayBuffer(value: Uint8Array): ArrayBuffer {
  return Uint8Array.from(value).buffer;
}

/** Narrows unknown JSON to a non-null object. */
function isObject(value: unknown): value is { [key: string]: unknown } {
  return typeof value === "object" && value !== null;
}

/** Narrows the GitHub JWKS document to usable public keys. */
function hasJwks(value: unknown): value is { keys: JsonWebKeyWithKid[] } {
  return (
    isObject(value) &&
    Array.isArray(value.keys) &&
    value.keys.every(isPublicJwk)
  );
}

/** Narrows a value to the RSA public fields used for verification. */
function isPublicJwk(value: unknown): value is JsonWebKeyWithKid {
  return (
    isObject(value) &&
    value.kty === "RSA" &&
    typeof value.kid === "string" &&
    typeof value.n === "string" &&
    typeof value.e === "string"
  );
}

/** Narrows a value to a configured RSA signing key. */
function isSigningJwk(value: unknown): value is JsonWebKeyWithKid {
  return isPublicJwk(value) && value.alg === "RS256" && value.use === "sig";
}

/** Narrows provider audience configuration without accepting scalar values. */
function isStringArrayMap(
  value: unknown,
): value is { [key: string]: string[] } {
  return (
    isObject(value) &&
    Object.values(value).every(
      (entry) =>
        Array.isArray(entry) && entry.every((item) => typeof item === "string"),
    )
  );
}

/** Emits only non-secret identifiers and the request outcome. */
function logOutcome(event: {
  requestId: string;
  runId: string;
  provider: string;
  outcome: string;
}): void {
  console.log(JSON.stringify(event));
}

class HttpError extends Error {
  /** Creates an HTTP-safe refusal without retaining sensitive request data. */
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}
