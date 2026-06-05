/**
 * Claude Code Desktop Monitor — Backend
 * Real-time: processes, sessions, tokens (JSONL), cost (official pricing).
 */
'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { WebSocketServer } = require('ws');

// ── Paths ───────────────────────────────────────────────────────────────────
const HOME          = process.env.HOME || process.env.USERPROFILE || '.';
const CLAUDE_DIR    = path.join(HOME, '.claude');
const SESSIONS_DIR  = path.join(CLAUDE_DIR, 'sessions');
const PROJECTS_DIR  = path.join(CLAUDE_DIR, 'projects');  // JSONL lives here
const HISTORY_FILE  = path.join(CLAUDE_DIR, 'history.jsonl');
const SETTINGS_FILE = path.join(CLAUDE_DIR, 'settings.json');
const PORT          = 9876;
const POLL_MS       = 2000;

// ── Official Claude API pricing (per 1M tokens, USD) ────────────────────────
// Source: platform.claude.com pricing docs, cached 2026-05-26
const PRICING = {
  // Anthropic models
  'claude-opus-4-8':   { input: 5.00,  output: 25.00, cacheW: 6.25,  cacheR: 0.50  },
  'claude-opus-4-7':   { input: 5.00,  output: 25.00, cacheW: 6.25,  cacheR: 0.50  },
  'claude-opus-4-6':   { input: 5.00,  output: 25.00, cacheW: 6.25,  cacheR: 0.50  },
  'claude-opus-4-5':   { input: 15.00, output: 75.00, cacheW: 18.75, cacheR: 1.50  },
  'claude-sonnet-4-6': { input: 3.00,  output: 15.00, cacheW: 3.75,  cacheR: 0.30  },
  'claude-sonnet-4-5': { input: 3.00,  output: 15.00, cacheW: 3.75,  cacheR: 0.30  },
  'claude-haiku-4-5':  { input: 1.00,  output: 5.00,  cacheW: 1.25,  cacheR: 0.10  },
  // Fallback for unknown / non-Anthropic models (use Sonnet pricing as reference)
  'default':           { input: 3.00,  output: 15.00, cacheW: 3.75,  cacheR: 0.30  },
};

// ── In-memory state ─────────────────────────────────────────────────────────
let state = {
  processes: [],
  sessions:  [],
  tokens:    { totalInput:0, totalOutput:0, totalCacheW:0, totalCacheR:0,
               estimatedCost:0, perModel:{}, totalConversations:0 },
  health:    { status:'unknown', issues:[], checks:{} },
  activity:  { lastActive:null, sessionCount24h:0, totalSessions:0, activeNow:0 },
  settings:  {},
  fileActivity: null,
  system:    { cpuPercent:0, memoryTotalGB:0, memoryFreeGB:0, memoryUsedPercent:0,
               platform:process.platform, nodeVersion:process.version, uptime:0 },
  timestamp: Date.now(),
};
let historyBuf = [];  // sliding window for chart (last ~1h)

// ════════════════════════════════════════════════════════════════════════════
//  PowerShell helpers
// ════════════════════════════════════════════════════════════════════════════

function runPs1(script, tag) {
  const f = path.join(__dirname, `.ps-${tag}.ps1`);
  try {
    fs.writeFileSync(f, script, 'utf8');
    const out = execSync(
      `powershell -NoProfile -ExecutionPolicy Bypass -File "${f}"`,
      { encoding:'utf8', timeout:8000, windowsHide:true }
    ).trim();
    try { fs.unlinkSync(f); } catch {}
    return out;
  } catch { try { fs.unlinkSync(f); } catch {} return ''; }
}

// ════════════════════════════════════════════════════════════════════════════
//  Data collectors
// ════════════════════════════════════════════════════════════════════════════

function getProcesses() {
  const out = runPs1(`
$p=Get-Process -Name 'claude' -ErrorAction SilentlyContinue
if(!$p){'[]'}else{
 $p|%{[PSCustomObject]@{Id=$_.Id;CPU=[math]::Round($_.CPU,1);
 WorkingSetMB=[math]::Round($_.WorkingSet64/1MB,1);
 StartTime=$_.StartTime.ToString('yyyy-MM-dd HH:mm:ss');
 UptimeMinutes=[math]::Round(((Get-Date)-$_.StartTime).TotalMinutes,1);
 Threads=$_.Threads.Count;HandleCount=$_.HandleCount}}|ConvertTo-Json -Compress}
`.trim(), 'proc');
  if (!out || out === '[]') return [];
  try { const d = JSON.parse(out); return Array.isArray(d) ? d : [d]; }
  catch {
    try { return JSON.parse('[' + out.replace(/\}\{/g,'},{') + ']'); }
    catch { return []; }
  }
}

