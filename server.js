// server.js – MixVibe Mirror API
// Domain: xtaiirus.onrender.com
// Zero dependencies – Node.js 18+ native fetch

const http = require('http');
const fs = require('fs');
const path = require('path');

// ========== CONFIGURATION ==========
const DOMAIN = 'xtaiirus.onrender.com';
const MIXVIBE_API = 'https://pw.mixvibe.site';
const SECURITY_TOKEN = 'sdjfgeoriughdritvtiuohdorsiugh';
const FIREBASE_KEY = 'AIzaSyC5gZ9DxjlabtJuDyIU1sY1yy1N7YVBdlU';
const EMAIL = 'vawig47668@hotkev.com';
const PASSWORD = 'vawig47668@hotkev.com';
const PORT = process.env.PORT || 3000;
const MAX_SUBJECTS = 0;
const MAX_TOPICS = 0;

// ========== STORAGE ==========
const DATA_DIR = process.env.RENDER ? '/opt/render/data' : path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'data.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ========== STATE ==========
let data = {
    meta: { domain: DOMAIN, created: new Date().toISOString(), updated: new Date().toISOString(), extractions: 0 },
    batches: { success: true, batches: [] },
    batchDetails: {},
    live: {},
    topics: {},
    content: {}
};

let extracting = false;
let stats = { start: null, done: 0, total: 0, batch: '', errors: 0 };
let auth = { idToken: null, refreshToken: null };
let started = new Date();

// ========== HELPERS ==========
const wait = ms => new Promise(r => setTimeout(r, ms));
const now = () => new Date().toISOString();

function save() {
    data.meta.updated = now();
    try { fs.writeFileSync(DATA_FILE, JSON.stringify(data)); return true; }
    catch (e) { console.error('Save failed:', e.message); return false; }
}

function log(msg) { console.log(`[${now()}] ${msg}`); }

