import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";

import { getMe, getOrganization, selectOrganization, signOut } from "@/lib/api/auth.functions";
import { ROLE_LABELS } from "@/lib/rbac/roles";
import { cn } from "@/lib/utils";

/**
 * Shared authenticated navigation. Presentation only: it reads the existing
 * session/organization endpoints and reuses the existing sign-out and
 * organization-selection server functions. No authorization logic lives here —
 * every destination is still enforced server-side by the route it opens.
 */

export const PRIMARY_NAV = [
  { to: "/console", label: "Agency Dashboard" },
  { to: "/incidents", label: "Incident Rooms" },
  { to: "/resources", label: "Readiness Board" },
  { to: "/map", label: "Common Operating Picture" },
  { to: "/awareness", label: "Awareness Board" },
] as const;

function isSectionActive(pathname: string, to: string) {
  return pathname === to || pathname.startsWith(`${to}/`);
}

const linkBase =
  "rounded-sm px-2.5 py-2 text-[11px] font-semibold uppercase tracking-[0.08em] whitespace-nowrap transition-colors focus-visible:brand-focus-ring";

export function PrimaryNavLinks({ orientation = "horizontal" }: { orientation?: "horizontal" | "vertical" }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  return (
    <ul
      className={cn(
        "flex gap-1",
        orientation === "vertical" ? "flex-col items-stretch" : "flex-row items-center",
      )}
    >
      {PRIMARY_NAV.map((item) => {
        const active = isSectionActive(pathname, item.to);
        return (
          <li key={item.to}>
            <Link
              to={item.to}
              aria-current={active ? "page" : undefined}
              className={cn(
                linkBase,
                "block",
                active
                  ? "bg-white/12 text-[color:var(--brand-gold)] shadow-[inset_0_-2px_0_0_var(--brand-gold)]"
                  : "text-current/85 hover:bg-white/10 hover:text-current",
              )}
            >
              {item.label}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

export function AccountArea({ compact = false }: { compact?: boolean }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const me = useServerFn(getMe);
  const org = useServerFn(getOrganization);
  const selectOrg = useServerFn(selectOrganization);
  const doSignOut = useServerFn(signOut);

  const meQuery = useQuery({ queryKey: ["me"], queryFn: () => me() });
  const orgQuery = useQuery({ queryKey: ["org"], queryFn: () => org({ data: {} }) });

  const meResult = meQuery.data;
  if (!meResult?.ok) {
    return (
      <Link
        to="/auth"
        className="rounded-md border border-white/25 px-3 py-1.5 text-xs font-semibold uppercase tracking-wider transition-colors hover:bg-white/10"
      >
        Sign in
      </Link>
    );
  }

  const { account, memberships, activeOrgId } = meResult.data;
  const orgResult = orgQuery.data;
  const activeMemberships = memberships.filter((m) => m.status === "active");

  return (
    <div className={cn("flex items-center gap-3", compact && "w-full flex-wrap")}>
      <div className={cn("min-w-0 text-right leading-tight", compact && "text-left")}>
        <p className="truncate text-xs font-semibold">{account.displayName}</p>
        <p className="truncate text-[11px] opacity-75">
          {orgResult?.ok
            ? `${orgResult.data.name} · ${ROLE_LABELS[orgResult.data.roleKey]}`
            : "No active organization"}
        </p>
      </div>

      {activeMemberships.length > 1 ? (
        <label className="sr-only" htmlFor="airs-org-select">
          Active organization
        </label>
      ) : null}
      {activeMemberships.length > 1 ? (
        <select
          id="airs-org-select"
          value={activeOrgId ?? ""}
          onChange={async (event) => {
            await selectOrg({ data: { orgId: event.target.value } });
            await qc.invalidateQueries();
          }}
          className="max-w-[12rem] rounded-md border border-white/25 bg-transparent px-2 py-1.5 text-xs"
        >
          {activeOrgId ? null : <option value="">Select organization…</option>}
          {activeMemberships.map((m) => (
            <option key={m.orgId} value={m.orgId} className="text-foreground">
              {m.orgName}
            </option>
          ))}
        </select>
      ) : null}

      <button
        type="button"
        onClick={async () => {
          await doSignOut();
          qc.clear();
          await navigate({ to: "/auth" });
        }}
        className="rounded-md border border-white/25 px-3 py-1.5 text-xs font-semibold uppercase tracking-wider transition-colors hover:bg-white/10"
      >
        Sign out
      </button>
    </div>
  );
}

/** Mobile disclosure holding the same five destinations plus the account area. */
export function MobileNav() {
  const [open, setOpen] = useState(false);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  return (
    <div className="lg:hidden">
      <button
        type="button"
        aria-expanded={open}
        aria-controls="airs-mobile-nav"
        onClick={() => setOpen((v) => !v)}
        className="rounded-md border border-white/25 px-3 py-1.5 text-xs font-semibold uppercase tracking-wider transition-colors hover:bg-white/10"
      >
        {open ? "Close" : "Menu"}
      </button>
      {open ? (
        <div
          id="airs-mobile-nav"
          className="absolute left-0 right-0 top-full z-40 brand-command-surface border-t border-white/15 px-6 py-4 shadow-panel"
        >
          <nav aria-label="AIRS modules">
            <PrimaryNavLinks orientation="vertical" />
          </nav>
          <div className="mt-4 border-t border-white/15 pt-4">
            <AccountArea compact />
          </div>
        </div>
      ) : null}
    </div>
  );
}
