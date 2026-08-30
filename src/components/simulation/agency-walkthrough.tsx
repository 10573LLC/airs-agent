import { useState } from "react";
import { StatusPill } from "@/components/brand";
import type { SimConfidence, SimSource } from "@/lib/simulation/model";
import type { SimAgencyInformationPath } from "@/lib/simulation/operational";
import {
  WALKTHROUGH_ROLE_LABELS,
  type SimWalkthroughEntry,
  type SimWalkthroughEntryKind,
  type SimWalkthroughRole,
} from "@/lib/simulation/walkthrough";

type QuickKind = Exclude<SimWalkthroughEntryKind, "resource_status">;
const inputClass = "w-full rounded-md border border-input bg-background px-2.5 py-2 text-sm text-foreground";
const labelClass = "block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground";
const kinds: { value: QuickKind; label: string }[] = [
  { value: "command_update", label: "Situation / command update" },
  { value: "observation", label: "Observation / field report" },
  { value: "resource_request", label: "Resource request" },
  { value: "coordination", label: "Coordination organization" },
  { value: "map_report", label: "COP position report" },
];
const observationSources: SimSource[] = ["911/CAD", "RTCC", "Law Enforcement", "EMS/Fire", "Airspace/C-UAS", "UAS", "LMR", "Emergency Management"];
const informationPaths: SimAgencyInformationPath[] = ["system_integration", "command_post_liaison", "dispatch", "radio", "phone", "email", "manual_entry", "mutual_aid_coordination", "other"];

