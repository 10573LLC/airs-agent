export type AwarenessReadResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: string };

export type AwarenessBoardFailure =
  | { status: "failed"; kind: "transport" }
  | { status: "failed"; kind: "api"; code: string };

export type AwarenessBoardState<T> =
  | { status: "loading" }
  | AwarenessBoardFailure
  | { status: "empty" }
  | { status: "success"; rows: readonly T[] };

/**
 * Converts the observation query into one mutually exclusive presentation
 * state. A rejected latest request takes precedence over retained query data,
 * so stale rows are never presented as a fresh success after a failed refetch.
 */
export function awarenessBoardState<T>(query: {
  data: AwarenessReadResult<readonly T[]> | undefined;
  isError: boolean;
}): AwarenessBoardState<T> {
  if (query.isError) return { status: "failed", kind: "transport" };

  if (query.data) {
    if (!query.data.ok) {
      return { status: "failed", kind: "api", code: query.data.code };
    }

    if (query.data.data.length === 0) return { status: "empty" };
    return { status: "success", rows: query.data.data };
  }

  return { status: "loading" };
}
