
// server.js – MixVibe Mirror Backend (Sequential Processing - Working)
// Zero dependencies, Node.js 18+ required
// Run: node server.js
// Data stored in /data folder - Batch data saves instantly

const http = require('http');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

// ==================== Configuration ====================
const CONFIG = {
    PORT: process.env.PORT || 3000,
    HOST: process.env.HOST || '0.0.0.0',
    DOMAIN: process.env.DOMAIN || 'localhost',
    NODE_ENV: process.env.NODE_ENV || 'development',
    
    MIXVIBE_BASE: process.env.MIXVIBE_BASE || 'https://pw.mixvibe.site',
    SECURITY_TOKEN: process.env.SECURITY_TOKEN || 'sdjfgeoriughdritvtiuohdorsiugh',
    FIREBASE_API_KEY: process.env.FIREBASE_API_KEY || 'AIzaSyC5gZ9DxjlabtJuDyIU1sY1yy1N7YVBdlU',
    MIXVIBE_EMAIL: process.env.MIXVIBE_EMAIL || 'vawig47668@hotkev.com',
    MIXVIBE_PASSWORD: process.env.MIXVIBE_PASSWORD || 'vawig47668@hotkev.com',
    
    DATA_DIR: process.env.DATA_DIR || path.join(__dirname, 'data'),
    PUBLIC_DIR: path.join(__dirname, 'public'),
    
    REQUEST_DELAY: 300,
    EXTRACT_INTERVAL: parseInt(process.env.EXTRACT_INTERVAL || '0'),
};

// ==================== Ensure directories ====================
const DATA_TYPES = ['batches', 'batchdetails', 'live', 'topics', 'content', 'meta'];
DATA_TYPES.forEach(dir => {
    const fullPath = path.join(CONFIG.DATA_DIR, dir);
    if (!fs.existsSync(fullPath)) {
        fs.mkdirSync(fullPath, { recursive: true });
    }
});

if (!fs.existsSync(CONFIG.PUBLIC_DIR)) {
    fs.mkdirSync(CONFIG.PUBLIC_DIR, { recursive: true });
}

// ==================== Storage Layer ====================
class StorageManager {
    constructor(dataDir) {
        this.dataDir = dataDir;
        this.cache = new Map();
        this.index = { batches: [], batchDetails: {}, live: {}, topics: {}, content: {} };
        this.rebuildIndex();
    }

    rebuildIndex() {
        this.index = { batches: [], batchDetails: {}, live: {}, topics: {}, content: {} };
        DATA_TYPES.forEach(type => {
            if (type === 'meta') return;
            const dirPath = path.join(this.dataDir, type);
            if (fs.existsSync(dirPath)) {
                fs.readdirSync(dirPath).filter(f => f.endsWith('.json')).forEach(file => {
                    const id = file.replace('.json', '');
                    try {
                        const data = JSON.parse(fs.readFileSync(path.join(dirPath, file), 'utf8'));
                        if (type === 'batches') {
                            this.index.batches.push({ _id: id, name: data.name || data.batchName || id, timestamp: new Date().toISOString() });
                        }
                    } catch(e) {}
                });
            }
        });
        this.saveIndex();
    }

    saveJSON(type, id, data) {
        const filePath = path.join(this.dataDir, type, `${id}.json`);
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
        
        if (type === 'batches') {
            const existing = this.index.batches.findIndex(b => b._id === id);
            const entry = { _id: id, name: data.name || data.batchName || id, timestamp: new Date().toISOString() };
            if (existing >= 0) this.index.batches[existing] = entry;
            else this.index.batches.push(entry);
        }
        this.saveIndex();
        this.cache.set(`${type}:${id}`, data);
    }

    loadJSON(type, id) {
        const cached = this.cache.get(`${type}:${id}`);
        if (cached) return cached;
        const filePath = path.join(this.dataDir, type, `${id}.json`);
        if (fs.existsSync(filePath)) {
            try {
                const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                this.cache.set(`${type}:${id}`, data);
                return data;
            } catch (e) {}
        }
        return null;
    }