function getSessions() {
  if (!fs.existsSync(SESSIONS_DIR)) return [];
  const now = Date.now();
  return fs.readdirSync(SESSIONS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try {
        const d = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR,f),'utf8'));
        const ageM = Math.round((now - d.startedAt)/60000);
        const alive = state.processes.some(p => p.Id === d.pid);
        return { pid:d.pid, sessionId:(d.sessionId||'').substring(0,12)+'…',
                 version:d.version, kind:d.kind, entrypoint:d.entrypoint,
                 cwd:d.cwd, ageMinutes:ageM, isActive:alive,
                 startedAt:new Date(d.startedAt).toISOString() };
      } catch { return null; }
    })
    .filter(Boolean)
    .sort((a,b) => b.startedAt.localeCompare(a.startedAt));
}

// ── NEW: real token usage from JSONL transcript files ───────────────────────
let _tokenCache = null;       // cached result
let _tokenCacheMtime = 0;     // last mtime we read

function getTokenUsage() {
  if (!fs.existsSync(PROJECTS_DIR)) return _emptyTokens();

  // Walk all project dirs to collect JSONL paths + their latest mtime
  const projects = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true });
  let latestMtime = 0;
  const jsonlFiles = [];

  for (const entry of projects) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(PROJECTS_DIR, entry.name);
    try {
      fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).forEach(f => {
        const fp = path.join(dir, f);
        try {
          const st = fs.statSync(fp);
          if (st.mtimeMs > latestMtime) latestMtime = st.mtimeMs;
          jsonlFiles.push(fp);
        } catch {}
      });
    } catch {}
  }

  // Return cache if nothing changed
  if (_tokenCache && latestMtime <= _tokenCacheMtime) return _tokenCache;

  // Parse every JSONL line for usage data
  const models = {};  // modelName → { input, output, cacheW, cacheR, calls }
  let totalConv = 0;

  for (const fp of jsonlFiles) {
    try {
      const raw = fs.readFileSync(fp, 'utf8');
      const lines = raw.split('\n').filter(Boolean);
      let hasData = false;
      for (const line of lines) {
        try {
          const d = JSON.parse(line);
          const usage = d.message?.usage || d.usage;
          if (!usage || !(usage.input_tokens || usage.output_tokens)) continue;
          hasData = true;
          const model = d.message?.model || d.model || 'unknown';
          if (!models[model]) models[model] = { input:0, output:0, cacheW:0, cacheR:0, calls:0 };
          models[model].input   += usage.input_tokens  || 0;
          models[model].output  += usage.output_tokens || 0;
          models[model].cacheW  += usage.cache_creation_input_tokens || 0;
          models[model].cacheR  += usage.cache_read_input_tokens      || 0;
          models[model].calls   += 1;
        } catch {}
      }
      if (hasData) totalConv++;
    } catch {}
  }

  // Aggregate
  let totalIn=0, totalOut=0, totalCW=0, totalCR=0, totalCost=0;
  const perModel = {};

  Object.entries(models).forEach(([model, t]) => {
    totalIn  += t.input;
    totalOut += t.output;
    totalCW  += t.cacheW;
    totalCR  += t.cacheR;

    const p = PRICING[model] || PRICING['default'];
    const cost = (t.input/1e6)*p.input   + (t.output/1e6)*p.output
               + (t.cacheW/1e6)*p.cacheW + (t.cacheR/1e6)*p.cacheR;

    totalCost += cost;
    perModel[model] = { ...t, cost, pricing: { input:p.input, output:p.output, cacheW:p.cacheW, cacheR:p.cacheR } };
  });

  // Count conversations from history
  let totalHistConvs = 0;
  if (fs.existsSync(HISTORY_FILE)) {
    try {
      totalHistConvs = fs.readFileSync(HISTORY_FILE,'utf8').split('\n').filter(Boolean).length;
    } catch {}
  }

  _tokenCache = {
    totalInput:    totalIn,
    totalOutput:   totalOut,
    totalCacheW:   totalCW,
    totalCacheR:   totalCR,
    estimatedCost: totalCost,
    perModel,
    totalConversations: Math.max(totalConv, totalHistConvs),
  };
  _tokenCacheMtime = latestMtime;
  return _tokenCache;
}

