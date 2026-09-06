# syntax=docker/dockerfile:1
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Enterprise/hosted console image. For a community-only image use
# Dockerfile.community. Build context = repo root:
#   docker build -f apps/console/Dockerfile -t alethia-console .
#
# Targets:
#   build   — full monorepo install + `next build` (also used for the one-shot
#             `migrate` service, which needs the drizzle migrator + lib/db).
#   runner  — slim Next standalone runtime (default).

FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

# ---- build: install workspace deps + produce the standalone bundle ----
FROM base AS build
COPY . .
# Include @alethia/ee so its build toolchain (esbuild) + deps install — it's a
# workspace dependency of console but `console...` alone doesn't pull its devDeps.
RUN pnpm install --frozen-lockfile --filter console... --filter @alethia/ee
# Placeholder env so the strict zod config modules (auth/database/storage) pass
# validation while `next build` collects page data — importing route modules
# constructs the auth instance, which builds the Drizzle client + reads config at
# load time. These are BUILD-ONLY and do NOT carry into the runner stage (real
# values come from the runtime env / compose env_file). postgres-js + the S3
# client connect lazily, so no service is contacted during the build.
ENV BETTER_AUTH_SECRET=build-time-placeholder \
    BETTER_AUTH_URL=http://localhost:3000 \
    ALETHIA_DATABASE_URL=postgres://build:build@localhost:5432/build \
    ALETHIA_APP_DATABASE_URL=postgres://build:build@localhost:5432/build \
    ALETHIA_STORAGE_ENDPOINT=http://localhost:8333 \
    ALETHIA_STORAGE_ACCESS_KEY_ID=build \
    ALETHIA_STORAGE_SECRET_ACCESS_KEY=build
# Canvas is gated by a NEXT_PUBLIC_ flag that Next inlines at build time. Default
# off; pass --build-arg NEXT_PUBLIC_CANVAS_ENABLED=true (or via compose build.args)
# to bake the design-project canvas into the image.
ARG NEXT_PUBLIC_CANVAS_ENABLED=false
ENV NEXT_PUBLIC_CANVAS_ENABLED=$NEXT_PUBLIC_CANVAS_ENABLED
# Deploy release (git SHA) — inlined so the browser bundle tags PostHog errors with it and the
# source-map upload keys maps to the same release. CI passes VERSION=${{ github.sha }}.
ARG VERSION=dev
ENV NEXT_PUBLIC_APP_VERSION=$VERSION
ENV ALETHIA_EDITION=enterprise \
    ALETHIA_SOURCE_COMMIT=$VERSION
ARG ALETHIA_CORE_SOURCE_URL=https://github.com/alethialabs-io/alethialabs
ENV ALETHIA_CORE_SOURCE_URL=$ALETHIA_CORE_SOURCE_URL
# PostHog Error-tracking source-map upload (see next.config.ts). projectId + API host are non-secret
# build args; the personal WRITE key is a BuildKit secret mounted ONLY on the console build step below,
# so it never lands in an image layer. No key → withPostHogConfig no-ops (OSS/local build unaffected).
ARG POSTHOG_PROJECT_ID=
ARG POSTHOG_API_HOST=https://eu.posthog.com
ENV POSTHOG_PROJECT_ID=$POSTHOG_PROJECT_ID POSTHOG_API_HOST=$POSTHOG_API_HOST
# Build the enterprise package (esbuild → ee/dist/index.js) BEFORE next build, so
# next's serverExternalPackages trace pulls @alethia/ee + its deps into the
# standalone bundle. Without dist/, the loader's tolerant require falls back to the
# community build (no orgs/teams/SSO).
RUN pnpm --filter @alethia/ee build
# The PostHog write key (BuildKit secret) is exported only for this RUN; absent → empty → no upload.
RUN --mount=type=secret,id=posthog_api_key \
    POSTHOG_API_KEY="$(cat /run/secrets/posthog_api_key 2>/dev/null || true)" \
    pnpm --filter console build

# ---- migrate: one-shot DB migrate (drizzle migrator lives in full node_modules) ----
FROM build AS migrate
WORKDIR /app/apps/console
CMD ["node", "scripts/migrate.mjs"]

# ---- runner: slim standalone runtime ----
FROM node:22-alpine AS runner
WORKDIR /app
# Build args are scoped per stage. Redeclare VERSION here so the running container carries the
# commit that produced its standalone bundle, rather than leaving provenance behind in `build`.
ARG VERSION=dev
ENV NODE_ENV=production \
    ALETHIA_EDITION=enterprise \
    ALETHIA_SOURCE_COMMIT=$VERSION
RUN addgroup -S nodejs && adduser -S nextjs -G nodejs
COPY --from=build --chown=nextjs:nodejs /app/apps/console/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/apps/console/.next/static ./apps/console/.next/static
COPY --from=build --chown=nextjs:nodejs /app/apps/console/public ./apps/console/public
USER nextjs
EXPOSE 3000
ENV PORT=3000 HOSTNAME=0.0.0.0
CMD ["node", "apps/console/server.js"]
