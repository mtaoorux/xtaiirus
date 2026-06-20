
// server.js – MixVibe Mirror (Pure API + Repo Storage)
// Zero dependencies, Node.js 18+ required
// Run: node server.js
// Data stored in /data folder - commit to repo

const http = require('http');
const fs = require('fs');
const path = require('path');

// ==================== Configuration ====================
const CONFIG = {
    PORT: process.env.PORT || 3000,
    MIXVIBE_BASE: process.env.MIXVIBE_BASE || 'https://pw.mixvibe.site',
    SECURITY_TOKEN: process.env.SECURITY_TOKEN || 'sdjfgeoriughdritvtiuohdorsiugh',
    FIREBASE_API_KEY: process.env.FIREBASE_API_KEY || 'AIzaSyC5gZ9DxjlabtJuDyIU1sY1yy1N7YVBdlU',
    EMAIL: process.env.MIXVIBE_EMAIL || 'vawig47668@hotkev.com',
    PASSWORD: process.env.MIXVIBE_PASSWORD || 'vawig47668@hotkev.com',
    DATA_DIR: path.join(__dirname, 'data'),
    MAX_CONCURRENT: parseInt(process.env.MAX_CONCURRENT || '5'),
    REQUEST_DELAY: parseInt(process.env.REQUEST_DELAY || '200'),
    EXTRACT_INTERVAL: parseInt(process.env.EXTRACT_INTERVAL || '0'), // 0 = disabled
};

// ==================== Ensure directories ====================
['batches', 'batchdetails', 'live', 'topics', 'content', 'meta'].forEach(dir => {
    const fullPath = path.join(CONFIG.DATA_DIR, dir);
    if (!fs.existsSync(fullPath)) fs.mkdirSync(fullPath, { recursive: true });
});

// ==================== Auth State ====================
let auth = { idToken: null, refreshToken: null };

async function login() {
    const resp = await fetch(
        `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${CONFIG.FIREBASE_API_KEY}`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                email: CONFIG.EMAIL,
                password: CONFIG.PASSWORD,
                returnSecureToken: true
            })
        }
    );
    const d = await resp.json();
    if (!resp.ok) throw new Error(`Login failed: ${d.error?.message}`);
    auth.idToken = d.idToken;
    auth.refreshToken = d.refreshToken;
}

async function refreshAuth() {
    if (!auth.refreshToken) return login();
    const resp = await fetch(
        `https://securetoken.googleapis.com/v1/token?key=${CONFIG.FIREBASE_API_KEY}`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `grant_type=refresh_token&refresh_token=${auth.refreshToken}`
        }
    );
    if (!resp.ok) return login();
    const d = await resp.json();
    auth.idToken = d.id_token;
    auth.refreshToken = d.refresh_token;
}

// ==================== API Client ====================
async function apiCall(endpoint, retries = 3) {
    for (let i = 0; i <= retries; i++) {
        if (!auth.idToken) await login();
        try {
            const resp = await fetch(`${CONFIG.MIXVIBE_BASE}${endpoint}`, {
                headers: {
                    'X-Security-Token': CONFIG.SECURITY_TOKEN,
                    'Authorization': `Bearer ${auth.idToken}`
                },
                signal: AbortSignal.timeout(30000)
            });
            if (resp.status === 401) { await refreshAuth(); continue; }
            if (resp.status === 429) {
                const wait = +(resp.headers.get('Retry-After') || 10);
                await new Promise(r => setTimeout(r, wait * 1000));
                continue;
            }
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            return await resp.json();
        } catch (e) {
            if (i === retries) throw e;
            await new Promise(r => setTimeout(r, 2000 * (i + 1)));
        }
    }
}

// ==================== File Storage (Append-Only) ====================
function saveJSON(type, id, data) {
    fs.writeFileSync(
        path.join(CONFIG.DATA_DIR, type, `${id}.json`),
        JSON.stringify(data, null, 2)
    );
}

function loadJSON(type, id) {
    const filePath = path.join(CONFIG.DATA_DIR, type, `${id}.json`);
    if (fs.existsSync(filePath)) {
        try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
        catch (e) { console.error(`Error loading ${type}/${id}`); }
    }
    return null;
}

function listJSON(type) {
    const dir = path.join(CONFIG.DATA_DIR, type);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
        .filter(f => f.endsWith('.json'))
        .map(f => loadJSON(type, f.replace('.json', '')))
        .filter(Boolean);
}

function dataExists(type, id) {
    return fs.existsSync(path.join(CONFIG.DATA_DIR, type, `${id}.json`));
}

function countJSON(type) {
    const dir = path.join(CONFIG.DATA_DIR, type);
    return fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.json')).length : 0;
}

function getTotalSize() {
    let size = 0;
    ['batches', 'batchdetails', 'live', 'topics', 'content', 'meta'].forEach(type => {
        const dir = path.join(CONFIG.DATA_DIR, type);
        if (fs.existsSync(dir)) {
            fs.readdirSync(dir).forEach(f => {
                try { size += fs.statSync(path.join(dir, f)).size; } catch(e) {}
            });
        }
    });
    return size;
}

