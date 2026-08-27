import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMemo, useState } from "react";

import { PageHeading, PageShell, SectionCard, StatusPill } from "@/components/brand";
import { OperationalWorkspace } from "@/components/simulation/operational-workspace";
import { getMe, getOrganization } from "@/lib/api/auth.functions";
import { canRunSimulation } from "@/lib/rbac/module-access";
import { buildOperationalProjection } from "@/lib/simulation/operational";
import {
  SIMULATION_BANNER,
  assessAirs,
  buildSimulationState,
  compileScenario,
  injectFriction,
  nextEventTime,
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
  reported: "info",
  unverified: "caution",
  conflicting: "critical",
};
function formatClock(seconds: number) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60).toString().padStart(2, "0");
  return `T+${hours}:${minutes}`;
}

function SimulationPage() {
  const me = useServerFn(getMe);
  const org = useServerFn(getOrganization);
  const session = useQuery({ queryKey: ["me"], queryFn: () => me() });
  const organization = useQuery({
    queryKey: ["org"],
    queryFn: () => org({ data: {} }),
    enabled: session.data?.ok === true,
  });
  const [scenarioText, setScenarioText] = useState("");
  const [scenario, setScenario] = useState<CompiledScenario | null>(null);
  const [clockSeconds, setClockSeconds] = useState(0);

  const visible = useMemo(
    () => (scenario ? visibleEvents(scenario, clockSeconds) : []),
    [scenario, clockSeconds],
  );
  const state = useMemo(() => scenario ? buildSimulationState(scenario, clockSeconds) : null, [scenario, clockSeconds]);
  const assessments = useMemo(() => assessAirs(visible, state ?? undefined), [visible, state]);
  const operational = useMemo(() => scenario ? buildOperationalProjection(scenario, clockSeconds) : null, [scenario, clockSeconds]);

  const start = () => {
    if (!scenarioText.trim()) return;
    setScenario(compileScenario(scenarioText));
    setClockSeconds(0);
  };

  const reset = () => {
    setScenario(null);
    setClockSeconds(0);
  };
  if (session.isLoading || (session.data?.ok === true && organization.isLoading)) {
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
        <Link to="/auth" className="mt-4 inline-block text-sm underline">Go to sign in</Link>
      </PageShell>
    );
  }

  const orgResult = organization.data;
  const roleKey = orgResult?.ok ? orgResult.data.roleKey : null;
  if (!organization.isLoading && !canRunSimulation(roleKey)) {
    return (
      <PageShell width="narrow">
        <PageHeading
          eyebrow="Exercise control"
          title="Simulation access required"
          description="The Simulation Lab is available to platform administrators and designated agency exercise-controller roles. This does not grant access to agency operational records."
        />
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
          title="AIRS Simulation Lab"
          description="Run a cold, time-sequenced public safety scenario without writing operational records or implying any vendor system is actually connected."
        />
      </div>

      <div className="mt-6">
        <SectionCard title="Scenario Controller" description="Load the exercise, then watch AIRS build the operational picture below as the clock advances.">
          <textarea
            value={scenarioText}
            onChange={(event) => setScenarioText(event.target.value)}
            rows={5}
            placeholder="Paste the exercise scenario here..."
            className="w-full rounded-md border border-input bg-background p-3 text-sm text-foreground"
          />
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button type="button" onClick={start} disabled={!scenarioText.trim()} className="rounded-md bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50">Start exercise</button>
            <button type="button" onClick={reset} className="rounded-md border border-border px-3 py-2 text-sm font-semibold text-foreground hover:bg-muted">Reset</button>
          </div>

          <div className="mt-4 border-t border-border pt-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Exercise playback</p>
                <p className="mt-1 text-xs text-muted-foreground">{scenario ? "Advance the authored timeline one event at a time." : "Start the exercise to enable timeline controls."}</p>
              </div>
              <span className="font-mono text-lg font-semibold text-foreground">{formatClock(clockSeconds)}</span>
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="button" disabled={!scenario} onClick={() => scenario && setClockSeconds((value) => nextEventTime(scenario, value))} className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-40">Advance to next event</button>
              <button type="button" disabled={!scenario} onClick={() => setClockSeconds((value) => value + 60)} className="rounded-md border border-border px-3 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-40">+1 min</button>
              <button type="button" disabled={!scenario} onClick={() => setClockSeconds((value) => value + 300)} className="rounded-md border border-border px-3 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-40">+5 min</button>
              <button type="button" disabled={!scenario} onClick={() => setScenario((current) => current ? injectFriction(current, clockSeconds) : current)} className="rounded-md border border-destructive/40 px-3 py-2 text-sm font-semibold text-destructive hover:bg-destructive/5 disabled:cursor-not-allowed disabled:opacity-40">Inject conflicting report</button>
            </div>
          </div>
        </SectionCard>
      </div>

      <OperationalWorkspace projection={operational} />

      <div className="mt-6">
        <SectionCard title="Synthetic Integration Feed" description="Supporting telemetry: source facts, provenance, confidence, and exercise friction.">
          {!scenario ? (
            <p className="text-sm text-muted-foreground">No exercise is running. The operational workspace above remains visible so you can see the views that will populate.</p>
          ) : visible.length === 0 ? (
            <p className="text-sm text-muted-foreground">No synthetic updates have arrived yet.</p>
          ) : (
            <div className="grid gap-3 lg:grid-cols-2">
              {visible.map((row) => (
                <article key={row.id} className="rounded-md border border-border p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs text-muted-foreground">{row.timeLabel.startsWith("T+") ? row.timeLabel : `${formatClock(row.atSeconds)} · ${row.timeLabel}`}</span>
                    <StatusPill tone="info">{row.source}</StatusPill>
                    <StatusPill tone={row.provenance === "controller_inject" ? "critical" : "info"}>{row.provenance.replaceAll("_", " ")}</StatusPill>
                    <StatusPill tone={confidenceTone[row.confidence]}>{row.confidence}</StatusPill>
                  </div>
                  <h3 className="mt-2 text-sm font-semibold text-foreground">{row.headline}</h3>
                  <p className="mt-1 text-xs uppercase tracking-wide text-muted-foreground">{row.domains.join(" · ")}</p>
                  <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{row.detail}</p>
                  {row.friction ? <p className="mt-2 rounded-md bg-muted px-2 py-1.5 text-xs text-muted-foreground">Friction: {row.friction}</p> : null}
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

      {state ? (
        <div className="mt-6 grid gap-4 lg:grid-cols-2">
          <SectionCard title="Known Operational State" description={state.airspaceStatus}>
            <p className="text-sm font-medium text-foreground">Command</p>
            <p className="mt-1 text-sm text-muted-foreground">{state.commandStatus}</p>
            <p className="mt-4 text-sm font-medium text-foreground">Hazards</p>
            <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
              {(state.hazards.length ? state.hazards : ["No additional hazard has been established from released facts."]).map((item) => <li key={item}>• {item}</li>)}
            </ul>
          </SectionCard>
          <SectionCard title="Authority Matrix" description="Only authority established by facts released at the current exercise time is shown.">
            {state.authorities.length ? (
              <div className="space-y-3">
                {state.authorities.map((item) => (
                  <div key={item.domain} className="rounded-md border border-border p-3">
                    <p className="text-sm font-semibold text-foreground">{item.domain}</p>
                    <p className="mt-1 text-sm text-muted-foreground">{item.owner} · {item.status}</p>
                  </div>
                ))}
              </div>
            ) : <p className="text-sm text-muted-foreground">No jurisdictional authority has yet been established by released exercise facts.</p>}
          </SectionCard>
        </div>
      ) : null}

      <div className="mt-6 rounded-md border border-border bg-muted/40 p-4 text-xs leading-relaxed text-muted-foreground">
        <strong className="text-foreground">Simulation boundary:</strong> timeline facts, controller injects, and AIRS inferences are exercise artifacts only. They do not create operational incidents, observations, evidence, credentials, connector authorization, or live data access.
      </div>
    </PageShell>
  );
}
