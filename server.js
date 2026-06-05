/**
 * Claude Code Monitor v3 — Real-time session & token tracking
 */
'use strict';
const http=require('http'),fs=require('fs'),path=require('path'),{execSync}=require('child_process');
const {WebSocketServer}=require('ws');
const os=require('os');

const HOME=process.env.HOME||process.env.USERPROFILE||'.';
const CLAUDE=path.join(HOME,'.claude');
const SESS=path.join(CLAUDE,'sessions');
const PROJ=path.join(CLAUDE,'projects');
const PORT=9876;

// ════════════════════════════════════════════════════════════
//  PowerShell (safe via temp file)
// ════════════════════════════════════════════════════════════
function psOut(script,tag){
  const f=path.join(__dirname,`.p${tag}.ps1`);
  try{fs.writeFileSync(f,script,'utf8');
    const o=execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${f}"`,{encoding:'utf8',timeout:8000,windowsHide:true}).trim();
    try{fs.unlinkSync(f)}catch{};return o;
  }catch{try{fs.unlinkSync(f)}catch{};return''}
}

// ════════════════════════════════════════════════════════════
//  Processes
// ════════════════════════════════════════════════════════════
function getProcs(){
  const o=psOut(`
$p=Get-Process -Name 'claude' -ErrorAction SilentlyContinue
if(!$p){'[]'}else{
 $p|%{[PSCustomObject]@{Id=$_.Id;CPU=[math]::Round($_.CPU,1);
  Mem=[math]::Round($_.WorkingSet64/1MB,1);
  Start=$_.StartTime.ToString('HH:mm:ss');
  UpM=[math]::Round(((Get-Date)-$_.StartTime).TotalMinutes,1);
  Threads=$_.Threads.Count}}|ConvertTo-Json -Compress}
`,'proc');
  if(!o||o==='[]')return[];
  try{const d=JSON.parse(o);return Array.isArray(d)?d:[d]}
  catch{try{return JSON.parse('['+o.replace(/\}\{/g,'},{')+']')}catch{return[]}}
}

// ════════════════════════════════════════════════════════════
//  Sessions
// ════════════════════════════════════════════════════════════
function getSessions(){
  if(!fs.existsSync(SESS))return[];
  const now=Date.now(),procs=getProcs();
  return fs.readdirSync(SESS).filter(f=>f.endsWith('.json')).map(f=>{
    try{const d=JSON.parse(fs.readFileSync(path.join(SESS,f),'utf8'));
      const age=Math.round((now-d.startedAt)/60000);
      return{pid:d.pid,sid:(d.sessionId||'').substring(0,12),ver:d.version||'?',
        kind:d.kind||'?',entry:d.entrypoint||'?',cwd:d.cwd||'?',
        age,active:procs.some(p=>p.Id===d.pid),
        start:new Date(d.startedAt).toISOString()};
    }catch{return null}}).filter(Boolean).sort((a,b)=>b.start.localeCompare(a.start));
}

// ════════════════════════════════════════════════════════════
//  Token tracking from JSONL (real-time)
// ════════════════════════════════════════════════════════════
let tokenState={}; // sessionId -> cumulative token counts
let fileLines={};  // file path -> last known line count

function scanJSONL(){
  if(!fs.existsSync(PROJ))return;
  const dirs=fs.readdirSync(PROJ,{withFileTypes:true});
  for(const e of dirs){
    if(!e.isDirectory())continue;
    const dp=path.join(PROJ,e.name);
    try{
      fs.readdirSync(dp).filter(f=>f.endsWith('.jsonl')).forEach(f=>{
        const fp=path.join(dp,f);
        try{
          const st=fs.statSync(fp);
          const raw=fs.readFileSync(fp,'utf8');
          const lines=raw.split('\n').filter(Boolean);
          const prevCount=fileLines[fp]||0;
          if(prevCount===lines.length&&st.mtimeMs<=Date.now()-2000)return; // no change
          fileLines[fp]=lines.length;

          // Find session ID anywhere in file
          let sid=null;
          for(let i=lines.length-1;i>=0;i--){
            try{const d=JSON.parse(lines[i]);if(d.sessionId){sid=d.sessionId;break}}catch{}
          }
          if(!sid)return;
          if(!tokenState[sid])tokenState[sid]={input:0,output:0,cacheW:0,cacheR:0,models:{},lastUpdate:0};
          const ts=tokenState[sid];

          // Parse only NEW lines (first time: all)
          const newLines=prevCount===0?lines:lines.slice(prevCount);
          for(const line of newLines){
            try{
              const d=JSON.parse(line);
              const u=d.message?.usage||d.usage;
              if(!u||!u.input_tokens)continue;
              ts.input+=u.input_tokens||0;
              ts.output+=u.output_tokens||0;
              ts.cacheW+=u.cache_creation_input_tokens||0;
              ts.cacheR+=u.cache_read_input_tokens||0;
              const m=d.message?.model||d.model||'unknown';
              if(!ts.models[m])ts.models[m]={input:0,output:0,cacheW:0,cacheR:0};
              ts.models[m].input+=u.input_tokens||0;
              ts.models[m].output+=u.output_tokens||0;
              ts.models[m].cacheW+=u.cache_creation_input_tokens||0;
              ts.models[m].cacheR+=u.cache_read_input_tokens||0;
            }catch{}
          }
          ts.lastUpdate=Date.now();
        }catch{}
      });
    }catch{}
  }
}

