// server.js – MixVibe Mirror Backend (Render‑ready)
// Zero dependencies, Node.js 18+ required
// Run: node server.js
// Configuration via environment variables (or hardcoded defaults)

const http = require('http');
const fs = require('fs');
const path = require('path');

// ------------- Configuration (use env vars for production) -------------
const MIXVIBE_BASE = 'https://pw.mixvibe.site';
const SECURITY_TOKEN = process.env.SECURITY_TOKEN || 'sdjfgeoriughdritvtiuohdorsiugh';
const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY || 'AIzaSyC5gZ9DxjlabtJuDyIU1sY1yy1N7YVBdlU';
const EMAIL = process.env.MIXVIBE_EMAIL || 'vawig47668@hotkev.com';
const PASSWORD = process.env.MIXVIBE_PASSWORD || 'vawig47668@hotkev.com';
const DATA_FILE = path.join(__dirname, 'data.json');
const PORT = process.env.PORT || 3000;
const MAX_SUBJECTS = 0;  // 0 = all
const MAX_TOPICS = 0;     // 0 = all

// ------------- State -------------
let data = {
    batches: { success: true, batches: [] },
    batchDetails: {},
    live: {},
    topics: {},
    content: {}
};
let extractionInProgress = false;
let extractionStats = { startTime: null, processed: 0, total: 0, currentBatch: '' };
let authTokens = { idToken: null, refreshToken: null };

