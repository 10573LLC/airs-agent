// Shared presentation helpers for the incident-room screens. The UI mirrors
// server decisions; it never makes one.

export const DENY_MESSAGES: Record<string, string> = {
  unauthenticated: "Your session is not valid. Sign in again.",
  session_invalid: "Your session has expired or was revoked. Sign in again.",
  no_active_org: "Select an organization in the console first.",
  not_a_member: "You do not hold a membership in that organization.",
  membership_suspended: "Your membership in this organization is suspended.",
  membership_revoked: "Your membership in this organization was revoked.",
  forbidden: "Your role does not include the permission required for this action.",
  incident_not_found: "That incident room does not exist for your organization.",
  incident_state_invalid: "That action is not allowed in the room's current state.",
  incident_stale_version: "The room changed since you loaded it. Reload and try again.",
  partner_not_eligible: "That agency is not an approved trusted partner.",
  participation_inactive: "Your organization's participation in this room is not active.",
  invalid_input: "Check the values you entered.",
  internal_error: "Something went wrong on the server.",
};

export function Denied({ code }: { code: string }) {
  return (
    <p role="alert" className="text-sm text-destructive">
      {DENY_MESSAGES[code] ?? "Access denied."}
    </p>
  );
}

export function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-8 rounded-lg border border-border">
      <h2 className="border-b border-border px-4 py-3 text-sm font-semibold text-foreground">
        {title}
      </h2>
      <div className="px-4 py-3">{children}</div>
    </section>
  );
}
