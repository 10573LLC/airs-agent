# AIRS Agent

Secure, incident-based airspace coordination for public-safety agencies.

AIRS Agent lets separate agencies open temporary incident rooms, share approved airspace
information, coordinate drone and crewed-aircraft operations, and end that sharing when the
incident closes.

**Status:** foundation only. No authentication and no application features yet — see
`BUILD_AUDIT.md` for the verified state of every claim.

## Stack

- React 19 + TypeScript
- TanStack Start (Vite 8, Nitro `node-server` build output)
- PostgreSQL 16 with forced row-level security for tenant isolation
- Docker / docker compose for packaging

No hosted builder service is required to install, test, build, run or deploy this repository.

## Quick start

```sh
git clone https://github.com/anconison/airs-agent.git
cd airs-agent
npm install
cp .env.example .env        # then edit DATABASE_URL
npm run db:migrate && npm run db:seed
npm run test
npm run build && node .output/server/index.mjs
```

Full instructions: `LOCAL_SETUP.md`. Architecture: `ARCHITECTURE.md`. Schema: `DATABASE.md`.
Security posture and known gaps: `SECURITY.md`.