// ------------- Helpers -------------
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function refreshAuth() {
    if (!authTokens.refreshToken) {
        console.log('No refresh token – doing full login');
        return login();
    }
    console.log('Refreshing auth token...');
    const resp = await fetch(`https://securetoken.googleapis.com/v1/token?key=${FIREBASE_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `grant_type=refresh_token&refresh_token=${authTokens.refreshToken}`
    });
    if (!resp.ok) {
        console.log('Refresh failed – re‑logging in');
        return login();
    }
    const d = await resp.json();
    authTokens.idToken = d.id_token;
    authTokens.refreshToken = d.refresh_token;
    console.log('Auth refreshed');
    return authTokens.idToken;
}

async function login() {
    console.log('Logging into MixVibe...');
    const resp = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: EMAIL, password: PASSWORD, returnSecureToken: true })
    });
    if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(`Login failed: ${err.error?.message || resp.status}`);
    }
    const d = await resp.json();
    authTokens.idToken = d.idToken;
    authTokens.refreshToken = d.refreshToken;
    console.log('Logged in');
    return d.idToken;
}

async function apiCall(endpoint, retries = 2) {
    let token = authTokens.idToken;
    for (let attempt = 0; attempt <= retries; attempt++) {
        const headers = {
            'X-Security-Token': SECURITY_TOKEN,
            'Authorization': `Bearer ${token}`
        };
        try {
            const resp = await fetch(`${MIXVIBE_BASE}${endpoint}`, { headers });
            if (resp.status === 401) {
                console.log('Auth expired – refreshing token');
                token = await refreshAuth();
                continue;
            }
            if (resp.status === 429) {
                const wait = +(resp.headers.get('Retry-After') || 30);
                console.log(`Rate limited, waiting ${wait}s...`);
                await sleep(wait * 1000);
                continue;
            }
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            return await resp.json();
        } catch (e) {
            if (attempt === retries) throw e;
            await sleep(1000 * (attempt + 1));
        }
    }
}

// ------------- Extraction Logic -------------
async function extractNewBatches() {
    console.log('Starting extraction...');
    try {
        if (!authTokens.idToken) await login();

        const { batches } = await apiCall('/api/batches');
        if (!batches) throw new Error('No batches array in response');

        const existingIds = new Set(data.batches.batches.map(b => b._id));
        const newBatches = batches.filter(b => !existingIds.has(b._id));

        if (newBatches.length === 0) {
            console.log('No new batches.');
            return;
        }

        extractionStats.total = newBatches.length;
        extractionStats.processed = 0;
        extractionStats.startTime = new Date().toISOString();

        for (let i = 0; i < newBatches.length; i++) {
            const batch = newBatches[i];
            extractionStats.currentBatch = batch.name;
            console.log(`[${i+1}/${newBatches.length}] ${batch.name}`);

            // Add batch to main list
            data.batches.batches.push(batch);

            // Live classes
            try {
                const liveResp = await apiCall(`/api/live?batchId=${batch._id}`);
                if (liveResp.data && liveResp.data.length) data.live[batch._id] = liveResp;
            } catch (e) { console.log(`Live error: ${e.message}`); }
            await sleep(500);

            // Batch details (subjects)
            try {
                const detailResp = await apiCall(`/api/batchdetails?batchId=${batch._id}`);
                if (detailResp.success && detailResp.data) {
                    data.batchDetails[batch._id] = detailResp;
                    const subjects = MAX_SUBJECTS === 0 ? detailResp.data.subjects : detailResp.data.subjects.slice(0, MAX_SUBJECTS);

                    for (const subj of subjects) {
                        try {
                            const topicResp = await apiCall(`/api/topics?batchId=${batch._id}&subjectId=${subj._id}`);
                            if (topicResp.success && topicResp.data && topicResp.data.length) {
                                data.topics[`${batch._id}_${subj._id}`] = topicResp;
                                const topics = MAX_TOPICS === 0 ? topicResp.data : topicResp.data.slice(0, MAX_TOPICS);

                                for (const t of topics) {
                                    for (const type of ['videos', 'notes', 'dpp']) {
                                        try {
                                            const contResp = await apiCall(`/api/content?batchId=${batch._id}&subjectId=${subj._id}&topicId=${t._id}&contentType=${type}`);
                                            if (contResp.success && contResp.data && contResp.data.length) {
                                                data.content[`${batch._id}_${subj._id}_${t._id}_${type}`] = contResp;
                                            }
                                        } catch (e) { console.log(`Content ${type} error: ${e.message}`); }
                                        await sleep(200);
                                    }
                                }
                            }
                        } catch (e) { console.log(`Topics error: ${e.message}`); }
                        await sleep(200);
                    }
                }
            } catch (e) { console.log(`Details error: ${e.message}`); }
            await sleep(500);
            extractionStats.processed = i + 1;
        }

        // Save to file
        fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
        console.log('Extraction completed and data saved.');
    } catch (e) {
        console.error('Extraction failed:', e);
    } finally {
        extractionInProgress = false;
    }
}

// ------------- HTTP Server -------------
const server = http.createServer(async (req, res) => {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        return res.end();
    }

    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;
    const query = Object.fromEntries(url.searchParams);

    // API routes
    if (pathname === '/api/batches') {
        return respondJSON(res, data.batches);
    }
    if (pathname === '/api/batchdetails') {
        const batchId = query.batchId;
        return respondJSON(res, data.batchDetails[batchId] || { success: false, message: 'Not found' });
    }
    if (pathname === '/api/live') {
        const batchId = query.batchId;
        return respondJSON(res, data.live[batchId] || { data: [] });
    }
    if (pathname === '/api/topics') {
        const { batchId, subjectId } = query;
        const key = `${batchId}_${subjectId}`;
        return respondJSON(res, data.topics[key] || { success: false, data: [] });
    }
    if (pathname === '/api/content') {
        const { batchId, subjectId, topicId, contentType } = query;
        const key = `${batchId}_${subjectId}_${topicId}_${contentType}`;
        return respondJSON(res, data.content[key] || { success: false, data: [] });
    }
    if (pathname === '/api/stats') {
        const stats = {
            success: true,
            stats: {
                batches: data.batches.batches.length,
                subjects: Object.keys(data.batchDetails).length,
                topics: Object.keys(data.topics).length,
                content: Object.keys(data.content).length
            },
            extraction: extractionInProgress ? {
                running: true,
                ...extractionStats
            } : { running: false }
        };
        return respondJSON(res, stats);
    }
    if (pathname === '/api/extract' && req.method === 'POST') {
        if (extractionInProgress) {
            return respondJSON(res, { success: false, message: 'Extraction already running' });
        }
        extractionInProgress = true;
        extractionStats = { startTime: null, processed: 0, total: 0, currentBatch: '' };
        extractNewBatches().catch(err => console.error('Unhandled extraction error:', err));
        return respondJSON(res, { success: true, message: 'Extraction started' });
    }

    // Admin page
    if (pathname === '/admin' || pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end(adminHTML());
    }

    res.writeHead(404);
    res.end('Not found');
});

function respondJSON(res, obj) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
}

function adminHTML() {
    return `<!DOCTYPE html>
<html>
<head>
    <title>MixVibe Mirror Server</title>
    <style>
        body { font-family: system-ui; margin: 2rem; background: #0d1117; color: #c9d1d9; }
        button { padding: 0.8rem 1.5rem; background: #238636; color: #fff; border: none; border-radius: 6px; cursor: pointer; }
        button:disabled { opacity: 0.5; }
        code { background: #161b22; padding: 2px 6px; border-radius: 4px; }
    </style>
</head>
<body>
    <h1>🔴 MixVibe Mirror Server</h1>
    <button id="btnExtract" onclick="startExtraction()">Start Extraction (incremental)</button>
    <div id="status">Idle</div>
    <h2>API Endpoints</h2>
    <ul>
        <li><code>GET /api/batches</code></li>
        <li><code>GET /api/batchdetails?batchId=...</code></li>
        <li><code>GET /api/live?batchId=...</code></li>
        <li><code>GET /api/topics?batchId=...&subjectId=...</code></li>
        <li><code>GET /api/content?batchId=...&subjectId=...&topicId=...&contentType=...</code></li>
        <li><code>GET /api/stats</code></li>
        <li><code>POST /api/extract</code> (trigger extraction)</li>
    </ul>
    <script>
        async function startExtraction() {
            const btn = document.getElementById('btnExtract');
            btn.disabled = true;
            try {
                const resp = await fetch('/api/extract', { method: 'POST' });
                const data = await resp.json();
                alert(data.message);
            } catch(e) { alert('Error: ' + e.message); }
            btn.disabled = false;
        }
        async function poll() {
            try {
                const r = await fetch('/api/stats');
                const d = await r.json();
                const s = document.getElementById('status');
                if (d.extraction?.running) {
                    s.innerHTML = \`Running: \${d.extraction.processed}/\${d.extraction.total} – \${d.extraction.currentBatch}\`;
                } else {
                    s.innerHTML = 'Idle';
                }
            } catch(e) {}
        }
        setInterval(poll, 1000);
        poll();
    </script>
</body>
</html>`;
}

// ------------- Startup -------------
if (fs.existsSync(DATA_FILE)) {
    try {
        data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        console.log(`Loaded existing data (${data.batches.batches.length} batches)`);
    } catch (e) {
        console.log('Error loading data.json, starting fresh.');
    }
}

server.listen(PORT, () => {
    console.log(`\n🚀 MixVibe Mirror running on port ${PORT}\n`);
    console.log(`   Admin: http://localhost:${PORT}/admin`);
    console.log(`   API:   http://localhost:${PORT}/api/batches\n`);
});
    