// ========== AUTH ==========
async function refreshAuth() {
    if (!auth.refreshToken) return login();
    try {
        const r = await fetch(`https://securetoken.googleapis.com/v1/token?key=${FIREBASE_KEY}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `grant_type=refresh_token&refresh_token=${auth.refreshToken}`
        });
        if (!r.ok) throw new Error('Refresh failed');
        const d = await r.json();
        auth.idToken = d.id_token;
        auth.refreshToken = d.refresh_token;
        return d.id_token;
    } catch (e) { return login(); }
}

async function login() {
    const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: EMAIL, password: PASSWORD, returnSecureToken: true })
    });
    if (!r.ok) throw new Error('Login failed');
    const d = await r.json();
    auth.idToken = d.idToken;
    auth.refreshToken = d.refreshToken;
    log('Logged in to MixVibe');
    return d.idToken;
}

// ========== API CALL ==========
async function call(endpoint, retries = 3) {
    let token = auth.idToken;
    for (let i = 0; i <= retries; i++) {
        try {
            const r = await fetch(`${MIXVIBE_API}${endpoint}`, {
                headers: {
                    'X-Security-Token': SECURITY_TOKEN,
                    'Authorization': `Bearer ${token}`,
                    'User-Agent': `MixVibe-Mirror/${DOMAIN}`
                }
            });
            if (r.status === 401) { token = await refreshAuth(); continue; }
            if (r.status === 429) { const w = +(r.headers.get('Retry-After') || 30); await wait(w * 1000); continue; }
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return await r.json();
        } catch (e) {
            if (i === retries) throw e;
            await wait(1000 * (i + 1));
        }
    }
}

// ========== EXTRACTION ==========
async function extract() {
    log('Starting extraction');
    try {
        if (!auth.idToken) await login();
        const { batches } = await call('/api/batches');
        if (!batches) throw new Error('No batches');
        const existing = new Set(data.batches.batches.map(b => b._id));
        const fresh = batches.filter(b => !existing.has(b._id));
        if (!fresh.length) { log('No new batches'); data.meta.extractions++; save(); return; }
        log(`Found ${fresh.length} new batches (total: ${batches.length})`);
        stats = { start: now(), done: 0, total: fresh.length, batch: '', errors: 0 };

        for (let i = 0; i < fresh.length; i++) {
            const b = fresh[i];
            stats.batch = b.name;
            log(`[${i+1}/${fresh.length}] ${b.name}`);
            data.batches.batches.push(b);
            try { const l = await call(`/api/live?batchId=${b._id}`); if (l.data?.length) data.live[b._id] = l; } catch (e) { stats.errors++; }
            await wait(500);
            try {
                const d = await call(`/api/batchdetails?batchId=${b._id}`);
                if (d.success && d.data?.subjects) {
                    data.batchDetails[b._id] = d;
                    const subs = MAX_SUBJECTS === 0 ? d.data.subjects : d.data.subjects.slice(0, MAX_SUBJECTS);
                    for (const s of subs) {
                        try {
                            const t = await call(`/api/topics?batchId=${b._id}&subjectId=${s._id}`);
                            if (t.success && t.data?.length) {
                                data.topics[`${b._id}_${s._id}`] = t;
                                const tops = MAX_TOPICS === 0 ? t.data : t.data.slice(0, MAX_TOPICS);
                                for (const tp of tops) {
                                    for (const type of ['videos', 'notes', 'dpp']) {
                                        try { const c = await call(`/api/content?batchId=${b._id}&subjectId=${s._id}&topicId=${tp._id}&contentType=${type}`); if (c.success && c.data?.length) data.content[`${b._id}_${s._id}_${tp._id}_${type}`] = c; } catch (e) { stats.errors++; }
                                        await wait(200);
                                    }
                                }
                            }
                        } catch (e) { stats.errors++; }
                        await wait(200);
                    }
                }
            } catch (e) { stats.errors++; }
            stats.done = i + 1;
            save();
            await wait(500);
        }
        data.meta.extractions++;
        save();
        log(`Done! ${fresh.length} new | Total: ${data.batches.batches.length}`);
    } catch (e) { log(`Extraction failed: ${e.message}`); }
    finally { extracting = false; }
}

// ========== HTTP SERVER ==========
function json(res, data, code = 200) {
    res.writeHead(code, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end(JSON.stringify(data));
}

function page(res, body) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    res.end(body);
}

const server = http.createServer((req, res) => {
    if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
        return res.end();
    }
    const url = new URL(req.url, `https://${DOMAIN}`);
    const p = url.pathname;
    const q = Object.fromEntries(url.searchParams);

    if (p === '/api/health') return json(res, { status: 'ok', domain: DOMAIN, uptime: Math.floor((Date.now() - started) / 1000), batches: data.batches.batches.length, extracting, now: now() });
    if (p === '/api/batches') return json(res, data.batches);
    if (p === '/api/batchdetails') return json(res, data.batchDetails[q.batchId] || { success: false });
    if (p === '/api/live') return json(res, data.live[q.batchId] || { data: [] });
    if (p === '/api/topics') return json(res, data.topics[`${q.batchId}_${q.subjectId}`] || { success: false, data: [] });
    if (p === '/api/content') return json(res, data.content[`${q.batchId}_${q.subjectId}_${q.topicId}_${q.contentType}`] || { success: false, data: [] });
    if (p === '/api/stats') return json(res, {
        success: true, meta: data.meta,
        counts: { batches: data.batches.batches.length, subjects: Object.keys(data.batchDetails).length, topics: Object.keys(data.topics).length, content: Object.keys(data.content).length, live: Object.keys(data.live).length },
        extraction: extracting ? { running: true, ...stats } : { running: false }
    });
    if (p === '/api/extract' && req.method === 'POST') {
        if (extracting) return json(res, { success: false, message: 'Already running' }, 409);
        extracting = true;
        stats = { start: null, done: 0, total: 0, batch: '', errors: 0 };
        extract().catch(e => { console.error(e); extracting = false; });
        return json(res, { success: true, message: 'Extraction started' });
    }

    // Home page (index + admin in one)
    if (p === '/' || p === '/admin' || p === '/index.html') return page(res, homePage());

    json(res, { success: false, message: 'Not found', endpoints: [`GET https://${DOMAIN}/api/batches`, `POST https://${DOMAIN}/api/extract`] }, 404);
});

// ========== HOME PAGE (Index + Admin) ==========
function homePage() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>MixVibe Mirror – ${DOMAIN}</title>
    <style>
        *{margin:0;padding:0;box-sizing:border-box}
        body{background:#0d1117;color:#c9d1d9;font-family:system-ui;min-height:100vh}
        .header{background:#161b22;border-bottom:1px solid #30363d;padding:1rem 2rem;display:flex;align-items:center;gap:1rem;flex-wrap:wrap}
        .header h1{color:#58a6ff;font-size:1.3rem}
        .header span{color:#8b949e;font-size:.8rem}
        .container{max-width:900px;margin:0 auto;padding:2rem}
        .card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:1.5rem;margin-bottom:1.5rem}
        .card h3{color:#58a6ff;margin-bottom:1rem}
        .btn{padding:.8rem 1.5rem;border:none;border-radius:6px;cursor:pointer;font-weight:600;font-size:.9rem;transition:all .2s}
        .btn-primary{background:#238636;color:#fff}.btn-primary:hover{background:#2ea043}
        .btn:disabled{opacity:.5;cursor:not-allowed}
        .btn-sm{padding:.4rem 1rem;font-size:.8rem}
        .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin:1rem 0}
        .stat{background:#0d1117;border:1px solid #30363d;border-radius:6px;padding:1rem;text-align:center}
        .stat-num{font-size:2rem;font-weight:bold;color:#58a6ff}
        .stat-label{color:#8b949e;font-size:.7rem;text-transform:uppercase;margin-top:.25rem}
        #status{padding:1rem;border-radius:6px;margin:1rem 0;background:#0d1117;border:1px solid #30363d}
        #status.running{background:#1a1a2e;border-color:#d2991d;color:#d2991d}
        .bar{height:4px;background:#21262d;border-radius:2px;margin-top:.5rem;overflow:hidden}
        .bar-fill{height:100%;background:#238636;transition:width .3s}
        code{background:#0d1117;padding:2px 8px;border-radius:4px;font-size:.85rem}
        .endpoints li{padding:.5rem 0;border-bottom:1px solid rgba(255,255,255,.03);list-style:none}
        .method{display:inline-block;padding:2px 8px;border-radius:4px;font-size:.7rem;font-weight:bold;margin-right:8px;min-width:45px;text-align:center}
        .GET{background:#238636;color:#fff}.POST{background:#da3633;color:#fff}
        a{color:#58a6ff;text-decoration:none}a:hover{text-decoration:underline}
        .footer{text-align:center;padding:2rem;color:#484f58;font-size:.8rem}
        input{background:#0d1117;border:1px solid #30363d;color:#c9d1d9;padding:.5rem;border-radius:4px;font-family:monospace}
        .copy-btn{cursor:pointer;background:#21262d;border:1px solid #30363d;color:#c9d1d9;padding:.3rem .8rem;border-radius:4px;font-size:.75rem}
        .copy-btn:hover{background:#30363d}
    </style>
</head>
<body>
<div class="header">
    <h1>🔴 MixVibe Mirror</h1>
    <span>${DOMAIN}</span>
</div>
<div class="container">
    <!-- Control -->
    <div class="card">
        <h3>🔄 Extraction Control</h3>
        <button class="btn btn-primary" id="btn" onclick="extract()">Start Extraction</button>
        <span style="margin-left:1rem;font-size:.8rem;color:#8b949e">Incremental – only new batches</span>
        <div id="status">Loading...</div>
        <div class="bar"><div class="bar-fill" id="bar" style="width:0%"></div></div>
    </div>
    
    <!-- Stats -->
    <div class="card">
        <h3>📊 Data Statistics</h3>
        <div class="grid">
            <div class="stat"><div class="stat-num" id="v1">-</div><div class="stat-label">Batches</div></div>
            <div class="stat"><div class="stat-num" id="v2">-</div><div class="stat-label">Subjects</div></div>
            <div class="stat"><div class="stat-num" id="v3">-</div><div class="stat-label">Topics</div></div>
            <div class="stat"><div class="stat-num" id="v4">-</div><div class="stat-label">Content</div></div>
            <div class="stat"><div class="stat-num" id="v5">-</div><div class="stat-label">Live</div></div>
        </div>
    </div>
    
    <!-- API Endpoints -->
    <div class="card">
        <h3>🔌 API Endpoints</h3>
        <ul class="endpoints">
            <li><span class="method GET">GET</span> <code>/api/batches</code> <button class="copy-btn" onclick="copy('https://${DOMAIN}/api/batches')">Copy</button></li>
            <li><span class="method GET">GET</span> <code>/api/batchdetails?batchId=</code> <button class="copy-btn" onclick="copy('https://${DOMAIN}/api/batchdetails?batchId=')">Copy</button></li>
            <li><span class="method GET">GET</span> <code>/api/live?batchId=</code> <button class="copy-btn" onclick="copy('https://${DOMAIN}/api/live?batchId=')">Copy</button></li>
            <li><span class="method GET">GET</span> <code>/api/topics?batchId=&subjectId=</code> <button class="copy-btn" onclick="copy('https://${DOMAIN}/api/topics?batchId=&subjectId=')">Copy</button></li>
            <li><span class="method GET">GET</span> <code>/api/content?batchId=&subjectId=&topicId=&contentType=</code> <button class="copy-btn" onclick="copy('https://${DOMAIN}/api/content?batchId=&subjectId=&topicId=&contentType=')">Copy</button></li>
            <li><span class="method GET">GET</span> <code>/api/stats</code> <button class="copy-btn" onclick="copy('https://${DOMAIN}/api/stats')">Copy</button></li>
            <li><span class="method POST">POST</span> <code>/api/extract</code> <button class="copy-btn" onclick="copy('curl -X POST https://${DOMAIN}/api/extract')">Copy curl</button></li>
            <li><span class="method GET">GET</span> <code>/api/health</code> <button class="copy-btn" onclick="copy('https://${DOMAIN}/api/health')">Copy</button></li>
        </ul>
    </div>
    
    <!-- Quick Test -->
    <div class="card">
        <h3>🧪 Quick Test</h3>
        <input type="text" id="testUrl" value="https://${DOMAIN}/api/batches" style="width:100%;margin-bottom:.5rem">
        <button class="btn btn-sm btn-primary" onclick="testAPI()">Test</button>
        <pre id="testResult" style="background:#0d1117;padding:1rem;border-radius:4px;margin-top:.5rem;max-height:200px;overflow:auto;font-size:.8rem;display:none"></pre>
    </div>
</div>
<div class="footer">MixVibe Mirror · ${DOMAIN} · Data stored persistently</div>

<script>
async function extract(){
    const b=document.getElementById('btn');
    b.disabled=true;b.textContent='⏳ Starting...';
    try{const r=await fetch('/api/extract',{method:'POST'});const d=await r.json();document.getElementById('status').textContent=d.message}
    catch(e){document.getElementById('status').textContent='Error: '+e.message}
    setTimeout(()=>{b.disabled=false;b.textContent='Start Extraction'},3000)
}

async function poll(){
    try{
        const r=await fetch('/api/stats');
        const d=await r.json();
        document.getElementById('v1').textContent=d.counts.batches;
        document.getElementById('v2').textContent=d.counts.subjects;
        document.getElementById('v3').textContent=d.counts.topics;
        document.getElementById('v4').textContent=d.counts.content;
        document.getElementById('v5').textContent=d.counts.live;
        const s=document.getElementById('status');
        const bar=document.getElementById('bar');
        if(d.extraction?.running){
            s.className='running';
            const pct=d.extraction.total>0?Math.round((d.extraction.done/d.extraction.total)*100):0;
            bar.style.width=pct+'%';
            s.innerHTML=`⏳ Extracting: ${d.extraction.done}/${d.extraction.total} – <b>${d.extraction.batch}</b> (${d.extraction.errors} errors)`
        }else{
            s.className='';
            bar.style.width='0%';
            s.innerHTML=d.meta?.updated?`✅ Idle – Last updated: ${new Date(d.meta.updated).toLocaleString()}`:'Idle – No data yet'
        }
    }catch(e){}
}

function copy(text){
    navigator.clipboard.writeText(text).then(()=>{
        const t=document.getElementById('status');
        t.textContent='Copied!';
        setTimeout(()=>poll(),1000)
    })
}

async function testAPI(){
    const url=document.getElementById('testUrl').value;
    const pre=document.getElementById('testResult');
    pre.style.display='block';
    pre.textContent='Loading...';
    try{
        const r=await fetch(url);
        const d=await r.json();
        pre.textContent=JSON.stringify(d,null,2)
    }catch(e){
        pre.textContent='Error: '+e.message
    }
}

setInterval(poll,2000);
poll()
</script>
</body>
</html>`;
}

// ========== START ==========
if (fs.existsSync(DATA_FILE)) {
    try { data = { ...data, ...JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) }; log(`Loaded ${data.batches.batches.length} batches`); }
    catch (e) { log('Error loading data, starting fresh'); save(); }
} else { save(); }

server.listen(PORT, () => {
    console.log(`\n🚀 MixVibe Mirror: https://${DOMAIN}\n   Port: ${PORT}\n   Storage: ${DATA_FILE}\n`);
});
            
