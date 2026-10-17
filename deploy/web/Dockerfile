# Build ONLY the context produced by tools/prepare-web-deploy.ts.
FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN npm install --global pnpm@12.4.2
ENV NEXT_TELEMETRY_DISABLED=1
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @hedgenet/web build

# Full Next app: trusted source and explicit runtime assets are intentionally
# retained. No Git, CreateOS CLI, environment files or build-time secrets needed.
FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 \
    HEDGENET_APP_ROOT=/app \
    HEDGENET_SERVING_DIR=/app/data/serving \
    HEDGENET_CATALOGUE_DIR=/app/data/catalogue
COPY --from=build --chown=node:node /app /app
USER node
EXPOSE 3000
CMD ["node", "apps/web/node_modules/next/dist/bin/next", "start", "apps/web", "--hostname", "0.0.0.0", "--port", "3000"]
