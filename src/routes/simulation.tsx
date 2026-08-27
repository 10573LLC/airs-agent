import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMemo, useState } from "react";

import { PageHeading, PageShell, SectionCard, StatusPill } from "@/components/brand";
import { getMe } from "@/lib/api/auth.functions";
import {
  SIMULATION_BANNER,
  assessAirs,
  compileScenario,
  injectFriction,
  visibleEvents,
  type CompiledScenario,
  type SimConfidence,
} from "@/lib/simulation/model";

export const Route = createFileRoute("/simulation")({
  head: () => ({ meta: [{ title: "Simulation Lab — AIRS Agent" }] }),
  ssr: false,
  component: SimulationPage,
});

const confidenceTone: Record<SimConfidence, "active" | "info" | "caution" | "critical"> = {
  confirmed: "active",
  probable: "info",
  unverified: "caution",
  conflicting: "critical",
};
function formatClock(seconds: number) {
  const minutes = Math.floor(seconds / 60).toString().padStart(2, "0");
  const remainder = (seconds % 60).toString().padStart(2, "0");
  return `T+${minutes}:${remainder}`;
}

function SimulationPage() {
  const me = useServerFn(getMe);
  const session = useQuery({ queryKey: ["me"], queryFn: () => me() });
  const [scenarioText, setScenarioText] = useState("");
  const [scenario, setScenario] = useState<CompiledScenario | null>(null);
  const [clockSeconds, setClockSeconds] = useState(0);

  const visible = useMemo(
    () => (scenario ? visibleEvents(scenario, clockSeconds) : []),
    [scenario, clockSeconds],
  );
  const assessments = useMemo(() => assessAirs(visible), [visible]);

  const start = () => {
    if (!scenarioText.trim()) return;
    setScenario(compileScenario(scenarioText));
    setClockSeconds(0);
  };

  const reset = () => {
    setScenario(null);
    setClockSeconds(0);
  };
  if (session.isLoading) {
    return (
      <PageShell width="wide">
        <p className="text-sm text-muted-foreground">Loading simulation controls…</p>
      </PageShell>
    );
  }

  if (!session.data?.ok) {
    return (
      <PageShell width="narrow">
        <h1 className="text-xl font-semibold">Session required</h1>
        <Link to="/auth" className="mt-4 inline-block text-sm underline">
          Go to sign in
        </Link>
      </PageShell>
    );
  }

  return (
    <PageShell width="wide">
      <div className="rounded-md border border-warning/40 bg-warning/10 px-4 py-3 text-center text-sm font-bold tracking-wide text-warning-foreground">
        {SIMULATION_BANNER}
      </div>

      <div className="mt-8">
        <PageHeading
          eyebrow="Exercise control"
          title="AIRS Simulation Lab"          description="Run a cold, time-sequenced public safety scenario without writing operational records or implying any vendor system is actually connected."
        />
      </div>

      <div className="mt-8 grid gap-6 lg:grid-cols-[1.05fr_1.95fr]">
        <SectionCard title="Scenario Controller" description="Describe the incident exactly as an exercise controller would present it.">
          <textarea
            value={scenarioText}
            onChange={(event) => setScenarioText(event.target.value)}
            rows={10}
            placeholder="Example: Multiple callers report a partial building collapse during a large event..."
            className="w-full rounded-md border border-input bg-background p-3 text-sm text-foreground"
          />
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={start}
              disabled={!scenarioText.trim()}
              className="rounded-md bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50"
            >
              Start exercise
            </button>
            <button
              type="button"
              onClick={reset}
              className="rounded-md border border-border px-3 py-2 text-sm font-semibold text-foreground hover:bg-muted"
            >
              Reset
            </button>
          </div>
          {scenario ? (
            <div className="mt-5 space-y-3 border-t border-border pt-4">
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Exercise clock</span>
                <span className="font-mono text-lg font-semibold text-foreground">{formatClock(clockSeconds)}</span>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => setClockSeconds((value) => value + 30)}
                  className="rounded-md bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground"
                >
                  Advance 30 sec
                </button>
                <button
                  type="button"
                  onClick={() => setScenario((current) => current ? injectFriction(current, clockSeconds) : current)}
                  className="rounded-md border border-destructive/40 px-3 py-2 text-sm font-semibold text-destructive hover:bg-destructive/5"
                >
                  Inject conflicting report
                </button>
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">
                Events are released by exercise time. AIRS sees only information available at the current clock, not the full scenario timeline.
              </p>
            </div>
          ) : null}
        </SectionCard>

        <SectionCard title="Synthetic Integration Feed" description="Industry-style source updates with provenance, confidence, and friction preserved.">          {!scenario ? (
            <p className="text-sm text-muted-foreground">Start an exercise to begin receiving synthetic system updates.</p>
          ) : visible.length === 0 ? (
            <p className="text-sm text-muted-foreground">No synthetic updates have arrived yet.</p>
          ) : (
            <div className="space-y-3">
              {visible.map((row) => (
                <article key={row.id} className="rounded-md border border-border p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs text-muted-foreground">{formatClock(row.atSeconds)}</span>
                    <StatusPill tone="info">{row.source}</StatusPill>
                    <StatusPill tone={confidenceTone[row.confidence]}>{row.confidence}</StatusPill>
                  </div>
                  <h3 className="mt-2 text-sm font-semibold text-foreground">{row.headline}</h3>
                  <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{row.detail}</p>
                  {row.friction ? (
                    <p className="mt-2 rounded-md bg-muted px-2 py-1.5 text-xs text-muted-foreground">
                      Friction: {row.friction}
                    </p>
                  ) : null}
                </article>
              ))}
            </div>
          )}
        </SectionCard>
      </div>

      <div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {assessments.map((assessment) => (
          <SectionCard key={assessment.pillar} title={assessment.pillar} description={assessment.summary}>            <ul className="space-y-2 text-sm text-muted-foreground">
              {assessment.items.map((item) => (
                <li key={item} className="flex gap-2">
                  <span aria-hidden="true">•</span>
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </SectionCard>
        ))}
      </div>

      <div className="mt-6 rounded-md border border-border bg-muted/40 p-4 text-xs leading-relaxed text-muted-foreground">
        <strong className="text-foreground">Simulation boundary:</strong> synthetic CAD, RTCC, UAS, C-UAS, radio, fire/EMS, and weather updates are exercise artifacts only. They do not create operational incidents, observations, evidence, credentials, connector authorization, or live data access.
      </div>
    </PageShell>
  );
}