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

FROM node:22-alpine AS runtime
# Production migrations run as an explicit one-off ECS task. The canonical
# migration runner requires psql; install only the PostgreSQL client, never a server.
RUN apk add --no-cache postgresql16-client
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0
COPY --from=build --chown=node:node /app/.output ./.output
COPY --from=build --chown=node:node /app/db ./db
COPY --from=build --chown=node:node /app/scripts ./scripts
COPY --from=build --chown=node:node /app/node_modules ./node_modules
# Run as the unprivileged `node` user shipped with the base image.
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD wget -qO- http://127.0.0.1:3000/api/public/health | grep -q '"status":"ok"' || exit 1
CMD ["node", ".output/server/index.mjs"]
