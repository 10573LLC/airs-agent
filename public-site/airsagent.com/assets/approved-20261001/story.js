const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const scenes = [
 ['Drone operations','Bring authorized aircraft observations into the same picture as responders, people, and hazards.','Illustration of a drone operator supporting search and rescue'],
 ['Crewed aviation','Bring helicopter and crewed-aircraft operations into the incident conversation.','Illustration of a rescue helicopter over forested terrain'],
 ['Incident coordination','Keep participating agencies aligned around a shared incident workspace.','Illustration of incident coordinators at a field command station']
];
let scene=0, scenePlaying=!reduced;
const image=document.querySelector('.scene-image');
function showScene(n){scene=n;image.animate([{opacity:.35},{opacity:1}],{duration:reduced?0:650});image.style.backgroundPosition=`${n*50}% 50%`;image.setAttribute('aria-label',scenes[n][2]);document.querySelector('#scene-count').textContent=`0${n+1} / 03`;document.querySelector('#scene-title').textContent=scenes[n][0];document.querySelector('#scene-description').textContent=scenes[n][1];document.querySelectorAll('[data-scene]').forEach((b,i)=>{b.classList.toggle('active',i===n);b.setAttribute('aria-pressed',i===n)});}
function setScenePlaying(v){scenePlaying=v;const b=document.querySelector('#scene-toggle');b.textContent=v?'Pause':'Play';b.setAttribute('aria-label',v?'Pause image sequence':'Play image sequence')}
document.querySelectorAll('[data-scene]').forEach(b=>b.addEventListener('click',()=>{setScenePlaying(false);showScene(Number(b.dataset.scene))}));
document.querySelector('#scene-toggle').addEventListener('click',()=>setScenePlaying(!scenePlaying));
setScenePlaying(scenePlaying);
setInterval(()=>{if(scenePlaying&&!document.hidden)showScene((scene+1)%3)},6000);
const screens=[document.querySelector('#demo-screen').innerHTML,
 `<p class="mini-eyebrow">ENTITY COORDINATION</p><h3>Activate. Invite. Coordinate.</h3><div class="partner-list"><div><strong>Originating agency</strong><span>Incident owner</span></div><div><strong>Incident-only Associate</strong><span>Invitation accepted</span></div><div><strong>Standing Partner</strong><span>Approved incident access</span></div></div><div class="illustrated-action">One Common Operating Picture</div><p class="demo-explanation">Invited agencies participate with explicit access. Coordinate operations within the active incident.</p>`,
 `<p class="mini-eyebrow">INCIDENT LIFECYCLE</p><h3>Close the room. End sharing.</h3><div class="mock-field"><span>Closure reason</span><strong>Search operation concluded</strong></div><div class="closure-summary"><p>Incident sharing ended</p><p>Pending invitations expired</p><p>Incident state: closed</p></div><p class="demo-explanation">Closeout ends incident sharing. External source revocation remains pending until confirmed.</p>`];
let elapsed=0,playing=false,chapter=-1;
function render(){const c=Math.min(2,Math.floor(elapsed/6));if(c!==chapter){chapter=c;const s=document.querySelector('#demo-screen');s.innerHTML=screens[c];s.style.animation='none';requestAnimationFrame(()=>s.style.animation='');document.querySelector('#room-state').textContent=['DRAFT','ACTIVE','CLOSED'][c];document.querySelectorAll('[data-step-label]').forEach((e,i)=>e.classList.toggle('current',i===c));document.querySelectorAll('[data-chapter]').forEach((e,i)=>e.setAttribute('aria-pressed',i===c))}document.querySelector('#demo-time').textContent=`00:${String(Math.floor(elapsed)).padStart(2,'0')} / 00:18`;document.querySelector('#progress-fill').style.width=`${elapsed/18*100}%`;document.querySelector('#demo-play').textContent=playing?'Pause walkthrough':elapsed>=18?'Replay walkthrough':'Play walkthrough';}
document.querySelector('#demo-play').addEventListener('click',()=>{if(elapsed>=18)elapsed=0;playing=!playing;render()});
document.querySelectorAll('[data-chapter]').forEach(b=>b.addEventListener('click',()=>{elapsed=Number(b.dataset.chapter)*6;playing=false;render()}));
setInterval(()=>{if(playing&&!document.hidden){elapsed=Math.min(18,elapsed+.1);if(elapsed>=18)playing=false;render()}},100);
render();