    listJSON(type) {
        const dirPath = path.join(this.dataDir, type);
        if (!fs.existsSync(dirPath)) return [];
        return fs.readdirSync(dirPath)
            .filter(f => f.endsWith('.json'))
            .map(f => this.loadJSON(type, f.replace('.json', '')))
            .filter(Boolean);
    }

    getAllBatchIds() {
        if (this.index.batches.length > 0) return this.index.batches.map(b => b._id);
        const dir = path.join(this.dataDir, 'batches');
        if (fs.existsSync(dir)) return fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => f.replace('.json', ''));
        return [];
    }

    getStats() {
        const stats = {};
        DATA_TYPES.forEach(type => {
            if (type === 'meta') return;
            const dirPath = path.join(this.dataDir, type);
            if (fs.existsSync(dirPath)) {
                const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.json'));
                let totalSize = 0;
                files.forEach(f => { try { totalSize += fs.statSync(path.join(dirPath, f)).size; } catch(e) {} });
                stats[type] = { count: files.length, size: totalSize };
            } else {
                stats[type] = { count: 0, size: 0 };
            }
        });
        return stats;
    }

    saveIndex() {
        fs.writeFileSync(path.join(this.dataDir, 'meta', 'index.json'), JSON.stringify(this.index, null, 2));
    }
}

// ==================== Rate Limiter ====================
class RateLimiter {
    constructor(windowMs = 60000, maxRequests = 1000) {
        this.windowMs = windowMs;
        this.maxRequests = maxRequests;
        this.clients = new Map();
        setInterval(() => this.cleanup(), 60000);
    }
    isAllowed(clientIP) {
        const now = Date.now();
        const clientData = this.clients.get(clientIP) || { requests: [] };
        clientData.requests = clientData.requests.filter(time => now - time < this.windowMs);
        if (clientData.requests.length >= this.maxRequests) return false;
        clientData.requests.push(now);
        this.clients.set(clientIP, clientData);
        return true;
    }
    cleanup() {
        const now = Date.now();
        for (const [ip, data] of this.clients.entries()) {
            data.requests = data.requests.filter(time => now - time < this.windowMs);
            if (data.requests.length === 0) this.clients.delete(ip);
        }
    }
}

// ==================== Event System ====================
class ExtractionEmitter extends EventEmitter {}
const extractionEvents = new ExtractionEmitter();

// ==================== Auth Manager ====================
class AuthManager {
    constructor() {
        this.tokens = { idToken: null, refreshToken: null };
    }

    async getToken() {
        if (!this.tokens.idToken) await this.login();
        return this.tokens.idToken;
    }

