import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { awarenessBoardState } from "../src/lib/awareness/recovery";

const awarenessRouteSource = readFileSync(
  new URL("../src/routes/awareness.index.tsx", import.meta.url),
  "utf8",
);

function retryImplementationSource() {
  const start = awarenessRouteSource.indexOf("const retryObservations = async () => {");
  const end = awarenessRouteSource.indexOf("\n\n  return (", start);

  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);

  return awarenessRouteSource.slice(start, end);
}

describe("Awareness Board recovery state", () => {
  it("shows loading before an authoritative response is available", () => {
    expect(awarenessBoardState({ data: undefined, isError: false })).toEqual({
      status: "loading",
    });
  });

  it("shows empty only after a successful zero-row response", () => {
    expect(
      awarenessBoardState({
        data: { ok: true, data: [] },
        isError: false,
      }),
    ).toEqual({ status: "empty" });
  });

  it("shows successful rows only after a successful non-empty response", () => {
    const rows = [{ id: "observation-1" }];

    expect(
      awarenessBoardState({
        data: { ok: true, data: rows },
        isError: false,
      }),
    ).toEqual({ status: "success", rows });
  });

  it("preserves an API failure code instead of treating it as empty", () => {
    expect(
      awarenessBoardState({
        data: { ok: false, code: "observation_not_found" },
        isError: false,
      }),
    ).toEqual({
      status: "failed",
      kind: "api",
      code: "observation_not_found",
    });
  });

  it("represents a rejected request as a recoverable transport failure", () => {
    expect(awarenessBoardState({ data: undefined, isError: true })).toEqual({
      status: "failed",
      kind: "transport",
    });
  });

  it("prioritizes the latest rejected request over retained successful rows", () => {
    expect(
      awarenessBoardState({
        data: { ok: true, data: [{ id: "stale-observation" }] },
        isError: true,
      }),
    ).toEqual({
      status: "failed",
      kind: "transport",
    });
  });

  it("moves from failure to empty when the retry returns a successful zero-row result", () => {
    const states = [
      awarenessBoardState<{ id: string }>({
        data: { ok: false, code: "internal_error" },
        isError: false,
      }),
      awarenessBoardState<{ id: string }>({
        data: { ok: true, data: [] },
        isError: false,
      }),
    ];

    expect(states).toEqual([
      { status: "failed", kind: "api", code: "internal_error" },
      { status: "empty" },
    ]);
  });

  it("moves from failure to successful rows when the retry returns observations", () => {
    const rows = [{ id: "recovered-observation" }];
    const states = [
      awarenessBoardState<{ id: string }>({
        data: undefined,
        isError: true,
      }),
      awarenessBoardState({
        data: { ok: true as const, data: rows },
        isError: false,
      }),
    ];

    expect(states).toEqual([
      { status: "failed", kind: "transport" },
      { status: "success", rows },
    ]);
  });
});

describe("Awareness Board rendered recovery contract", () => {
  it("keeps the active filters in the authoritative observation query", () => {
    expect(awarenessRouteSource).toContain('queryKey: ["observations", filters]');
    expect(awarenessRouteSource).toContain(
      "incidentId: filters.incidentId || null",
    );
    expect(awarenessRouteSource).toContain(
      "observationType: filters.observationType || null",
    );
    expect(awarenessRouteSource).toContain(
      "verificationStatus: filters.verificationStatus || null",
    );
    expect(awarenessRouteSource).toContain(
      "lifecycleStatus: filters.lifecycleStatus || null",
    );
    expect(awarenessRouteSource).toContain("urgency: filters.urgency || null");
    expect(awarenessRouteSource).toContain(
      "sourceType: filters.sourceType || null",
    );
    expect(awarenessRouteSource).toContain(
      "includeTerminal: filters.includeTerminal",
    );
  });

  it("retries only the observation request and does not broaden invalidation", () => {
    const retrySource = retryImplementationSource();

    expect(retrySource).toContain("await observations.refetch()");
    expect(retrySource).not.toContain("summary.refetch");
    expect(retrySource).not.toContain("incidents.refetch");
    expect(retrySource).not.toContain("invalidateQueries");
    expect(retrySource).not.toContain("qc.");
  });

  it("retains the failed presentation for the duration of a retry", () => {
    const retrySource = retryImplementationSource();

    expect(awarenessRouteSource).toContain(
      "const displayedBoardState = retryFailure ?? boardState;",
    );
    expect(awarenessRouteSource).toContain(
      "const isRetrying = retryFailure !== null;",
    );
    expect(retrySource).toContain("setRetryFailure(boardState);");
    expect(retrySource).toContain("await observations.refetch();");
    expect(retrySource).toContain("finally {");
    expect(retrySource).toContain("setRetryFailure(null);");
    expect(retrySource.indexOf("setRetryFailure(boardState);")).toBeLessThan(
      retrySource.indexOf("await observations.refetch();"),
    );
    expect(retrySource.indexOf("await observations.refetch();")).toBeLessThan(
      retrySource.indexOf("setRetryFailure(null);"),
    );
  });

  it("renders an alert and a disabled or relabelled Retry action while retrying", () => {
    expect(awarenessRouteSource).toContain('role="alert"');
    expect(awarenessRouteSource).toContain("Unable to load observations");
    expect(awarenessRouteSource).toContain("disabled={isRetrying}");
    expect(awarenessRouteSource).toContain(
      "onClick={() => void retryObservations()}",
    );
    expect(awarenessRouteSource).toContain(
      '{isRetrying ? "Retrying…" : "Retry"}',
    );
  });

  it("renders loading, failure, empty, and success through exclusive status branches", () => {
    expect(awarenessRouteSource).toContain(
      'displayedBoardState.status === "loading"',
    );
    expect(awarenessRouteSource).toContain(
      'displayedBoardState.status === "failed"',
    );
    expect(awarenessRouteSource).toContain(
      'displayedBoardState.status === "empty"',
    );
    expect(awarenessRouteSource).toContain(
      'displayedBoardState.status === "success"',
    );
    expect(awarenessRouteSource).toContain("Loading observations…");
    expect(awarenessRouteSource).toContain(
      "No observations match these filters.",
    );
    expect(awarenessRouteSource).toContain(
      'const rows = displayedBoardState.status === "success" ? displayedBoardState.rows : [];',
    );
  });

  it("does not derive the empty presentation from unavailable or failed query data", () => {
    expect(awarenessRouteSource).toContain(
      "data: observations.data,\n    isError: observations.isError,",
    );
    expect(awarenessRouteSource).not.toContain(
      "observations.data?.ok ? observations.data.data : []",
    );
    expect(awarenessRouteSource).not.toContain(
      "observations.data && observations.data.ok ? observations.data.data : []",
    );
  });
});
