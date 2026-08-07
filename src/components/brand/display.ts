import { BRAND } from "./assets";

/**
 * Presentation-only naming helpers. These never touch stored data — the
 * platform organization keeps its database name, slug and org_kind. They only
 * decide what the product UI is allowed to render.
 */

/** Internal platform-tenant naming must never surface in the product UI. */
const INTERNAL_ORG_NAME = /anconison/i;

export function displayOrgName(name: string | undefined | null): string {
  if (!name) return BRAND.name;
  return INTERNAL_ORG_NAME.test(name) ? BRAND.name : name;
}

/** "wflack@anconisonpmg.com" -> "wflack"; anything else passes through. */
export function displayPersonName(value: string | undefined | null): string {
  if (!value) return "";
  const at = value.indexOf("@");
  return at > 0 ? value.slice(0, at) : value;
}