// ==================== Extraction Engine ====================
let extractionRunning = false;
let extractionStats = {
    running: false,
    processed: 0,
    total: 0,
    currentBatch: '',
    startTime: null,
    subjects: 0,
    topics: 0,
    content: 0
};

async function extractAll() {
    if (extractionRunning) throw new Error('Extraction already running');
    
    extractionRunning = true;
    extractionStats = {
        running: true,
        processed: 0,
        total: 0,
        currentBatch: '',
        startTime: new Date().toISOString(),
        subjects: 0,
        topics: 0,
        content: 0
    };
    
    try {
        console.log('\n🚀 Starting extraction...');
        
        // Get all batches
        const { batches } = await apiCall('/api/batches');
        if (!batches) throw new Error('No batches found');
        
        console.log(`📦 Source: ${batches.length} batches | Local: ${countJSON('batches')} batches`);
        
        // Find new batches only
        const newBatches = batches.filter(b => !dataExists('batches', b._id));
        
        if (newBatches.length === 0) {
            console.log('✅ Already up to date!');
            return { added: 0, total: batches.length };
        }
        
        console.log(`🆕 Extracting ${newBatches.length} new batches\n`);
        extractionStats.total = newBatches.length;
        
        // Process in chunks
        for (let i = 0; i < newBatches.length; i += CONFIG.MAX_CONCURRENT) {
            const chunk = newBatches.slice(i, i + CONFIG.MAX_CONCURRENT);
            await Promise.allSettled(chunk.map(batch => processBatch(batch)));
            extractionStats.processed = Math.min(i + CONFIG.MAX_CONCURRENT, newBatches.length);
        }
        
        // Save extraction stats
        extractionStats.running = false;
        extractionStats.lastRun = new Date().toISOString();
        saveJSON('meta', 'last-extraction', extractionStats);
        
        const totalSize = getTotalSize();
        console.log('\n✅ Extraction complete!');
        console.log(`   Batches: ${countJSON('batches')} | Details: ${countJSON('batchdetails')}`);
        console.log(`   Live: ${countJSON('live')} | Topics: ${countJSON('topics')}`);
        console.log(`   Content: ${countJSON('content')} | Size: ${(totalSize/1024/1024).toFixed(2)} MB`);
        console.log('💾 Data saved in /data folder - ready to commit!\n');
        
        return { added: newBatches.length, total: batches.length };
        
    } catch (e) {
        console.error('❌ Extraction failed:', e.message);
        throw e;
    } finally {
        extractionRunning = false;
        extractionStats.running = false;
    }
}

async function processBatch(batch) {
    try {
        extractionStats.currentBatch = batch.name || batch._id;
        console.log(`📦 [${extractionStats.processed + 1}/${extractionStats.total}] ${batch.name}`);
        
        // Save batch
        saveJSON('batches', batch._id, batch);
        
        // Fetch live
        try {
            const live = await apiCall(`/api/live?batchId=${batch._id}`);
            if (live?.data?.length) {
                saveJSON('live', batch._id, live);
                console.log(`  📡 Live: ${live.data.length}`);
            }
        } catch(e) { console.log(`  ⚠️ Live: ${e.message}`); }
        await sleep(CONFIG.REQUEST_DELAY);
        
        // Fetch details (subjects)
        const details = await apiCall(`/api/batchdetails?batchId=${batch._id}`);
        if (details?.success && details?.data) {
            saveJSON('batchdetails', batch._id, details);
            const subjects = details.data.subjects || [];
            console.log(`  📚 Subjects: ${subjects.length}`);
            extractionStats.subjects += subjects.length;
            
            for (const subject of subjects) {
                await processSubject(batch._id, subject);
                await sleep(CONFIG.REQUEST_DELAY);
            }
        }
        
        extractionStats.processed++;
    } catch(e) {
        console.error(`  ❌ Error: ${e.message}`);
    }
}

async function processSubject(batchId, subject) {
    try {
        const topicsData = await apiCall(`/api/topics?batchId=${batchId}&subjectId=${subject._id}`);
        if (topicsData?.success && topicsData?.data) {
            const key = `${batchId}_${subject._id}`;
            saveJSON('topics', key, topicsData);
            
            const topics = topicsData.data;
            console.log(`    📖 ${subject.name}: ${topics.length} topics`);
            extractionStats.topics += topics.length;
            
            for (const topic of topics) {
                await processContent(batchId, subject._id, topic._id);
                await sleep(CONFIG.REQUEST_DELAY);
            }
        }
    } catch(e) {
        console.log(`    ⚠️ Topics: ${e.message}`);
    }
}

