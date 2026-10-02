import { afterEach, describe, expect, it, vi } from "vitest";
import { planExercise, validatePlan } from "@/lib/exercise-agents/planner.server";
import { EXERCISE_AGENCIES } from "@/lib/exercise-agents/model";
const plan = { units: 1, response: "One simulated crew committed", assumptions: ["Fictional Albany staging"], unmetNeeds: ["Receiving contact required"], staging: {label:"Simulated staging",latitude:42.65,longitude:-73.75}, updates:[{afterSeconds:30,message:"Simulated crew checking in"}] };
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();});
describe("intelligent exercise plans",()=>{
  it("rejects fabricated inventory, unsafe coordinates and non-advancing timelines",()=>{
    expect(()=>validatePlan({...plan,units:3},2)).toThrow();
    expect(()=>validatePlan({...plan,staging:{...plan.staging,latitude:100}},2)).toThrow();
    expect(()=>validatePlan({...plan,updates:[...plan.updates,{afterSeconds:15,message:"Backwards"}]},2)).toThrow();
    expect(()=>validatePlan({...plan,units:0},2)).toThrow();
    expect(()=>validatePlan({...plan,executeCommand:"anything"},2)).toThrow();
  });
  it("uses structured model output, no storage and finite inventory",async()=>{
    vi.stubEnv("EXERCISE_INTELLIGENCE","openai");vi.stubEnv("EXERCISE_OPENAI_API_KEY","test-only");
    const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify({status:"completed",output:[{content:[{type:"output_text",text:JSON.stringify(plan)}]}]}),{status:200}));
    vi.stubGlobal("fetch",fetcher);
    const result=await planExercise("unit-success",{agency:EXERCISE_AGENCIES[1],incidentName:"Fictional",description:"Exercise aid",stagingLocation:"",maxUnits:1,requestedUnits:1,observations:[]});
    expect(result).toEqual(plan);
    const body=JSON.parse(fetcher.mock.calls[0][1].body);
    expect(body.store).toBe(false);expect(body.text.format.strict).toBe(true);
    expect(body.instructions).toContain("untrusted scenario data");
  });
  it("does not silently claim success on model failure and backs off retries",async()=>{
    vi.stubEnv("EXERCISE_INTELLIGENCE","openai");vi.stubEnv("EXERCISE_OPENAI_API_KEY","test-only");
    const fetcher=vi.fn().mockResolvedValue(new Response("",{status:429}));vi.stubGlobal("fetch",fetcher);
    const context={agency:EXERCISE_AGENCIES[1],incidentName:"Fictional",description:"Exercise aid",stagingLocation:"",maxUnits:1,requestedUnits:1,observations:[]};
    await expect(planExercise("unit-failure",context)).rejects.toThrow("HTTP 429");
    await expect(planExercise("unit-failure",context)).rejects.toThrow("retry pending");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