    async refreshToken() {
        if (!this.tokens.refreshToken) return this.login();
        try {
            const resp = await fetch(`https://securetoken.googleapis.com/v1/token?key=${CONFIG.FIREBASE_API_KEY}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: `grant_type=refresh_token&refresh_token=${this.tokens.refreshToken}`
            });
            if (!resp.ok) return this.login();
            const data = await resp.json();
            this.tokens.idToken = data.id_token;
            this.tokens.refreshToken = data.refresh_token;
            return this.tokens.idToken;
        } catch (error) { return this.login(); }
    }

    async login() {
        console.log('🔑 Logging in...');
        const resp = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${CONFIG.FIREBASE_API_KEY}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: CONFIG.MIXVIBE_EMAIL, password: CONFIG.MIXVIBE_PASSWORD, returnSecureToken: true })
        });
        if (!resp.ok) { const err = await resp.json().catch(() => ({})); throw new Error(`Login failed: ${err.error?.message || resp.status}`); }
        const data = await resp.json();
        this.tokens.idToken = data.id_token;
        this.tokens.refreshToken = data.refresh_token;
        console.log('✅ Logged in');
        return this.tokens.idToken;
    }
}

// ==================== API Client ====================
class MixVibeClient {
    constructor(authManager) { this.auth = authManager; }

    async apiCall(endpoint, retries = 5) {
        let token = await this.auth.getToken();
        for (let attempt = 0; attempt <= retries; attempt++) {
            try {
                const resp = await fetch(`${CONFIG.MIXVIBE_BASE}${endpoint}`, {
                    headers: {
                        'X-Security-Token': CONFIG.SECURITY_TOKEN,
                        'Authorization': `Bearer ${token}`,
                        'Accept': 'application/json'
                    },
                    signal: AbortSignal.timeout(60000)
                });
                
                if (resp.status === 401) { token = await this.auth.refreshToken(); continue; }
                if (resp.status === 429) {
                    const wait = +(resp.headers.get('Retry-After') || 10);
                    console.log(`⏳ Rate limited, waiting ${wait}s...`);
                    await new Promise(r => setTimeout(r, wait * 1000));
                    continue;
                }
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                return await resp.json();
            } catch (e) {
                if (e.name === 'TimeoutError' || e.name === 'AbortError') console.log(`Timeout: ${endpoint}`);
                if (attempt === retries) throw e;
                await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
            }
        }
    }
}

// ==================== Extraction Engine ====================
class ExtractionEngine {
    constructor(storage, client) {
        this.storage = storage;
        this.client = client;
        this.running = false;
        this.stats = {
            startTime: null, processed: 0, total: 0, currentBatch: '',
            errors: [], warnings: [], lastRun: null,
            totalSubjects: 0, totalTopics: 0, totalContent: 0
        };
    }

    sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    async extractAll() {
        if (this.running) throw new Error('Extraction already in progress');

        this.running = true;
        this.stats = { startTime: new Date().toISOString(), processed: 0, total: 0, currentBatch: '', errors: [], warnings: [], lastRun: null, totalSubjects: 0, totalTopics: 0, totalContent: 0 };
        extractionEvents.emit('extraction:start', this.stats);

        try {
            console.log('\n🚀 Starting extraction...\n');
            
            // STEP 1: Get all batches
            console.log('📡 Fetching batches...');
            const response = await this.client.apiCall('/api/batches');
            
            if (!response || !Array.isArray(response.batches)) {
                throw new Error('Invalid response from API');
            }

            const batches = response.batches;
            console.log(`📦 Found ${batches.length} batches`);
            console.log(`💾 Storage has ${this.storage.getAllBatchIds().length} batches\n`);
            
            if (batches.length === 0) {
                console.log('No batches to process');
                extractionEvents.emit('extraction:complete', this.stats);
                return { added: 0, total: 0 };
            }

            this.stats.total = batches.length;

            // STEP 2: Save ALL batches immediately
            console.log('💾 Saving batch data...');
            for (const batch of batches) {
                this.storage.saveJSON('batches', batch._id, batch);
            }
            this.storage.saveIndex();
            console.log(`✅ ${batches.length} batches saved! Check /api/batches now\n`);

            // STEP 3: Process each batch ONE BY ONE
            console.log('⚡ Processing additional data...\n');
            
            for (let i = 0; i < batches.length; i++) {
                const batch = batches[i];
                
                this.stats.processed = i + 1;
                this.stats.currentBatch = batch.name || batch._id;
                
                console.log(`${'='.repeat(50)}`);
                console.log(`[${i+1}/${batches.length}] 📦 ${batch.name || batch._id}`);
                console.log(`${'='.repeat(50)}`);
                
                try {
                    // Save batch (ensures it's saved)
                    this.storage.saveJSON('batches', batch._id, batch);
                    console.log('  ✅ Batch saved');
                    
                    // Fetch live classes
                    try {
                        const liveData = await this.client.apiCall(`/api/live?batchId=${batch._id}`);
                        if (liveData?.data?.length > 0) {
                            this.storage.saveJSON('live', batch._id, liveData);
                            console.log(`  📡 Live: ${liveData.data.length} classes`);
                        } else {
                            console.log('  📡 Live: None');
                        }
                    } catch (e) {
                        console.log(`  ⚠️ Live: ${e.message}`);
                        this.stats.warnings.push(`Live ${batch._id}: ${e.message}`);
                    }
                    await this.sleep(CONFIG.REQUEST_DELAY);
                    
                    // Fetch batch details
                    let subjects = [];
                    try {
                        const details = await this.client.apiCall(`/api/batchdetails?batchId=${batch._id}`);
                        if (details?.success && details.data) {
                            this.storage.saveJSON('batchdetails', batch._id, details);
                            subjects = details.data.subjects || [];
                            console.log(`  📚 Subjects: ${subjects.length}`);
                            this.stats.totalSubjects += subjects.length;
                        }
                    } catch (e) {
                        console.log(`  ⚠️ Details: ${e.message}`);
                        this.stats.warnings.push(`Details ${batch._id}: ${e.message}`);
                    }
                    await this.sleep(CONFIG.REQUEST_DELAY);
                    
                    // Process each subject
                    for (const subject of subjects) {
                        console.log(`    📖 Subject: ${subject.name || 'Unknown'}`);
                        
                        try {
                            const topicData = await this.client.apiCall(
                                `/api/topics?batchId=${batch._id}&subjectId=${subject._id}`
                            );
                            
                            if (topicData?.success && topicData.data) {
                                const key = `${batch._id}_${subject._id}`;
                                this.storage.saveJSON('topics', key, topicData);
                                
                                const topics = topicData.data;
                                console.log(`      Topics: ${topics.length}`);
                                this.stats.totalTopics += topics.length;
                                
                                // Process each topic
                                for (const topic of topics) {
                                    let topicContent = 0;
                                    
                                    for (const type of ['videos', 'notes', 'dpp']) {
                                        try {
                                            const content = await this.client.apiCall(
                                                `/api/content?batchId=${batch._id}&subjectId=${subject._id}&topicId=${topic._id}&contentType=${type}`
                                            );
                                            
                                            if (content?.success && content.data?.length > 0) {
                                                const ckey = `${batch._id}_${subject._id}_${topic._id}_${type}`;
                                                this.storage.saveJSON('content', ckey, content);
                                                this.stats.totalContent++;
                                                topicContent += content.data.length;
                                            }
                                        } catch (e) {
                                            // Skip individual content errors
                                        }
                                        await this.sleep(200);
                                    }
                                    
                                    if (topicContent > 0) {
                                        console.log(`      📄 ${topic.name || 'Topic'}: ${topicContent} items`);
                                    }
                                }
                            }
                        } catch (e) {
                            console.log(`      ⚠️ Failed: ${e.message}`);
                            this.stats.warnings.push(`Subject ${subject._id}: ${e.message}`);
                        }
                        await this.sleep(CONFIG.REQUEST_DELAY);
                    }
                    
                } catch (e) {
                    console.log(`  ❌ Error: ${e.message}`);
                    this.stats.errors.push(`Batch ${batch._id}: ${e.message}`);
                }
                
                // Save progress
                this.stats.lastRun = new Date().toISOString();
                this.storage.saveJSON('meta', 'extraction-stats', this.stats);
                this.storage.saveIndex();
                
                console.log(`  ✅ Batch ${i+1} complete\n`);
                extractionEvents.emit('extraction:progress', this.stats);
                
                await this.sleep(CONFIG.REQUEST_DELAY);
            }

            console.log('='.repeat(50));
            console.log('✅ EXTRACTION COMPLETE!');
            console.log('='.repeat(50));
            console.log(`   Batches: ${this.storage.getAllBatchIds().length}`);
            console.log(`   Subjects: ${this.stats.totalSubjects}`);
            console.log(`   Topics: ${this.stats.totalTopics}`);
            console.log(`   Content: ${this.stats.totalContent}`);
            console.log('='.repeat(50) + '\n');
            
            extractionEvents.emit('extraction:complete', this.stats);
            return { added: batches.length, total: batches.length, stats: this.stats };
            
        } catch (error) {
            console.error('❌ Extraction failed:', error.message);
            this.stats.errors.push(error.message);
            extractionEvents.emit('extraction:error', error);
            throw error;
        } finally {
            this.running = false;
        }
    }

    getStatus() {
        return { running: this.running, stats: this.stats };
    }
}

// ==================== Router ====================
class Router {
    constructor(storage, extractionEngine, rateLimiter) {
        this.storage = storage;
        this.extraction = extractionEngine;
        this.rateLimiter = rateLimiter;
        this.routes = new Map();
        this.setupRoutes();
    }

    setupRoutes() {
        this.addRoute('GET', '/api/batches', this.handleGetBatches.bind(this));
        this.addRoute('GET', '/api/batchdetails', this.handleGetBatchDetails.bind(this));
        this.addRoute('GET', '/api/live', this.handleGetLive.bind(this));
        this.addRoute('GET', '/api/topics', this.handleGetTopics.bind(this));
        this.addRoute('GET', '/api/content', this.handleGetContent.bind(this));
        this.addRoute('GET', '/api/stats', this.handleGetStats.bind(this));
        this.addRoute('POST', '/api/extract', this.handleExtract.bind(this));
        this.addRoute('POST', '/api/extract-all', this.handleExtractAll.bind(this));
        this.addRoute('GET', '/api/search', this.handleSearch.bind(this));
        this.addRoute('GET', '/api/export', this.handleExport.bind(this));
        this.addRoute('GET', '/health', this.handleHealth.bind(this));
        this.addRoute('GET', '/', this.serveAdminHTML.bind(this));
        this.addRoute('GET', '/admin', this.serveAdminHTML.bind(this));
    }

    addRoute(method, path, handler) {
        if (!this.routes.has(method)) this.routes.set(method, new Map());
        this.routes.get(method).set(path, handler);
    }

    serveFile(filePath, contentType, res) {
        try {
            if (!fs.existsSync(filePath)) { res.writeHead(404); res.end('Not found'); return; }
            const content = fs.readFileSync(filePath);
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(content);
        } catch (e) { res.writeHead(500); res.end('Error'); }
    }

    async handleStatic(req, res) {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const pathname = url.pathname;
        const mimeTypes = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript' };
        const ext = path.extname(pathname);
        const contentType = mimeTypes[ext] || 'text/plain';
        const safePath = path.normalize(path.join(CONFIG.PUBLIC_DIR, pathname));
        if (!safePath.startsWith(CONFIG.PUBLIC_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }
        this.serveFile(safePath, contentType, res);
    }

    async handleRequest(req, res) {
        const clientIP = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
        if (!this.rateLimiter.isAllowed(clientIP)) {
            res.writeHead(429, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Too many requests' }));
            return;
        }

        const url = new URL(req.url, `http://${req.headers.host}`);
        const method = req.method;
        const pathname = url.pathname;

        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

        if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

        const methodRoutes = this.routes.get(method);
        if (methodRoutes) {
            const handler = methodRoutes.get(pathname);
            if (handler) {
                try { await handler(req, res, url.searchParams); }
                catch (error) { console.error('Route error:', error); this.sendError(res, 500, 'Internal error'); }
                return;
            }
        }

        if (method === 'GET') { await this.handleStatic(req, res); return; }
        this.sendError(res, 404, 'Not found');
    }

    async serveAdminHTML(req, res, params) {
        const filePath = path.join(CONFIG.PUBLIC_DIR, 'admin.html');
        if (fs.existsSync(filePath)) { this.serveFile(filePath, 'text/html', res); return; }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(getAdminHTML());
    }

    async handleGetBatches(req, res, params) {
        const search = params.get('search')?.toLowerCase();
        let batches = this.storage.listJSON('batches');
        if (search) batches = batches.filter(b => b.name?.toLowerCase().includes(search));
        this.sendJSON(res, { success: true, batches, total: batches.length });
    }

    async handleGetBatchDetails(req, res, params) {
        if (!params.get('batchId')) return this.sendError(res, 400, 'batchId required');
        const details = this.storage.loadJSON('batchdetails', params.get('batchId'));
        if (!details) return this.sendError(res, 404, 'Not found');
        this.sendJSON(res, details);
    }

    async handleGetLive(req, res, params) {
        if (!params.get('batchId')) return this.sendError(res, 400, 'batchId required');
        this.sendJSON(res, this.storage.loadJSON('live', params.get('batchId')) || { data: [] });
    }

    async handleGetTopics(req, res, params) {
        const { batchId, subjectId } = params;
        if (!batchId || !subjectId) return this.sendError(res, 400, 'batchId and subjectId required');
        const key = `${batchId}_${subjectId}`;
        this.sendJSON(res, this.storage.loadJSON('topics', key) || { success: false, data: [] });
    }

    async handleGetContent(req, res, params) {
        const { batchId, subjectId, topicId, contentType } = params;
        if (!batchId || !subjectId || !topicId || !contentType) return this.sendError(res, 400, 'All params required');
        const key = `${batchId}_${subjectId}_${topicId}_${contentType}`;
        this.sendJSON(res, this.storage.loadJSON('content', key) || { success: false, data: [] });
    }

    async handleGetStats(req, res, params) {
        const fileStats = this.storage.getStats();
        const extractionStatus = this.extraction.getStatus();
        let totalSize = 0;
        Object.values(fileStats).forEach(stat => totalSize += stat.size);
        this.sendJSON(res, {
            success: true,
            files: fileStats,
            totalSize: { bytes: totalSize, mb: (totalSize / 1048576).toFixed(2), gb: (totalSize / 1073741824).toFixed(2) },
            extraction: extractionStatus,
            server: { uptime: process.uptime(), nodeVersion: process.version, platform: process.platform }
        });
    }

    async handleExtract(req, res, params) {
        if (this.extraction.running) return this.sendError(res, 409, 'Already running');
        this.extraction.extractAll().catch(err => console.error('Extraction error:', err));
        this.sendJSON(res, { success: true, message: 'Extraction started - batch data saved immediately' });
    }

    async handleExtractAll(req, res, params) {
        if (this.extraction.running) return this.sendError(res, 409, 'Already running');
        this.extraction.extractAll().catch(err => console.error('Extraction error:', err));
        this.sendJSON(res, { success: true, message: 'Full extraction started' });
    }

    async handleSearch(req, res, params) {
        const query = params.get('q')?.toLowerCase();
        if (!query) return this.sendError(res, 400, 'Query required');
        const results = { batches: [] };
        const batches = this.storage.listJSON('batches');
        for (const batch of batches) {
            if (batch.name?.toLowerCase().includes(query)) results.batches.push(batch);
        }
        this.sendJSON(res, { success: true, query, results, total: results.batches.length });
    }

    async handleExport(req, res, params) {
        const type = params.get('type') || 'all';
        const exportData = { metadata: { exportedAt: new Date().toISOString(), type } };
        if (type === 'all' || type === 'batches') exportData.batches = this.storage.listJSON('batches');
        if (type === 'all' || type === 'batchdetails') exportData.batchDetails = this.storage.listJSON('batchdetails');
        if (type === 'all' || type === 'content') exportData.content = this.storage.listJSON('content');
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename=mixvibe-export-${Date.now()}.json` });
        res.end(JSON.stringify(exportData, null, 2));
    }

    async handleHealth(req, res, params) {
        this.sendJSON(res, { status: 'ok', extraction: this.extraction.running ? 'running' : 'idle' });
    }

    sendJSON(res, data, statusCode = 200) {
        const json = JSON.stringify(data, null, 2);
        res.writeHead(statusCode, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
        res.end(json);
    }

    sendError(res, statusCode, message) {
        this.sendJSON(res, { success: false, error: message }, statusCode);
    }
}

// ==================== Built-in Admin Panel ====================
function getAdminHTML() {
    return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>MixVibe Mirror</title>
    <style>
        *{margin:0;padding:0;box-sizing:border-box}
        body{font-family:system-ui;background:#0d1117;color:#c9d1d9;padding:20px}
        .c{max-width:900px;margin:0 auto}
        h1{color:#58a6ff;margin-bottom:10px}
        .s{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin:20px 0}
        .sc{background:#161b22;padding:15px;border-radius:8px;text-align:center;border:1px solid #30363d}
        .sc .v{font-size:28px;font-weight:bold;color:#58a6ff}
        .sc .l{font-size:11px;color:#8b949e;margin-top:5px;text-transform:uppercase}
        button{padding:12px 24px;border:none;border-radius:8px;cursor:pointer;font-size:14px;font-weight:600;color:white;margin:5px}
        button:hover{filter:brightness(1.2)}
        button:disabled{opacity:0.5;cursor:not-allowed}
        .btn1{background:#238636}.btn2{background:#1f6feb}.btn3{background:#8957e5}
        .st{background:#161b22;padding:15px;border-radius:8px;margin:20px 0;border:1px solid #30363d}
        .pb{width:100%;height:6px;background:#21262d;border-radius:3px;margin:10px 0;overflow:hidden}
        .pbf{height:100%;background:#238636;width:0%;transition:width 0.5s}
        .log{background:#000;color:#0f0;padding:15px;border-radius:8px;font-family:monospace;max-height:300px;overflow-y:auto;font-size:13px;line-height:1.5}
        .ep{background:#161b22;padding:15px;border-radius:8px;margin:20px 0}
        .ep h3{margin-bottom:10px}
        .e{padding:5px 10px;margin:3px 0;background:#0d1117;border-radius:4px;font-family:monospace;font-size:12px}
        .method{display:inline-block;padding:2px 6px;border-radius:3px;font-weight:bold;margin-right:8px;font-size:10px;min-width:40px;text-align:center}
        .get{background:#238636;color:white}.post{background:#1f6feb;color:white}
    </style>
</head>
<body>
    <div class="c">
        <h1>🚀 MixVibe Mirror</h1>
        <p style="color:#8b949e;margin-bottom:15px">Admin Panel</p>
        
        <div class="s" id="stats">
            <div class="sc"><div class="v" id="b">0</div><div class="l">Batches</div></div>
            <div class="sc"><div class="v" id="d">0</div><div class="l">Details</div></div>
            <div class="sc"><div class="v" id="lv">0</div><div class="l">Live</div></div>
            <div class="sc"><div class="v" id="t">0</div><div class="l">Topics</div></div>
            <div class="sc"><div class="v" id="co">0</div><div class="l">Content</div></div>
            <div class="sc"><div class="v" id="sz">0 MB</div><div class="l">Size</div></div>
        </div>
        
        <button class="btn1" onclick="start()" id="btn">🔄 Start Extraction</button>
        <button class="btn2" onclick="load()">🔃 Refresh</button>
        <button class="btn3" onclick="window.open('/api/export','_blank')">📥 Export</button>
        
        <div class="st">
            <b>Status:</b> <span id="st">Idle</span>
            <div class="pb"><div class="pbf" id="bar"></div></div>
            <div id="info" style="font-size:13px;color:#8b949e"></div>
        </div>
        
        <div class="ep">
            <h3>📡 API Endpoints</h3>
            <div class="e"><span class="method get">GET</span> /api/batches</div>
            <div class="e"><span class="method get">GET</span> /api/batchdetails?batchId=</div>
            <div class="e"><span class="method get">GET</span> /api/live?batchId=</div>
            <div class="e"><span class="method get">GET</span> /api/topics?batchId=&subjectId=</div>
            <div class="e"><span class="method get">GET</span> /api/content?batchId=&subjectId=&topicId=&contentType=</div>
            <div class="e"><span class="method get">GET</span> /api/stats</div>
            <div class="e"><span class="method post">POST</span> /api/extract</div>
            <div class="e"><span class="method get">GET</span> /health</div>
        </div>
        
        <div class="log" id="log"><div>Ready...</div></div>
    </div>
    
    <script>
        async function load(){
            const r=await fetch('/api/stats'),d=await r.json();
            document.getElementById('b').textContent=d.files.batches?.count||0;
            document.getElementById('d').textContent=d.files.batchdetails?.count||0;
            document.getElementById('lv').textContent=d.files.live?.count||0;
            document.getElementById('t').textContent=d.files.topics?.count||0;
            document.getElementById('co').textContent=d.files.content?.count||0;
            document.getElementById('sz').textContent=d.totalSize.mb+' MB';
            const s=d.extraction;
            if(s.running){
                document.getElementById('st').innerHTML='⏳ '+s.stats.processed+'/'+s.stats.total+' - '+s.stats.currentBatch;
                document.getElementById('bar').style.width=(s.stats.total>0?(s.stats.processed/s.stats.total*100):0)+'%';
                document.getElementById('info').textContent='Subjects: '+s.stats.totalSubjects+' Topics: '+s.stats.totalTopics+' Content: '+s.stats.totalContent;
                document.getElementById('btn').disabled=true;
            }else{
                document.getElementById('st').textContent='✅ Idle';
                document.getElementById('bar').style.width='0%';
                document.getElementById('info').textContent='';
                document.getElementById('btn').disabled=false;
            }
        }
        async function start(){
            document.getElementById('btn').disabled=true;
            document.getElementById('log').innerHTML+='<div>Starting extraction...</div>';
            await fetch('/api/extract',{method:'POST'});
            document.getElementById('btn').disabled=false;
            load();
        }
        load();
        setInterval(load,3000);
    </script>
</body>
</html>`;
}

// ==================== Main Server ====================
class MixVibeMirrorServer {
    constructor() {
        this.storage = new StorageManager(CONFIG.DATA_DIR);
        this.auth = new AuthManager();
        this.client = new MixVibeClient(this.auth);
        this.extraction = new ExtractionEngine(this.storage, this.client);
        this.rateLimiter = new RateLimiter();
        this.router = new Router(this.storage, this.extraction, this.rateLimiter);
    }

    async start() {
        const stats = this.storage.loadJSON('meta', 'extraction-stats');
        if (stats) this.extraction.stats = stats;

        const server = http.createServer((req, res) => this.router.handleRequest(req, res));

        server.listen(CONFIG.PORT, CONFIG.HOST, () => {
            console.log('='.repeat(50));
            console.log('🚀 MixVibe Mirror Server');
            console.log('='.repeat(50));
            console.log(`📡 http://${CONFIG.DOMAIN}:${CONFIG.PORT}`);
            console.log(`🖥️  http://${CONFIG.DOMAIN}:${CONFIG.PORT}/admin`);
            console.log(`💾 ${CONFIG.DATA_DIR}`);
            console.log(`📦 ${this.storage.getAllBatchIds().length} batches`);
            console.log('='.repeat(50));
            console.log('✅ Batch data saves FIRST');
            console.log('✅ Additional data processes sequentially');
            console.log('='.repeat(50) + '\n');
            
            if (CONFIG.EXTRACT_INTERVAL > 0) {
                setInterval(() => this.extraction.extractAll().catch(console.error), CONFIG.EXTRACT_INTERVAL);
            }
        });

        process.on('SIGTERM', () => this.shutdown(server));
        process.on('SIGINT', () => this.shutdown(server));
    }

    shutdown(server) {
        server.close(() => { console.log('Server closed'); process.exit(0); });
        setTimeout(() => process.exit(1), 10000);
    }
}

// ==================== Startup ====================
const server = new MixVibeMirrorServer();
server.start().catch(console.error);
