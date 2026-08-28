import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";
import { BRAND } from "./assets";
import { BrandLockup, BrandMark } from "./brand-mark";
import { AccountArea, MobileNav, PrimaryNavLinks } from "./app-nav";

/**
 * Anconison design-system chrome. Every screen composes these primitives so
 * spacing, typography and brand placement stay consistent without any screen
 * hardcoding a color value.
 */

export function AppHeader({
  right,
  className,
  variant = "app",
}: {
  right?: ReactNode;
  className?: string;
  /** "public" renders the marketing header without the authenticated module nav. */
  variant?: "app" | "public";
}) {
  return (
    <header className={cn("brand-command-surface relative", className)}>
      <div
        className={cn(
          "mx-auto flex max-w-7xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 sm:px-6 xl:flex-nowrap",
          variant === "app" ? "justify-between" : "justify-between",
        )}
      >
        <Link to="/" className="shrink-0 rounded-sm focus-visible:brand-focus-ring">
          <BrandLockup size={variant === "app" ? 34 : 44} showTagline={variant !== "app"} />
        </Link>
        {variant === "app" ? (
          // Intermediate widths keep all five boards visible by giving the nav
          // its own full-width row; at large widths it sits centered inline.
          <nav
            aria-label="AIRS modules"
            className="order-last hidden w-full min-w-0 basis-full justify-center md:flex xl:order-none xl:w-auto xl:flex-1 xl:basis-auto"
          >
            <PrimaryNavLinks />
          </nav>
        ) : null}
        <div className="flex shrink-0 items-center gap-3 text-sm">
          {right ? right : variant === "app" ? <div className="hidden md:flex"><AccountArea /></div> : null}
          {variant === "app" ? <MobileNav /> : null}
        </div>
      </div>
      <div className="brand-gold-rule h-px w-full" aria-hidden="true" />
    </header>
  );
}

/** Authenticated chrome for routes that manage their own content width. */
export function AppChrome({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <AppHeader />
      <div className="flex-1">{children}</div>
      <AppFooter />
    </div>
  );
}

export function AppFooter({ className }: { className?: string }) {
  return (
    <footer className={cn("mt-16 border-t border-border", className)}>
      <div className="mx-auto flex max-w-6xl flex-col gap-2 px-6 py-8 sm:flex-row sm:items-center sm:justify-between">
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          <BrandMark size={20} decorative />
          {BRAND.name} — {BRAND.tagline}
        </span>
        <span className="text-xs text-muted-foreground">
          Restricted system. Activity is recorded in the tenant audit log.
        </span>
      </div>
    </footer>
  );
}

export function PageShell({
  children,
  headerRight,
  width = "wide",
  variant = "app",
  viewport = false,
}: {
  children: ReactNode;
  headerRight?: ReactNode;
  width?: "wide" | "narrow" | "full";
  variant?: "app" | "public";
  viewport?: boolean;
}) {
  return (
    <div className={cn("flex min-h-screen flex-col bg-background", viewport && "xl:h-screen xl:overflow-hidden")}>
      <AppHeader right={headerRight} variant={variant} />
      <main
        className={cn(
          "mx-auto w-full flex-1",
          viewport && "xl:min-h-0 xl:overflow-hidden",
          width === "full"
            ? "max-w-none px-3 py-5 sm:px-4 xl:px-5 2xl:px-6"
            : "px-6 py-10",
          width === "wide" ? "max-w-6xl" : width === "narrow" ? "max-w-3xl" : "",
        )}
      >
        {children}
      </main>
      {viewport ? <div className="xl:hidden"><AppFooter /></div> : <AppFooter />}
    </div>
  );
}

export function PageHeading({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div>
        {eyebrow ? (
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-muted-foreground">
            {eyebrow}
          </p>
        ) : null}
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-foreground">{title}</h1>
        {description ? (
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function SectionCard({
  title,
  description,
  actions,
  children,
  className,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("rounded-md border border-border bg-card shadow-panel", className)}>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-card-foreground">{title}</h2>
          {description ? (
            <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {actions}
      </div>
      <div className="px-4 py-4">{children}</div>
    </section>
  );
}

const TONES = {
  neutral: "bg-secondary text-secondary-foreground",
  info: "bg-info/12 text-info",
  active: "bg-success/12 text-success",
  caution: "bg-warning/15 text-warning-foreground",
  critical: "bg-destructive/12 text-destructive",
} as const;

export type StatusTone = keyof typeof TONES;

export function StatusPill({
  children,
  tone = "neutral",
  className,
}: {
  children: ReactNode;
  tone?: StatusTone;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wider",
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function DataRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <span className="text-xs uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className="font-mono text-xs text-foreground">{value}</span>
    </div>
  );
}
