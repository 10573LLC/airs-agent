import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";

import { getMe, getOrganization, selectOrganization, signOut } from "@/lib/api/auth.functions";
import { canAccessPrimaryModule } from "@/lib/rbac/module-access";
import { ROLE_LABELS } from "@/lib/rbac/roles";
import { cn } from "@/lib/utils";
import { displayOrgName, displayPersonName } from "./display";

/**
 * Shared authenticated navigation. Presentation only: it reads the existing
 * session/organization endpoints and reuses the existing sign-out and
 * organization-selection server functions. No authorization logic lives here —
 * every destination is still enforced server-side by the route it opens.
 */

export const PRIMARY_NAV = [
  { module: "console", to: "/console", label: "Agency Dashboard" },
  { module: "incidents", to: "/incidents", label: "Incident Rooms" },
  { module: "resources", to: "/resources", label: "Readiness Board" },
  { module: "map", to: "/map", label: "Common Operating Picture" },
  { module: "awareness", to: "/awareness", label: "Awareness Board" },
  { module: "simulation", to: "/simulation", label: "Simulation Lab" },
] as const;

function isSectionActive(pathname: string, to: string) {
  return pathname === to || pathname.startsWith(`${to}/`);
}

const linkBase =
  "relative block rounded-sm px-2 py-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] leading-tight transition-colors focus-visible:brand-focus-ring xl:px-2.5 xl:text-[12px]";

export function PrimaryNavLinks({
  orientation = "horizontal",
}: {
  orientation?: "horizontal" | "vertical";
}) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const org = useServerFn(getOrganization);
  const orgQuery = useQuery({ queryKey: ["org"], queryFn: () => org({ data: {} }) });
  const roleKey = orgQuery.data?.ok ? orgQuery.data.data.roleKey : null;
  const permissions = orgQuery.data?.ok ? orgQuery.data.data.permissions : [];
  const visibleNav = PRIMARY_NAV.filter((item) =>
    canAccessPrimaryModule(item.module, roleKey, permissions),
  );

  return (
    <ul
      className={cn(
        "flex gap-0.5 xl:gap-1",
        orientation === "vertical" ? "flex-col items-stretch" : "flex-row items-center",
      )}
    >
      {visibleNav.map((item) => {
        const active = isSectionActive(pathname, item.to);
        return (
          <li key={item.to}>
            <Link
              to={item.to}
              aria-current={active ? "page" : undefined}
              className={cn(
                linkBase,
                orientation === "vertical" ? "whitespace-nowrap" : "text-center",
                active
                  ? "text-[color:var(--brand-gold)] after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:rounded-full after:bg-[color:var(--brand-gold)]"
                  : "text-current/85 hover:bg-white/10 hover:text-current",
              )}
            >
              {item.module === "console" && roleKey === "platform_admin"
                ? "Platform Console"
                : item.label}
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
  const isPlatformAdmin = orgResult?.ok && orgResult.data.roleKey === "platform_admin";
  const contextLine = orgResult?.ok
    ? isPlatformAdmin
      ? ROLE_LABELS[orgResult.data.roleKey]
      : `${displayOrgName(orgResult.data.name)} · ${ROLE_LABELS[orgResult.data.roleKey]}`
    : "No active organization";

  return (
    <div className={cn("flex items-center gap-2.5", compact && "w-full flex-wrap")}>
      <div
        className={cn(
          "min-w-0 max-w-[11rem] text-right leading-tight",
          compact && "max-w-none text-left",
        )}
      >
        <p className="truncate text-xs font-semibold">{displayPersonName(account.displayName)}</p>
        <p className="truncate text-[11px] opacity-75">{contextLine}</p>
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
          className="max-w-[9rem] rounded-md border border-white/25 bg-transparent px-2 py-1 text-xs"
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
          const result = await doSignOut();
          if (!result.ok) return;
          qc.clear();
          if (result.data.logoutUrl) {
            window.location.assign(result.data.logoutUrl);
            return;
          }
          await navigate({ to: "/auth" });
        }}
        className="shrink-0 rounded-md border border-white/25 px-2.5 py-1.5 text-[11px] font-semibold uppercase tracking-wider transition-colors hover:bg-white/10"
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
    <div className="md:hidden">
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