function formatClock(seconds: number) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60).toString().padStart(2, "0");
  return `T+${hours}:${minutes}`;
}
export function AgencyWalkthrough({
  clockSeconds,
  entries,
  role,
  onRoleChange,
  onAdd,
  onClear,
  onClose,
}: {
  clockSeconds: number;
  entries: SimWalkthroughEntry[];
  role: SimWalkthroughRole;
  onRoleChange: (role: SimWalkthroughRole) => void;
  onAdd: (entry: SimWalkthroughEntry) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const [kind, setKind] = useState<QuickKind>("observation");
  const [title, setTitle] = useState("");
  const [detail, setDetail] = useState("");
  const [source, setSource] = useState<SimSource>("RTCC");
  const [confidence, setConfidence] = useState<SimConfidence>("reported");
  const [commandLead, setCommandLead] = useState("");
  const [priority, setPriority] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [requestedFrom, setRequestedFrom] = useState("");
  const [location, setLocation] = useState("");
  const [informationPath, setInformationPath] = useState<SimAgencyInformationPath>("command_post_liaison");
  const [latitude, setLatitude] = useState("");
  const [longitude, setLongitude] = useState("");
  const [error, setError] = useState<string | null>(null);
  const id = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const clearEntryFields = () => {
    setTitle(""); setDetail(""); setCommandLead(""); setPriority("");
    setQuantity("1"); setRequestedFrom(""); setLocation(""); setLatitude(""); setLongitude("");
  };

  const submit = () => {
    setError(null);
    const base = { id: id(), atSeconds: clockSeconds, role };
    let entry: SimWalkthroughEntry | null = null;
    if (kind === "command_update") {
      if (!detail.trim()) return setError("Enter the current situation before submitting.");
      entry = { ...base, kind, situation: detail.trim(), commandLead: commandLead.trim() || undefined, priority: priority.trim() || undefined };
    } else if (kind === "observation") {
      if (!title.trim() || !detail.trim()) return setError("Enter both a report title and report details.");
      entry = { ...base, kind, source, title: title.trim(), detail: detail.trim(), confidence };
    } else if (kind === "resource_request") {
      const parsedQuantity = Math.max(1, Math.min(999, Number(quantity) || 1));
      if (!title.trim()) return setError("Enter the resource or capability being requested.");
      entry = { ...base, kind, resourceName: title.trim(), quantity: parsedQuantity, requestedFrom: requestedFrom.trim(), location: location.trim() || undefined };
    } else if (kind === "coordination") {
      if (!title.trim()) return setError("Enter the organization name.");
      entry = { ...base, kind, organizationName: title.trim(), operationalRole: detail.trim(), informationPath };
    } else {
      const lat = Number(latitude); const lng = Number(longitude);
      if (!title.trim() || !Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return setError("Enter a label and valid latitude/longitude for the exercise report.");
      entry = { ...base, kind, label: title.trim(), detail: detail.trim(), latitude: lat, longitude: lng };
    }
    onAdd(entry);
    clearEntryFields();
  };
  return (
    <section className="flex min-h-0 flex-col overflow-hidden rounded-md border border-primary/30 bg-card shadow-panel">
      <div className="border-b border-border bg-primary/5 px-3 py-2.5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-2"><StatusPill tone="caution">AGENCY WALKTHROUGH</StatusPill><span className="font-mono text-xs font-semibold">{formatClock(clockSeconds)}</span></div>
            <p className="mt-1 text-sm font-semibold text-foreground">Simulated agency input console</p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">Exercise-only entry. No real agency authorization, records, connectors, or evidence are touched.</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-md border border-border px-2 py-1 text-xs font-semibold">Close</button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
          <label className={labelClass}>Agency role
            <select value={role} onChange={(e) => onRoleChange(e.target.value as SimWalkthroughRole)} className={`${inputClass} mt-1`}>
              {Object.entries(WALKTHROUGH_ROLE_LABELS).map(([value, text]) => <option key={value} value={value}>{text}</option>)}
            </select>
          </label>
          <label className={labelClass}>Input workflow
            <select value={kind} onChange={(e) => { setKind(e.target.value as QuickKind); setError(null); }} className={`${inputClass} mt-1`}>
              {kinds.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
            </select>
          </label>
        </div>
        <div className="mt-4 space-y-3">
          {kind === "command_update" ? <>
            <label className={labelClass}>Current situation<textarea rows={4} value={detail} onChange={(e) => setDetail(e.target.value)} className={`${inputClass} mt-1`} placeholder="What does your agency know right now?" /></label>
            <label className={labelClass}>Command lead / structure<input value={commandLead} onChange={(e) => setCommandLead(e.target.value)} className={`${inputClass} mt-1`} placeholder="Optional" /></label>
            <label className={labelClass}>Current priority<input value={priority} onChange={(e) => setPriority(e.target.value)} className={`${inputClass} mt-1`} placeholder="Optional" /></label>
          </> : null}

          {kind === "observation" ? <>
            <label className={labelClass}>Report source<select value={source} onChange={(e) => setSource(e.target.value as SimSource)} className={`${inputClass} mt-1`}>{observationSources.map((item) => <option key={item}>{item}</option>)}</select></label>
            <label className={labelClass}>Report title<input value={title} onChange={(e) => setTitle(e.target.value)} className={`${inputClass} mt-1`} placeholder="Short operational headline" /></label>
            <label className={labelClass}>Report details<textarea rows={4} value={detail} onChange={(e) => setDetail(e.target.value)} className={`${inputClass} mt-1`} placeholder="What was observed or reported?" /></label>
            <label className={labelClass}>Confidence<select value={confidence} onChange={(e) => setConfidence(e.target.value as SimConfidence)} className={`${inputClass} mt-1`}>{["confirmed","reported","unverified","conflicting"].map((item) => <option key={item}>{item}</option>)}</select></label>
          </> : null}

          {kind === "resource_request" ? <>
            <label className={labelClass}>Resource / capability<input value={title} onChange={(e) => setTitle(e.target.value)} className={`${inputClass} mt-1`} placeholder="Bomb team, UAS, ambulance, aviation..." /></label>
            <div className="grid grid-cols-[6rem_1fr] gap-2"><label className={labelClass}>Quantity<input type="number" min="1" max="999" value={quantity} onChange={(e) => setQuantity(e.target.value)} className={`${inputClass} mt-1`} /></label><label className={labelClass}>Requested from<input value={requestedFrom} onChange={(e) => setRequestedFrom(e.target.value)} className={`${inputClass} mt-1`} placeholder="Agency or any available" /></label></div>
            <label className={labelClass}>Staging / location<input value={location} onChange={(e) => setLocation(e.target.value)} className={`${inputClass} mt-1`} placeholder="Optional; unknown remains unknown" /></label>
          </> : null}
          {kind === "coordination" ? <>
            <label className={labelClass}>Organization<input value={title} onChange={(e) => setTitle(e.target.value)} className={`${inputClass} mt-1`} placeholder="Organization name" /></label>
            <label className={labelClass}>Operational role<textarea rows={3} value={detail} onChange={(e) => setDetail(e.target.value)} className={`${inputClass} mt-1`} placeholder="What role does this organization have in the operation?" /></label>
            <label className={labelClass}>Information path<select value={informationPath} onChange={(e) => setInformationPath(e.target.value as SimAgencyInformationPath)} className={`${inputClass} mt-1`}>{informationPaths.map((item) => <option key={item} value={item}>{item.replaceAll("_", " ")}</option>)}</select></label>
          </> : null}

          {kind === "map_report" ? <>
            <label className={labelClass}>COP label<input value={title} onChange={(e) => setTitle(e.target.value)} className={`${inputClass} mt-1`} placeholder="Reported UAS, staging, hazard..." /></label>
            <label className={labelClass}>Report detail<textarea rows={3} value={detail} onChange={(e) => setDetail(e.target.value)} className={`${inputClass} mt-1`} placeholder="What does this position represent?" /></label>
            <div className="grid grid-cols-2 gap-2"><label className={labelClass}>Latitude<input inputMode="decimal" value={latitude} onChange={(e) => setLatitude(e.target.value)} className={`${inputClass} mt-1`} placeholder="42.65" /></label><label className={labelClass}>Longitude<input inputMode="decimal" value={longitude} onChange={(e) => setLongitude(e.target.value)} className={`${inputClass} mt-1`} placeholder="-73.75" /></label></div>
          </> : null}
        </div>

        {error ? <p className="mt-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">{error}</p> : null}
        <button type="button" onClick={submit} className="mt-4 w-full rounded-md bg-primary px-3 py-2.5 text-sm font-semibold text-primary-foreground">Submit agency entry</button>
        <div className="mt-5 border-t border-border pt-3">
          <div className="flex items-center justify-between gap-2"><p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Agency entry history</p>{entries.length ? <button type="button" onClick={onClear} className="text-xs font-semibold text-destructive underline">Clear exercise entries</button> : null}</div>
          <div className="mt-2 space-y-2">
            {entries.slice(-6).reverse().map((entry) => <div key={entry.id} className="rounded-md border border-border p-2 text-xs"><div className="flex flex-wrap items-center gap-2"><span className="font-mono text-muted-foreground">{formatClock(entry.atSeconds)}</span><StatusPill tone="info">{WALKTHROUGH_ROLE_LABELS[entry.role]}</StatusPill></div><p className="mt-1 font-semibold text-foreground">{entry.kind === "resource_status" ? "Resource readiness update" : kinds.find((item) => item.value === entry.kind)?.label}</p></div>)}
            {!entries.length ? <p className="text-xs text-muted-foreground">Nothing has been entered by the simulated agency user yet.</p> : null}
          </div>
        </div>
      </div>
    </section>
  );
}
