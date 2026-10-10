// /demo: live view of the agent-to-agent protocol. Agents' columns show what each one sent; the
// coordinator's column shows what it asked. Private data never appears because it never crosses.
import { esc, page } from "./html.ts";

export function demoPage(token: string, demo: boolean): string {
  const body = `
<h1>Foodie agents</h1>
<p class="sub">Every message between personal agents and the coordinator, live. ${demo ? "" : "Values are hidden outside demo mode."}</p>
<div id="cols" class="cols"></div>
<style>
.cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px;align-items:start}
.col{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:14px;min-height:200px}
.col h2{font-size:16px;margin:0 0 2px}.col .keeps{color:var(--muted);font-size:12px;margin:0 0 10px}
.msg{border:1px solid var(--line);border-radius:12px;padding:10px;margin:0 0 8px;font-size:13px;animation:in .3s ease}
.msg .t{font-weight:700}.msg .to{color:var(--muted);font-size:12px}.msg .kv{margin-top:6px;display:grid;grid-template-columns:auto 1fr;gap:2px 8px}
.msg .k{color:var(--muted)}.msg table{width:100%;border-collapse:collapse;margin-top:6px;font-size:12px}.msg td{padding:2px 4px;border-top:1px solid var(--line)}
.veto{color:var(--accent);font-weight:700}.coord{border-color:var(--accent)}
@keyframes in{from{opacity:0;transform:translateY(-4px)}to{opacity:1}}
</style>`;
  const script = `
const token=${JSON.stringify(token)};
const cols=document.getElementById('cols');
const names={};const placeNames={};
const columns={};
function col(id,title,keeps,coord){
  if(columns[id])return columns[id];
  const el=document.createElement('section');el.className='col'+(coord?' coord':'');
  el.innerHTML='<h2></h2><p class="keeps"></p><div class="list"></div>';
  el.querySelector('h2').textContent=title;el.querySelector('.keeps').textContent=keeps;
  if(coord)cols.prepend(el);else cols.append(el);
  columns[id]=el.querySelector('.list');return columns[id];
}
const who=a=>a.startsWith('agent:')?(names[a.slice(6)]||'agent')+"'s agent":'coordinator';
const time=iso=>{try{return new Date(iso).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'})}catch{return iso}};
function kv(pairs){return '<div class="kv">'+pairs.map(([k,v])=>'<span class="k">'+k+'</span><span>'+v+'</span>').join('')+'</div>'}
const e=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function render(m){
  const p=m.payload||{};let html='<div class="t">'+e(m.type)+'</div><div class="to">→ '+e(who(m.to))+' · '+e(time(m.at))+'</div>';
  if(m.type==='ConstraintRequest'&&p.window)html+=kv([['window',e(time(p.window.earliest))+'–'+e(time(p.window.latest))]]);
  if(m.type==='Constraints'||m.type==='ConstraintsUpdate')html+=kv([['free at',e(time(p.freeAt))],['max price',e(typeof p.maxPrice==='number'?'$'+p.maxPrice:p.maxPrice)],['diet tags',e((p.dietTags||[]).join(', ')||'none')],['area (~2 km)',p.area?e(p.area.lat+', '+p.area.lng):'']]);
  if(m.type==='Proposal'){(p.meetCandidates||[]).forEach(c=>placeNames[c.placeId]=c.name);html+='<table>'+(p.meetCandidates||[]).map(c=>'<tr><td>'+e(c.name)+'</td><td>'+e(c.cuisine)+'</td><td>$'+e(c.priceEach)+'</td></tr>').join('')+'</table>'}
  if(m.type==='Evaluation')html+='<table>'+(p.perCandidate||[]).map(c=>'<tr><td>'+e(placeNames[c.placeId]||c.placeId)+'</td><td>'+e(c.travelMin)+' min '+e(c.mode)+'</td><td>fit '+e(c.fit)+'</td><td class="veto">'+(c.veto===true?'veto':'')+'</td></tr>').join('')+'</table>';
  const div=document.createElement('div');div.className='msg';div.innerHTML=html;return div;
}
function add(m){
  const from=m.from;
  const list=from.startsWith('agent:')?col(from,who(from),'Keeps private: exact location, calendar, spending, diet details, veto reasons'):col('coordinator','Coordinator','Sees only what agents send it',true);
  list.prepend(render(m));
}
fetch('/demo/state?token='+encodeURIComponent(token)).then(r=>r.json()).then(s=>{
  s.people.forEach(p=>names[p.id]=p.name||'Someone');
  col('coordinator','Coordinator','Sees only what agents send it',true);
  s.people.filter(p=>p.demoKey).forEach(p=>col('agent:'+p.id,(p.name||'Someone')+"'s agent",'Keeps private: exact location, calendar, spending, diet details, veto reasons'));
  s.events.forEach(add);
  const es=new EventSource('/demo/stream?token='+encodeURIComponent(token));
  es.addEventListener('agent_message',ev=>{const m=JSON.parse(ev.data);if(m.from.startsWith('agent:')&&!names[m.from.slice(6)])fetch('/demo/state?token='+encodeURIComponent(token)).then(r=>r.json()).then(s=>{s.people.forEach(p=>names[p.id]=p.name||'Someone');add(m)});else add(m)});
});`;
  return page("Foodie agents", body, { wide: true, script });
}

export { esc };