// ════════════════════════════════════════════════════════════
//  Collect
// ════════════════════════════════════════════════════════════
function collect(){
  const procs=getProcs();
  const sess=getSessions();
  scanJSONL();

  // Attach token data to sessions
  sess.forEach(s=>{
    const key=Object.keys(tokenState).find(k=>k.startsWith(s.sid.replace('…','')));
    if(key){s.tokens=tokenState[key]}
  });

  // System: CPU, memory, disk
  const tmem=os.totalmem(),fmem=os.freemem();
  const cpus=os.cpus();
  const cpuSpeed=cpus.reduce((s,c)=>s+c.speed,0)/cpus.length;
  const cpuModel=cpus[0]?.model||'';
  // Disk info via PowerShell wrapper script
  let disk={used:0,total:0,pct:0};
  try{
    const ds=path.join(__dirname,'.disk.ps1');
    fs.writeFileSync(ds,`
$d = Get-PSDrive C
$used = [math]::Round(($d.Used/1GB),1)
$total = [math]::Round((($d.Used+$d.Free)/1GB),1)
$pct = [math]::Round($d.Used/($d.Used+$d.Free)*100,1)
@{used=$used;total=$total;pct=$pct} | ConvertTo-Json -Compress
`.trim(),'utf8');
    const o=execSync('powershell -NoProfile -ExecutionPolicy Bypass -File "'+ds+'"',{encoding:'utf8',timeout:5000,windowsHide:true}).trim();
    try{disk=JSON.parse(o)}catch{};try{fs.unlinkSync(ds)}catch{}
  }catch(e){try{fs.unlinkSync(path.join(__dirname,'.disk.ps1'))}catch{}}
  // GPU info via PowerShell wrapper script
  let gpu={name:'',vram:0};
  try{
    const gs=path.join(__dirname,'.gpu.ps1');
    fs.writeFileSync(gs,`
$g = Get-CimInstance Win32_VideoController | Where-Object { $_.Name -notmatch "Remote" } | Select-Object -First 1
@{name=$g.Name;vram=[math]::Round($g.AdapterRAM/1GB,1)} | ConvertTo-Json -Compress
`.trim(),'utf8');
    const o=execSync('powershell -NoProfile -ExecutionPolicy Bypass -File "'+gs+'"',{encoding:'utf8',timeout:5000,windowsHide:true}).trim();
    try{gpu=JSON.parse(o)}catch{};try{fs.unlinkSync(gs)}catch{}
  }catch(e){try{fs.unlinkSync(path.join(__dirname,'.gpu.ps1'))}catch{}}
  const sys={memUsed:+((1-fmem/tmem)*100).toFixed(1),memTotal:+(tmem/1e9).toFixed(1),memFree:+(fmem/1e9).toFixed(1),
    cpuModel:cpuModel.replace(/\s+/g,' ').substring(0,50),cpuSpeed,disk,gpu,platform:process.platform};

  // Global totals
  const totals={input:0,output:0,cacheW:0,cacheR:0};
  Object.values(tokenState).forEach(t=>{totals.input+=t.input;totals.output+=t.output;totals.cacheW+=t.cacheW;totals.cacheR+=t.cacheR});

  return {procs,sess,tokens:totals,sys,ts:Date.now()};
}

// ════════════════════════════════════════════════════════════
//  HTTP + WebSocket
// ════════════════════════════════════════════════════════════
const MIME={'.html':'text/html; charset=utf-8','.css':'text/css','.js':'application/javascript','.json':'application/json'};
const server=http.createServer((req,res)=>{
  const url=new URL(req.url,`http://localhost:${PORT}`);
  const js=o=>{res.writeHead(200,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});res.end(JSON.stringify(o))};
  if(url.pathname==='/api/state')return js(collect());
  let fp=url.pathname==='/'?'/index.html':url.pathname;fp=path.join(__dirname,fp);
  if(fs.existsSync(fp)&&fs.statSync(fp).isFile()){res.writeHead(200,{'Content-Type':MIME[path.extname(fp)]||'text/plain'});return res.end(fs.readFileSync(fp))}
  res.writeHead(404);res.end('Not Found');
});

const wss=new WebSocketServer({server});
wss.on('connection',ws=>{
  console.log(`[claude] client + (${wss.clients.size})`);
  ws.send(JSON.stringify({type:'full',data:collect()}));
});
function broadcast(){const d=collect();wss.clients.forEach(c=>{if(c.readyState===1)c.send(JSON.stringify({type:'update',data:d}))})}

collect();
setInterval(broadcast,2000);
[SESS,PROJ].filter(fs.existsSync).forEach(d=>{try{fs.watch(d,{persistent:false,recursive:true},()=>setTimeout(broadcast,500))}catch{}});

server.listen(PORT,'127.0.0.1',()=>{
  console.log(`\n  🤖 Claude Monitor  http://localhost:${PORT}\n`);
  if(process.argv.includes('--open'))execSync(`start msedge --app="http://localhost:${PORT}" --window-size=1000,650`,{shell:'cmd.exe',windowsHide:true});
});
