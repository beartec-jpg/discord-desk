export const dashboardHtml = `<!doctype html><html><head><meta charset="utf-8"><title>Discord Desk</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{font-family:system-ui,sans-serif;background:#0f172a;color:#e2e8f0;margin:0;padding:20px;max-width:1100px;margin:auto}
h1{font-size:20px}button,select{background:#1e293b;color:#e2e8f0;border:1px solid #334155;padding:6px 12px;border-radius:6px;cursor:pointer}
.run{border:1px solid #334155;border-radius:8px;margin:10px 0;padding:10px;background:#111827}
.ok{color:#4ade80}.bad{color:#f87171}.emb{border-left:4px solid #a855f7;padding:4px 10px;margin:8px 0;background:#1e293b;white-space:pre-wrap}
small{color:#94a3b8}table{border-collapse:collapse;width:100%}td,th{border:1px solid #334155;padding:4px 6px;font-size:13px}
summary{cursor:pointer}
</style></head><body>
<h1>📡 Discord Desk</h1><div id="info"><small>loading…</small></div>
<p><select id="sym"><option>BTCUSDT</option><option>XRPUSDT</option></select>
<select id="mode"><option value="dry">dry run (no post, no tracking)</option><option value="nopost">track only (register in tracker, no Discord post)</option><option value="live">live (post to Discord + track)</option></select>
<button onclick="runNow()">Run now</button> <span id="st"></span></p>
<p><small>Not financial advice. Output is AI-generated ideas for education only.</small></p>
<h2 style="font-size:16px">📒 Trade tracker</h2><div id="trk"><small>loading…</small></div>
<h2 style="font-size:16px">Runs</h2><div id="runs"></div>
<script>
const qs=new URLSearchParams(location.search);const tok=qs.get('token');
const H=tok?{'x-dashboard-token':tok,'Content-Type':'application/json'}:{'Content-Type':'application/json'};
const esc=s=>String(s??'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
async function info(){const i=await (await fetch('/api/info',{headers:H})).json();
document.getElementById('info').innerHTML='<small>model: '+esc(i.model)+(i.mock?' <b>(MOCK MODE)</b>':'')+' · cache: '+esc(i.cache)+' · schedules: '+esc(JSON.stringify(i.schedules))+' · webhooks: '+esc(i.webhooks)+' · tracker: '+esc(i.tracker)+'</small>';}
function setups(s){if(!s||!s.length)return '<small>no setups</small>';return '<table><tr><th>Dir</th><th>Grade</th><th>Entry</th><th>Stop</th><th>Targets</th><th>R:R</th><th>Confluence</th></tr>'+s.map(t=>'<tr><td>'+esc(t.direction)+'</td><td>'+esc(t.grade)+'</td><td>'+esc(t.entry)+'</td><td>'+esc(t.stopLoss)+'</td><td>'+esc((t.targets||[]).join(', '))+'</td><td>'+esc(t.riskRewardRatio)+'</td><td>'+esc((t.confluenceSignals||[]).join(', '))+'</td></tr>').join('')+'</table>';}
function embeds(p){if(!p)return '';return '<div class="emb">'+esc(p.content)+'</div>'+(p.embeds||[]).map(e=>'<div class="emb" style="border-color:#'+(e.color||0x64748b).toString(16).padStart(6,'0')+'"><b>'+esc(e.title)+'</b>\\n'+esc(e.description)+(e.fields||[]).map(f=>'\\n\\n<b>'+esc(f.name)+'</b>\\n'+esc(f.value)).join('')+'</div>').join('');}
async function load(){const {runs}=await (await fetch('/api/runs',{headers:H})).json();
document.getElementById('runs').innerHTML=runs.length?runs.map(r=>{const res=r.result||{};return '<div class="run"><b class="'+(res.success?'ok':'bad')+'">'+(res.success?'OK':'FAILED')+'</b> '+esc((res.symbols||[]).join(','))+' <small>'+esc(res.startedAt)+' · '+esc(r.trigger)+(r.dryRun?' · dry run':'')+'</small>'+(res.error?'<div class="bad">'+esc(res.error)+'</div>':'')+(res.results||[]).map(x=>'<h3>'+esc(x.symbol)+' '+(x.error?'<span class="bad">'+esc(x.error)+'</span>':'')+'</h3>'+setups(x.setups)+'<details><summary>Discord payload</summary>'+embeds(x.payload)+'</details>').join('')+'</div>'}).join(''):'<small>No runs yet. Click "Run now".</small>';}
async function runNow(){const st=document.getElementById('st');st.textContent='running… (can take a few minutes)';
const r=await fetch('/api/run',{method:'POST',headers:H,body:JSON.stringify({symbol:document.getElementById('sym').value,dryRun:document.getElementById('mode').value==='dry',noPost:document.getElementById('mode').value==='nopost'})});
st.textContent=r.ok?'done':'error '+r.status;load();trk();}
async function trk(){const el=document.getElementById('trk');try{
const t=await fetch('/api/trades?limit=30',{headers:H});if(!t.ok){el.innerHTML='<small>tracker not bundled here (TRACKER_URL external or off)</small>';return;}
const {trades}=await t.json();const p=await (await fetch('/api/performance',{headers:H})).json();const a=p.allTime||{};
el.innerHTML='<small>closed: '+esc(a.totalTrades??0)+' · win rate: '+esc(a.winRate!=null?(a.winRate*100).toFixed(0)+'%':'—')+' · net R: '+esc(a.netR!=null?Number(a.netR).toFixed(2):'—')+' · PF: '+esc(a.profitFactor??'—')+'</small>'+
(trades.length?'<table><tr><th>Created</th><th>Symbol</th><th>Dir</th><th>Status</th><th>Entry</th><th>Stop</th><th>Targets</th><th>R</th><th>Outcome</th></tr>'+trades.map(x=>'<tr><td>'+esc(String(x.created_at).slice(0,16))+'</td><td>'+esc(x.symbol)+'</td><td>'+esc(x.direction)+'</td><td>'+esc(x.status)+'</td><td>'+esc(Number(x.entry))+'</td><td>'+esc(Number(x.current_stop))+'</td><td>'+esc((x.targets||[]).map(Number).join(', '))+'</td><td>'+esc(Number(x.realized_r||0).toFixed(2))+'</td><td>'+esc(x.outcome||'')+'</td></tr>').join('')+'</table>':'<small>no tracked trades yet</small>');
}catch(e){el.innerHTML='<small>tracker unavailable</small>'}}
info();load();trk();setInterval(trk,30000);
</script></body></html>`;
