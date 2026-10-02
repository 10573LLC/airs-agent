import {useState} from 'react';
import {useQuery,useMutation,useQueryClient} from '@tanstack/react-query';
import {useServerFn} from '@tanstack/react-start';
import {listTrustedAgenciesFn,setTrustedAgencyStatusFn,listFriendBriefingsFn,saveFriendProfileFn} from '@/lib/api/incidents.functions';
import {friendProfileFields,friendProfileSchema,type FriendProfile} from '@/lib/incidents/friend-profile';

export function AgencyRelationships({orgId,canManage,participantOrgIds}:{orgId:string;canManage:boolean;participantOrgIds?:string[]}) {
  const list=useServerFn(listTrustedAgenciesFn),brief=useServerFn(listFriendBriefingsFn),setTrust=useServerFn(setTrustedAgencyStatusFn),save=useServerFn(saveFriendProfileFn);
  const qc=useQueryClient();
  const own=useQuery({queryKey:['relationships',orgId],queryFn:()=>list({data:{orgId}}),enabled:canManage});
  const incoming=useQuery({queryKey:['friend-briefings',orgId],queryFn:()=>brief({data:{orgId}}),refetchInterval:15000});
  const [partner,setPartner]=useState(''),[level,setLevel]=useState<'associate'|'friend'>('associate'),[share,setShare]=useState(false),[until,setUntil]=useState('');
  const [profile,setProfile]=useState<FriendProfile>(friendProfileSchema.parse({}));
  const [message,setMessage]=useState('');
  const refresh=()=>{void qc.invalidateQueries({queryKey:['relationships',orgId]});void qc.invalidateQueries({queryKey:['friend-briefings',orgId]});void qc.invalidateQueries({queryKey:['trusted']});};
  const create=useMutation({mutationFn:()=>setTrust({data:{orgId,partnerOrgId:partner,status:'approved'}}),onSuccess:r=>{setMessage(r.ok?'Associate relationship saved.':'Could not save: '+r.code);refresh();},onError:()=>setMessage('Could not save relationship.')});
  const update=useMutation({mutationFn:()=>save({data:{orgId,partnerOrgId:partner,relationshipLevel:level,shareProfile:share,profile,validUntil:until?new Date(until+'T23:59:59Z').toISOString():null}}),onSuccess:r=>{setMessage(r.ok?'Saved. Friend sharing requires reciprocal approval and remains subject to the review date.':'Could not save: '+r.code);refresh();},onError:()=>setMessage('Could not save profile.')});
  const revoke=useMutation({mutationFn:(id:string)=>setTrust({data:{orgId,partnerOrgId:id,status:'revoked'}}),onSuccess:r=>{setMessage(r.ok?'Relationship revoked; Friend profile access removed.':'Could not revoke: '+r.code);refresh();}});
  const rows=incoming.data?.ok?incoming.data.data:[];
  const visible=participantOrgIds?rows.filter(r=>participantOrgIds.includes(r.partnerOrgId)):rows;
  return <section className="space-y-4 rounded border p-4">
    <h2 className="text-lg font-semibold">{participantOrgIds?'Established Friend briefings':'Associates and Friends'}</h2>
    <p className="text-sm">Associates are eligible for incident invitations. Friends confirm their relationship in both agencies and choose the operational profile they share before an incident. Incident access and feed activation remain separately controlled.</p>
    {incoming.isError||incoming.data?.ok===false?<p role="alert">Friend profiles could not be refreshed. Do not rely on previously displayed arrangements.</p>:visible.map(r=><article className="rounded border p-3" key={r.partnerOrgId}>
      <h3 className="font-semibold">{r.partnerOrgName} · {r.mutualFriend?'Friend':'Associate / awaiting reciprocal friendship'}</h3>
      <p className="text-sm">Profile: {r.profileState.replaceAll('_',' ')}{r.validUntil?` · review by ${new Date(r.validUntil).toLocaleDateString()}`:''}</p>
      {r.profileState==='shared'&&<>
        <p className="text-xs">Agency-confirmed {r.confirmedAt?new Date(r.confirmedAt).toLocaleString():''}. Verify incident availability before tasking.</p>
        <p className="mt-2 text-sm">Declared ecosystems: {r.systems.ecosystems.map(e=>`${e.vendorName} (${e.usageStatus.replaceAll('_',' ')})`).join(', ')||'Not declared'}</p>
        <p className="text-sm">Declared systems: {r.systems.components.map(c=>`${c.name} (${c.usageStatus.replaceAll('_',' ')})`).join(', ')||'Not declared'}</p>
        <dl className="mt-3 grid gap-3 md:grid-cols-2">{friendProfileFields.map(f=><div key={f.key}><dt className="text-sm font-semibold">{f.label}</dt><dd className="whitespace-pre-wrap text-sm">{r.profile[f.key]||'Unknown / not established'}</dd></div>)}</dl>
        <p className="mt-2 text-xs">These are standing agency declarations. No live feed, radio switching or telemetry connection is asserted by this profile.</p>
      </>}
    </article>)}
    {!incoming.isPending&&visible.length===0&&<p className="text-sm">No reciprocal Friend profiles available{participantOrgIds?' for these participants':''}.</p>}
    {canManage&&<details><summary className="cursor-pointer font-semibold">Manage pre-incident relationships and shared profile</summary>
      <p className="my-2 text-sm">Share only information approved for this agency. Catalog selections from Systems & Integrations are included when profile sharing is enabled. Never enter passwords, radio encryption keys or private video links.</p>
      <label className="block text-sm">Partner agency ID<input className="block w-full rounded border p-2" value={partner} onChange={e=>{setPartner(e.target.value);setShare(false);setLevel('associate');setUntil('');setProfile(friendProfileSchema.parse({}));}} /></label>
      <button className="my-2 rounded border p-2" disabled={!partner||create.isPending} onClick={()=>create.mutate()}>Create / approve Associate</button>
      <ul className="space-y-2">{(own.data?.ok?own.data.data:[]).map(r=><li className="flex flex-wrap gap-3 text-sm" key={r.id}><span>{r.partnerOrgName||r.partnerOrgId} · {r.status} · {r.relationshipLevel}</span><button className="underline" onClick={()=>{setPartner(r.partnerOrgId);setLevel(r.relationshipLevel);setShare(r.shareProfile);setProfile(friendProfileSchema.parse(r.friendProfile));setUntil(r.profileValidUntil?.slice(0,10)||'');}}>Edit profile for this agency</button><button className="underline" disabled={revoke.isPending} onClick={()=>revoke.mutate(r.partnerOrgId)}>Revoke relationship</button></li>)}</ul>
      <form className="mt-4 space-y-3" onSubmit={e=>{e.preventDefault();update.mutate();}}>
        <label className="block">Relationship level<select className="ml-3 rounded border p-2" value={level} onChange={e=>{setLevel(e.target.value as 'associate'|'friend');if(e.target.value==='associate')setShare(false);}}><option value="associate">Associate</option><option value="friend">Friend — requires reciprocal confirmation</option></select></label>
        {friendProfileFields.map(f=><label className="block text-sm" key={f.key}>{f.label}<textarea className="mt-1 block w-full rounded border p-2" maxLength={f.key==='coordinationContact'?1000:4000} value={profile[f.key]} onChange={e=>setProfile({...profile,[f.key]:e.target.value})}/><span className="text-xs text-muted-foreground">{f.hint}</span></label>)}
        <label className="block text-sm"><input type="checkbox" checked={share} disabled={level!=='friend'} onChange={e=>setShare(e.target.checked)}/> Share this profile and my agency's declared systems with this Friend once reciprocal approval is established.</label>
        <label className="block text-sm">Review / sharing expiry date<input className="ml-3 rounded border p-2" type="date" value={until} required={share} onChange={e=>setUntil(e.target.value)}/></label>
        <button className="rounded border px-4 py-2" disabled={!partner||update.isPending}>Confirm and save profile</button>
      </form>
    </details>}
    {message&&<p role="status">{message}</p>}
  </section>;
}
