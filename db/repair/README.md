# db/repair

Operator-only repair assets. **Nothing here is a numbered production
migration** and nothing here runs automatically, from Docker initialization or
from `npm run db:migrate`.

| File | Purpose |
| --- | --- |
| `reconcile_verify.sql` | Security, tenancy and platform assertions the cumulative reconciliation must pass **before** any migration ledger is written. |

The reconciliation body itself is **not** stored here on purpose. It is derived
at run time from the canonical migrations in `db/migrations/` by
`scripts/lib/idempotent-sql.mjs`, so a reconciled database is definitionally
identical to a freshly migrated one and a hand-copied repair script can never
drift from the canonical schema.

See `scripts/db-reconcile-legacy.mjs` and the Windows runbook in
`LOCAL_SETUP.md`. Never run `docker compose down -v`.
