# AIRS Agent — Local setup

Requirements: Node.js 22+ (or Bun), Docker (optional), PostgreSQL 16 (or use Docker).

## 1. Clone and install

```bash
git clone <your-github-repo-url> airs-agent
cd airs-agent
npm install        # or: bun install
cp .env.example .env
```

## 2. Database

With Docker:

```bash
docker compose up -d db     # applies db/migrations/* and db/seed/* on first start
```

Without Docker, against an existing PostgreSQL:

```bash
createdb airs
psql "$DATABASE_URL" -f db/migrations/0001_init.sql
psql "$DATABASE_URL" -f db/migrations/0002_roles_seed.sql
psql "$DATABASE_URL" -f db/seed/demo_orgs.sql
```

Give the app role a login for local use:

```sql
ALTER ROLE airs_app LOGIN PASSWORD 'localdev';
-- then: DATABASE_URL=postgres://airs_app:localdev@localhost:5432/airs
```

Never connect the application as a superuser or as the schema owner — RLS would be bypassed.

## 3. Run

```bash
npm run dev        # http://localhost:8080
npm run test       # vitest
npm run build      # production build to .output/
```

Verify the database wiring:

```bash
curl localhost:8080/api/public/health
# {"status":"ok","database":"reachable"}  (503 when DATABASE_URL is unset/unreachable)
```

Verify tenant isolation:

```bash
psql "$DATABASE_URL" -f db/tests/rls_isolation.sql
```

## 4. Full stack in Docker

```bash
docker compose up --build     # app on :3000, postgres on :5432
```

The image runs `node .output/server/index.mjs` — no Lovable services involved.
**NOT YET VERIFIED:** the Docker build has not been executed in this environment (no Docker daemon
available during stage 1). Treat `docker compose up --build` as unproven until you run it once.

## 5. Environment variables

See `.env.example`. `DATABASE_URL` and `DB_DRIVER` are the only ones consumed by code today;
the rest are placeholders for adapters that are not yet implemented.