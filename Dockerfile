# Portable production image. No builder-hosted service is required at build or run time.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* bun.lock* ./
RUN npm install --legacy-peer-deps
COPY . .
# Vite inlines VITE_* variables at build time, so the operator's map style must
# be present during `npm run build`. Passed explicitly as build args — .env is
# never copied into the image and no secret is exposed here.
ARG VITE_MAP_STYLE_URL=""
ARG VITE_MAP_ATTRIBUTION=""
ENV VITE_MAP_STYLE_URL=$VITE_MAP_STYLE_URL \
    VITE_MAP_ATTRIBUTION=$VITE_MAP_ATTRIBUTION
ENV NITRO_PRESET=node-server
RUN npm run build

# Shared production filesystem. Keeping this separate lets AWS build a normal
# runtime image and an operator-only image without putting psql in the app image.
FROM node:22-alpine AS runtime-base
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0
COPY --from=build --chown=node:node /app/.output ./.output
COPY --from=build --chown=node:node /app/db ./db
COPY --from=build --chown=node:node /app/scripts ./scripts
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules

# Operator image for one-off database migration/bootstrap tasks. The existing
# migration runner intentionally requires psql when Docker Compose is absent;
# ECS has no Docker daemon, so psql is present only in this explicit target.
FROM runtime-base AS ops
USER root
RUN apk add --no-cache postgresql-client
USER node

# Default production application image remains minimal and does not contain
# PostgreSQL client tools.
FROM runtime-base AS runtime
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD wget -qO- http://127.0.0.1:3000/api/public/health | grep -q '\"status\":\"ok\"' || exit 1
CMD ["node", ".output/server/index.mjs"]