function _emptyTokens() {
  return { totalInput:0, totalOutput:0, totalCacheW:0, totalCacheR:0,
           estimatedCost:0, perModel:{}, totalConversations:0 };
}

// ── Health ──────────────────────────────────────────────────────────────────
function checkHealth() {
  const issues = [], checks = {};
  const procs = state.processes;
  const s     = state.sessions;

  checks.processCount = procs.length;
  if (procs.length === 0) issues.push({ severity:'warning', msg:'No Claude Code processes running' });
  else if (procs.length > 20) issues.push({ severity:'warning', msg:`High process count: ${procs.length}` });

  const totalCPU = procs.reduce((sum,p) => sum+(p.CPU||0), 0);
  checks.totalCPU = +totalCPU.toFixed(1);

  const totalMem = procs.reduce((sum,p) => sum+(p.WorkingSetMB||0), 0);
  checks.totalMemoryMB = +totalMem.toFixed(0);
  if (totalMem > 10000) issues.push({ severity:'warning', msg:`High memory: ${totalMem.toFixed(0)} MB` });

  const stale = s.filter(x => !x.isActive && x.ageMinutes < 120);
  checks.staleSessions = stale.length;

  checks.failedEventFiles = 0;
  const telDir = path.join(CLAUDE_DIR, 'telemetry');
  if (fs.existsSync(telDir)) {
    checks.failedEventFiles = fs.readdirSync(telDir).filter(f=>f.includes('failed')).length;
  }

  checks.activeSessions = s.filter(x => x.isActive).length;
  const veryOld = s.filter(x => x.isActive && x.ageMinutes > 480);
  if (veryOld.length > 0) issues.push({ severity:'info', msg:`${veryOld.length} sessions >8 hours` });

  return {
    status: issues.filter(i=>i.severity==='warning').length>0 ? 'warning'
            : procs.length===0 ? 'idle' : 'healthy',
    issues, checks,
  };
}

// ── Activity ────────────────────────────────────────────────────────────────
function getActivity() {
  const s = state.sessions, now = Date.now();
  const last24h = now - 24*60*60*1000;
  return {
    lastActive: s.length>0 ? s[0].startedAt : null,
    sessionCount24h: s.filter(x=>new Date(x.startedAt).getTime()>last24h).length,
    totalSessions: s.length,
    activeNow: s.filter(x=>x.isActive).length,
  };
}

// ── File activity detection ─────────────────────────────────────────────────
let lastFActivity = null, activityLog = [];
function detectFileActivity() {
  const dirs = [SESSIONS_DIR, PROJECTS_DIR];
  let latest = null;
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    try {
      fs.readdirSync(dir, { withFileTypes: true }).forEach(e => {
        try {
          const st = fs.statSync(path.join(dir, e.name));
          if (!latest || st.mtime > latest) latest = st.mtime;
        } catch {}
      });
    } catch {}
  }
  if (latest && (!lastFActivity || latest > lastFActivity)) {
    if (lastFActivity) {
      activityLog.push({ time:new Date().toISOString(), type:'file_change', message:'Claude 文件活动' });
    }
    lastFActivity = latest;
    if (activityLog.length > 50) activityLog = activityLog.slice(-50);
  }
  return {
    lastFileActivity: lastFActivity ? lastFActivity.toISOString() : null,
    recentEvents: activityLog.slice(-10),
    secondsSinceActivity: lastFActivity ? Math.round((Date.now()-lastFActivity.getTime())/1000) : null,
  };
}

// ── System ──────────────────────────────────────────────────────────────────
function getSystemInfo() {
  const out = runPs1(`
$cpu=(Get-CimInstance Win32_Processor).LoadPercentage
$os=Get-CimInstance Win32_OperatingSystem
[PSCustomObject]@{CPUPercent=$cpu;TotalGB=[math]::Round($os.TotalVisibleMemorySize/1MB,1);
FreeGB=[math]::Round($os.FreePhysicalMemory/1MB,1);
UsedPercent=[math]::Round(($os.TotalVisibleMemorySize-$os.FreePhysicalMemory)/$os.TotalVisibleMemorySize*100,1)}|ConvertTo-Json -Compress
`.trim(), 'sys');
  try {
    const o = JSON.parse(out||'{}');
    return { cpuPercent:o.CPUPercent||0, memoryTotalGB:o.TotalGB||0,
             memoryFreeGB:o.FreeGB||0, memoryUsedPercent:o.UsedPercent||0,
             platform:process.platform, nodeVersion:process.version, uptime:Math.round(process.uptime()) };
  } catch {
    return { cpuPercent:0,memoryTotalGB:0,memoryFreeGB:0,memoryUsedPercent:0,
             platform:process.platform,nodeVersion:process.version,uptime:Math.round(process.uptime()) };
  }
}

