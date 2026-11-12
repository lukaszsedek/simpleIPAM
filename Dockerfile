# syntax=docker/dockerfile:1
# The web build output is plain static files, so it always runs on the builder's own architecture (fast under multi-arch builds).
FROM --platform=$BUILDPLATFORM node:24-alpine AS web
WORKDIR /web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM node:24-alpine
ENV NODE_ENV=production PORT=8080 DB_PATH=/data/ipam.db STATIC_DIR=/app/public
WORKDIR /app
# Server has zero npm dependencies: HTTP + SQLite come from Node's stdlib (node:sqlite).
COPY server/package.json ./
COPY server/src ./src
COPY --from=web /web/dist ./public
# Version info (set by CI from the git tag / commit); shown in the UI. Declared late to keep the layers above cacheable.
ARG APP_VERSION=dev
ARG APP_COMMIT=unknown
ENV APP_VERSION=$APP_VERSION APP_COMMIT=$APP_COMMIT
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/api/health >/dev/null || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
