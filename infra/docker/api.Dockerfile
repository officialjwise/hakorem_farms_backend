# The backend image: the API, and from B3 the worker, from one build (ADR-0025). Built in CI, never on the server.
ARG NODE_IMAGE=node:22.23.1-alpine

FROM ${NODE_IMAGE} AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/kernel/package.json packages/kernel/package.json
RUN pnpm install --frozen-lockfile
COPY tsconfig.base.json tsconfig.build.json ./
COPY packages/kernel packages/kernel
COPY src src
RUN pnpm build

# Production dependencies only, installed fresh so no development package reaches the runtime image.
FROM ${NODE_IMAGE} AS prod-deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/kernel/package.json packages/kernel/package.json
RUN pnpm install --frozen-lockfile --prod

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
# Take the distribution's security fixes released after the base image was published (OpenSSL, musl, zlib).
RUN apk upgrade --no-cache
# The runtime needs node only: npm, npx and Corepack (and the tar they bundle) are removed.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/pnpm /usr/local/bin/pnpx /opt/yarn* /usr/local/bin/yarn /usr/local/bin/yarnpkg
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages/kernel/package.json ./packages/kernel/package.json
COPY --from=build /app/packages/kernel/dist ./packages/kernel/dist
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
USER node
EXPOSE 3000
# The migration one-shot runs `node dist/cli/db-migrate.js` from this same image.
CMD ["node", "dist/main.js"]