// ── Collect all ─────────────────────────────────────────────────────────────
function collect() {
  state.processes   = getProcesses();
  state.sessions    = getSessions();
  state.tokens      = getTokenUsage();
  state.health      = checkHealth();
  state.activity    = getActivity();
  state.system      = getSystemInfo();
  state.fileActivity = detectFileActivity();
  state.timestamp   = Date.now();

  try { state.settings = JSON.parse(fs.readFileSync(SETTINGS_FILE,'utf8')); } catch { state.settings = {}; }

  // Sliding window
  historyBuf.push({
    time: new Date().toISOString(),
    processes: state.processes.length,
    memMB: state.processes.reduce((s,p)=>s+(p.WorkingSetMB||0), 0),
    cpuS:  state.processes.reduce((s,p)=>s+(p.CPU||0), 0),
    cost: state.tokens.estimatedCost,
  });
  if (historyBuf.length > 1800) historyBuf.shift();
}

// ════════════════════════════════════════════════════════════════════════════
//  HTTP server
// ════════════════════════════════════════════════════════════════════════════

const MIME = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8',
  '.js':'application/javascript; charset=utf-8', '.json':'application/json',
  '.svg':'image/svg+xml', '.ico':'image/x-icon', '.png':'image/png' };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/api/state') {
    collect();
    res.writeHead(200, { 'Content-Type':'application/json', 'Access-Control-Allow-Origin':'*' });
    return res.end(JSON.stringify(state));
  }
  if (url.pathname === '/api/history') {
    res.writeHead(200, { 'Content-Type':'application/json', 'Access-Control-Allow-Origin':'*' });
    return res.end(JSON.stringify(historyBuf.slice(-300)));
  }
  if (url.pathname === '/api/ping') {
    res.writeHead(200, { 'Content-Type':'application/json', 'Access-Control-Allow-Origin':'*' });
    return res.end(JSON.stringify({ok:true,time:new Date().toISOString()}));
  }

  let fp = url.pathname === '/' ? '/index.html' : url.pathname;
  fp = path.join(__dirname, fp);
  const ext = path.extname(fp);
  if (fs.existsSync(fp) && fs.statSync(fp).isFile()) {
    res.writeHead(200, { 'Content-Type': MIME[ext]||'application/octet-stream' });
    return res.end(fs.readFileSync(fp));
  }
  res.writeHead(404); res.end('Not Found');
});

// ════════════════════════════════════════════════════════════════════════════
//  WebSocket
// ════════════════════════════════════════════════════════════════════════════

const wss = new WebSocketServer({ server });
wss.on('connection', ws => {
  console.log(`[monitor] client + (${wss.clients.size})`);
  collect();
  ws.send(JSON.stringify({ type:'full', data:state, history:historyBuf.slice(-300) }));
  ws.on('close', () => console.log(`[monitor] client - (${wss.clients.size})`));
  ws.on('error', () => {});
});

function broadcast() {
  collect();
  const msg = JSON.stringify({ type:'update', data:state });
  wss.clients.forEach(c => { if (c.readyState===1) c.send(msg); });
}

// ════════════════════════════════════════════════════════════════════════════
//  Start
// ════════════════════════════════════════════════════════════════════════════

collect();
setInterval(broadcast, POLL_MS);

// fs.watch on sessions + projects dirs for instant activity detection
[SESSIONS_DIR, PROJECTS_DIR].filter(fs.existsSync).forEach(dir => {
  try { fs.watch(dir, { persistent:false, recursive:true }, () => setTimeout(broadcast, 500)); } catch {}
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════════════╗');
  console.log('  ║     🤖 Claude Code Desktop Monitor           ║');
  console.log(`  ║     http://localhost:${PORT}                        ║`);
  console.log('  ╚══════════════════════════════════════════════╝');
  console.log('');

  if (process.argv.includes('--open') || process.argv.includes('-o')) {
    try {
      execSync(`start "" "http://localhost:${PORT}"`, { shell:'cmd.exe', windowsHide:true });
      console.log(`  🌐 Browser opened`);
    } catch { console.log(`  🌐 Open http://localhost:${PORT}`); }
  }
});
