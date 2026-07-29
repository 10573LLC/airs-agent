# Portable production image. No Lovable services required at build or run time.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* bun.lock* ./
RUN npm install --legacy-peer-deps
COPY . .
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/.output ./.output
COPY --from=build /app/db ./db
EXPOSE 3000
CMD ["node", ".output/server/index.mjs"]