async function processContent(batchId, subjectId, topicId) {
    for (const type of ['videos', 'notes', 'dpp']) {
        try {
            const content = await apiCall(
                `/api/content?batchId=${batchId}&subjectId=${subjectId}&topicId=${topicId}&contentType=${type}`
            );
            if (content?.success && content?.data?.length) {
                const key = `${batchId}_${subjectId}_${topicId}_${type}`;
                saveJSON('content', key, content);
                extractionStats.content++;
            }
        } catch(e) {}
        await sleep(100);
    }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ==================== HTTP Server (Pure API) ====================
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
    const params = Object.fromEntries(url.searchParams);
    
    try {
        // GET /api/batches
        if (pathname === '/api/batches') {
            const search = params.search?.toLowerCase();
            let batches = listJSON('batches');
            if (search) {
                batches = batches.filter(b => 
                    b.name?.toLowerCase().includes(search) ||
                    b.description?.toLowerCase().includes(search)
                );
            }
            return sendJSON(res, { success: true, batches, total: batches.length });
        }
        
        // GET /api/batchdetails?batchId=...
        if (pathname === '/api/batchdetails') {
            const id = params.batchId;
            if (!id) return sendError(res, 400, 'batchId required');
            const data = loadJSON('batchdetails', id);
            return data ? sendJSON(res, data) : sendError(res, 404, 'Not found');
        }
        
        // GET /api/live?batchId=...
        if (pathname === '/api/live') {
            const id = params.batchId;
            if (!id) return sendError(res, 400, 'batchId required');
            return sendJSON(res, loadJSON('live', id) || { data: [] });
        }
        
        // GET /api/topics?batchId=...&subjectId=...
        if (pathname === '/api/topics') {
            const { batchId, subjectId } = params;
            if (!batchId || !subjectId) return sendError(res, 400, 'batchId & subjectId required');
            const key = `${batchId}_${subjectId}`;
            return sendJSON(res, loadJSON('topics', key) || { success: false, data: [] });
        }
        
        // GET /api/content?batchId=...&subjectId=...&topicId=...&contentType=...
        if (pathname === '/api/content') {
            const { batchId, subjectId, topicId, contentType } = params;
            if (!batchId || !subjectId || !topicId || !contentType) {
                return sendError(res, 400, 'All parameters required');
            }
            const key = `${batchId}_${subjectId}_${topicId}_${contentType}`;
            return sendJSON(res, loadJSON('content', key) || { success: false, data: [] });
        }
        
        // GET /api/stats
        if (pathname === '/api/stats') {
            const totalSize = getTotalSize();
            return sendJSON(res, {
                success: true,
                stats: {
                    batches: countJSON('batches'),
                    batchdetails: countJSON('batchdetails'),
                    live: countJSON('live'),
                    topics: countJSON('topics'),
                    content: countJSON('content')
                },
                totalSize: {
                    bytes: totalSize,
                    kb: (totalSize / 1024).toFixed(2),
                    mb: (totalSize / (1024 * 1024)).toFixed(2),
                    gb: (totalSize / (1024 * 1024 * 1024)).toFixed(2)
                },
                extraction: extractionStats
            });
        }
        
        // POST /api/extract
        if (pathname === '/api/extract' && req.method === 'POST') {
            if (extractionRunning) return sendError(res, 409, 'Extraction already running');
            extractAll().catch(console.error);
            return sendJSON(res, { success: true, message: 'Extraction started' });
        }
        
        // GET /health
        if (pathname === '/health') {
            return sendJSON(res, {
                status: 'ok',
                extraction: extractionRunning ? 'running' : 'idle',
                batches: countJSON('batches')
            });
        }
        
        // 404
        sendError(res, 404, 'Not found');
        
    } catch (e) {
        console.error('Server error:', e);
        sendError(res, 500, 'Internal server error');
    }
});

function sendJSON(res, data, status = 200) {
    const json = JSON.stringify(data, null, 2);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(json);
}

function sendError(res, status, message) {
    sendJSON(res, { success: false, error: message }, status);
}

// ==================== Startup ====================
// Load last extraction stats
const lastStats = loadJSON('meta', 'last-extraction');
if (lastStats) extractionStats = { ...extractionStats, ...lastStats, running: false };

server.listen(CONFIG.PORT, () => {
    console.log('='.repeat(50));
    console.log('🔴 MixVibe Mirror - Pure API Server');
    console.log('='.repeat(50));
    console.log(`📡 http://localhost:${CONFIG.PORT}`);
    console.log(`💾 ${CONFIG.DATA_DIR}`);
    console.log(`📊 Batches: ${countJSON('batches')} | Content: ${countJSON('content')}`);
    console.log(`💾 Size: ${(getTotalSize()/1024/1024).toFixed(2)} MB`);
    console.log('='.repeat(50));
    console.log('API Endpoints:');
    console.log('  GET  /api/batches');
    console.log('  GET  /api/batchdetails?batchId=');
    console.log('  GET  /api/live?batchId=');
    console.log('  GET  /api/topics?batchId=&subjectId=');
    console.log('  GET  /api/content?batchId=&subjectId=&topicId=&contentType=');
    console.log('  GET  /api/stats');
    console.log('  POST /api/extract');
    console.log('  GET  /health');
    console.log('='.repeat(50));
    
    // Auto-extraction
    if (CONFIG.EXTRACT_INTERVAL > 0) {
        console.log(`⏰ Auto-extraction every ${CONFIG.EXTRACT_INTERVAL}ms`);
        setInterval(() => extractAll().catch(console.error), CONFIG.EXTRACT_INTERVAL);
    }
});

// Graceful shutdown
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
