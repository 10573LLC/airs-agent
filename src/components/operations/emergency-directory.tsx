import {useState} from 'react';
import entries from '@/lib/directory/capital-region.json';
export function EmergencyDirectory(){
 const [county,setCounty]=useState('All'),[service,setService]=useState('All'),[search,setSearch]=useState('');
 const results=entries.filter(e=>(county==='All'||e.counties.includes(county))&&(service==='All'||e.service===service)&&`${e.name} ${e.address} ${e.notes}`.toLowerCase().includes(search.toLowerCase()));
 return <section className="space-y-4 rounded border p-4"><h2 className="text-xl font-semibold">Capital Region emergency-services directory</h2>
 <p className="text-sm">Albany, Schenectady and Rensselaer counties, New York. For an immediate emergency call 911. Listing an agency does not make it an Associate or Friend and grants no incident access.</p>
 <p className="rounded border border-amber-500 p-3 text-sm">Directory verification is in progress. Fire and police listings include dated state datasets; verify contacts before operational use. EMS coverage and the named local FAA LEAP representative are not yet complete. This is not a dispatch system.</p>
 <div className="flex flex-wrap gap-3"><label>County <select className="rounded border p-2" value={county} onChange={e=>setCounty(e.target.value)}>{['All','Albany','Schenectady','Rensselaer'].map(c=><option key={c}>{c}</option>)}</select></label><label>Service <select className="rounded border p-2" value={service} onChange={e=>setService(e.target.value)}>{['All',...new Set(entries.map(e=>e.service))].map(c=><option key={c}>{c}</option>)}</select></label><label>Search <input className="rounded border p-2" value={search} onChange={e=>setSearch(e.target.value)} placeholder="Agency or locality"/></label></div>
 <p role="status" className="text-sm">{results.length} entries · public contact information only</p>
 <div className="grid gap-3 lg:grid-cols-2">{results.map(e=><article key={e.id} className="rounded border p-3"><h3 className="font-semibold">{e.name}</h3><p className="text-sm">{e.service} · {e.counties.join(', ')}</p><p className="text-sm">{e.address}</p><p className="mt-2 text-sm">{e.contactType}: {e.phone||'Not verified; see official contact page'}</p><p className="text-xs">{e.verification} · source reviewed {e.checkedAt}</p><p className="mt-2 text-xs">{e.notes}</p><a className="text-sm underline" href={e.source} target="_blank" rel="noopener noreferrer">Official source / contact page</a></article>)}</div>
 </section>;
}
