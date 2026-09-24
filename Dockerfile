# Portable production image. No builder-hosted service is required at build or run time.
FROM --platform=$BUILDPLATFORM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --legacy-peer-deps --no-audit --maxsockets=10
COPY . .
ARG VITE_MAP_STYLE_URL=""
ARG VITE_MAP_ATTRIBUTION=""
ENV VITE_MAP_STYLE_URL=$VITE_MAP_STYLE_URL \
    VITE_MAP_ATTRIBUTION=$VITE_MAP_ATTRIBUTION
ENV NITRO_PRESET=node-server
RUN npm run build

FROM node:22-alpine AS production-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --legacy-peer-deps
RUN npm prune --omit=dev --legacy-peer-deps --no-audit --offline

FROM node:22-alpine AS runtime-base
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0
RUN apk add --no-cache ca-certificates wget \
 && mkdir -p /app/certs \
 && wget -q https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem -O /app/certs/rds-global.pem \
 && test -s /app/certs/rds-global.pem
COPY --from=build --chown=node:node /app/.output ./.output
COPY --from=build --chown=node:node /app/db ./db
COPY --from=build --chown=node:node /app/scripts ./scripts
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=production-deps --chown=node:node /app/node_modules ./node_modules

# One-off migration/bootstrap image. psql is intentionally excluded from the web runtime.
FROM runtime-base AS ops
USER root
RUN apk add --no-cache postgresql16-client
USER node

FROM runtime-base AS runtime
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD wget -qO- http://127.0.0.1:3000/api/public/health | grep -q '"status":"ok"' || exit 1
CMD ["node", ".output/server/index.mjs"]
