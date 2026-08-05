// Presentation helpers shared by the awareness screens. Nothing here decides
// access: every tone and label is derived from a value the server already
// released, and an absent field is rendered as absent rather than guessed.
import type { ReactNode } from "react";

import { StatusPill, type StatusTone } from "@/components/brand";
import {
  OBSERVATION_FRESHNESS_LABELS,
  URGENCY_LABELS,
  VERIFICATION_STATUS_LABELS,
  type ObservationFreshness,
  type UrgencyLevel,
  type VerificationStatus,
} from "@/lib/awareness/model";

export const AWARENESS_DENY_MESSAGES: Record<string, string> = {
  observation_not_found: "That observation does not exist at your access level.",
  observation_state_invalid: "That review step is not allowed from the current status.",
  observation_stale_version: "The observation changed since you loaded it. Reload and try again.",
  observation_terminal: "This observation is closed and can no longer be edited.",
  observation_relationship_invalid: "That link between observations is not allowed.",
  observation_gap_not_found: "That information gap no longer exists.",
  observation_evidence_not_found: "That evidence reference no longer exists.",
  observation_share_not_found: "That release does not exist.",
  observation_share_revoked: "That release was already revoked.",
  incident_closed: "That incident room is closed and accepts no new reports.",
};

export const FRESHNESS_TONE: Record<ObservationFreshness, StatusTone> = {
  current: "active",
  recent: "info",
  aging: "caution",
  stale: "critical",
  expired: "critical",
  unknown: "neutral",
};

export const URGENCY_TONE: Record<UrgencyLevel, StatusTone> = {
  routine: "neutral",
  elevated: "info",
  priority: "caution",
  immediate: "critical",
};

export const VERIFICATION_TONE: Record<VerificationStatus, StatusTone> = {
  unreviewed: "neutral",
  under_review: "info",
  corroborated: "info",
  confirmed: "active",
  disputed: "caution",
  rejected: "critical",
  unable_to_verify: "caution",
};

export function FreshnessPill({ value }: { value: ObservationFreshness }) {
  return (
    <StatusPill tone={FRESHNESS_TONE[value]}>{OBSERVATION_FRESHNESS_LABELS[value]}</StatusPill>
  );
}

export function UrgencyPill({ value }: { value: UrgencyLevel }) {
  return <StatusPill tone={URGENCY_TONE[value]}>{URGENCY_LABELS[value]}</StatusPill>;
}

export function VerificationPill({ value }: { value: VerificationStatus }) {
  return (
    <StatusPill tone={VERIFICATION_TONE[value]}>{VERIFICATION_STATUS_LABELS[value]}</StatusPill>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block text-xs font-medium text-muted-foreground">
      {label}
      <div className="mt-1">{children}</div>
    </label>
  );
}

export const inputClass =
  "w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground";
export const buttonClass =
  "rounded-md bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50";
export const smallButton =
  "rounded-md border border-border px-2 py-1 text-xs font-medium text-foreground hover:bg-muted disabled:opacity-50";

/** Renders a value that may legitimately be absent because disclosure withheld
 *  it. Absence is stated, never filled in. */
export function Detail({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 py-1">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <span className="text-sm text-foreground">
        {value === undefined || value === null || value === "" ? (
          <span className="text-muted-foreground">Not released at your access level</span>
        ) : (
          value
        )}
      </span>
    </div>
  );
}

export function timeText(value: string | null | undefined) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.valueOf()) ? value : d.toLocaleString();
}
