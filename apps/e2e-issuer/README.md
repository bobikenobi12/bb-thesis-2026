# E2E assertion issuer

This Cloudflare Worker exchanges a GitHub Actions OIDC token from an approved Alethia workflow for a short-lived, audience-bound assertion. It holds no cloud credentials. A Durable Object consumes each upstream token once.

The `e2e-issuer` GitHub environment supplies these deployment values:

| Kind     | Name                      | Purpose                                     |
| -------- | ------------------------- | ------------------------------------------- |
| Secret   | `CLOUDFLARE_API_TOKEN`    | Worker deployment only                      |
| Secret   | `CLOUDFLARE_ACCOUNT_ID`   | Worker deployment only                      |
| Secret   | `SIGNING_KEYS_JSON`       | Rotation-aware RSA signing keys             |
| Variable | `E2E_ISSUER_URL`          | Stable HTTPS Worker origin                  |
| Variable | `GITHUB_TOKEN_AUDIENCE`   | Audience requested from GitHub OIDC         |
| Variable | `ALLOWED_REPOSITORIES`    | Comma-separated exact repository names      |
| Variable | `ALLOWED_WORKFLOW_REFS`   | Comma-separated exact `workflow_ref` claims |
| Variable | `PROVIDER_AUDIENCES_JSON` | Provider-to-allowed-audiences JSON object   |

`SIGNING_KEYS_JSON` has one active key and may retain old or staged keys:

```json
{
  "activeKid": "2026-09",
  "keys": [
    {
      "kid": "2026-09",
      "kty": "RSA",
      "alg": "RS256",
      "use": "sig",
      "n": "base64url-modulus",
      "e": "AQAB",
      "d": "base64url-private-exponent",
      "p": "base64url-prime",
      "q": "base64url-prime",
      "dp": "base64url-exponent",
      "dq": "base64url-exponent",
      "qi": "base64url-coefficient"
    }
  ]
}
```

The deployed secret contains complete private JWKs; the public endpoint strips every private parameter.

## Rotate a signing key

Rotation uses two deployments so cached JWKS documents never omit a signing key in use:

1. Add the new key to `keys` without changing `activeKid`, deploy, and wait at least five minutes for the published JWKS cache lifetime.
2. Change `activeKid` to the new key and deploy again. Keep the prior public key in `keys` for at least the ten-minute maximum assertion lifetime plus five minutes of clock and cache margin.
3. Remove the prior key in a later deployment.

Never paste the key set into a workflow input, repository variable, log, or issue. Update the environment secret directly.
