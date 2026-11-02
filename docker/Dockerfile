# One build, three runtime images: "api" (also the worker and the migrator), "web" and "fixture".
FROM node:22-slim AS base
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /repo

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY prisma prisma
RUN pnpm install --frozen-lockfile
COPY apps apps
COPY packages packages
RUN npx prisma generate \
  && pnpm --filter @esm/shared build \
  && pnpm --filter @esm/api build \
  && pnpm --filter @esm/web build

FROM base AS api
ENV NODE_ENV=production
COPY --from=build /repo /repo
WORKDIR /repo/apps/api
USER node
CMD ["node", "dist/main.js"]

FROM node:22-slim AS web
ENV NODE_ENV=production HOSTNAME=0.0.0.0 PORT=3000
WORKDIR /app
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
USER node
CMD ["node", "apps/web/server.js"]

FROM node:22-slim AS fixture
WORKDIR /app
COPY fixture/server.mjs ./server.mjs
USER node
CMD ["node", "server.mjs"]
