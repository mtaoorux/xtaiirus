
// server.js – MixVibe Mirror Backend (No Limits Edition - Data Protected)
// Zero dependencies, Node.js 18+ required
// Run: node server.js
// Data stored in /data folder - Saves immediately

const http = require('http');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

// ==================== Configuration ====================
const CONFIG = {
    // Server
    PORT: process.env.PORT || 3000,
    HOST: process.env.HOST || '0.0.0.0',
    DOMAIN: process.env.DOMAIN || 'localhost',
    NODE_ENV: process.env.NODE_ENV || 'development',
    
    // Source
    MIXVIBE_BASE: process.env.MIXVIBE_BASE || 'https://pw.mixvibe.site',
    SECURITY_TOKEN: process.env.SECURITY_TOKEN || 'sdjfgeoriughdritvtiuohdorsiugh',
    FIREBASE_API_KEY: process.env.FIREBASE_API_KEY || 'AIzaSyC5gZ9DxjlabtJuDyIU1sY1yy1N7YVBdlU',
    MIXVIBE_EMAIL: process.env.MIXVIBE_EMAIL || 'vawig47668@hotkev.com',
    MIXVIBE_PASSWORD: process.env.MIXVIBE_PASSWORD || 'vawig47668@hotkev.com',
    
    // Storage
    DATA_DIR: process.env.DATA_DIR || path.join(__dirname, 'data'),
    PUBLIC_DIR: path.join(__dirname, 'public'),
    
    // NO LIMITS - Extract EVERYTHING
    MAX_CONCURRENT: parseInt(process.env.MAX_CONCURRENT || '10'),
    RETRY_ATTEMPTS: 5,
    RETRY_DELAY: 1000,
    REQUEST_DELAY: 100,
    
    // Auto extraction
    EXTRACT_INTERVAL: parseInt(process.env.EXTRACT_INTERVAL || '0'),
};

// ==================== Ensure directories exist ====================
const DATA_TYPES = ['batches', 'batchdetails', 'live', 'topics', 'content', 'meta'];
DATA_TYPES.forEach(dir => {
    const fullPath = path.join(CONFIG.DATA_DIR, dir);
    if (!fs.existsSync(fullPath)) {
        fs.mkdirSync(fullPath, { recursive: true });
        console.log(`📁 Created directory: ${fullPath}`);
    }
});

if (!fs.existsSync(CONFIG.PUBLIC_DIR)) {
    fs.mkdirSync(CONFIG.PUBLIC_DIR, { recursive: true });
    console.log(`📁 Created public directory: ${CONFIG.PUBLIC_DIR}`);
}

// ==================== Storage Layer ====================
class StorageManager {
    constructor(dataDir) {
        this.dataDir = dataDir;
        this.cache = new Map();
        this.index = {
            batches: [],
            batchDetails: {},
            live: {},
            topics: {},
            content: {}
        };
        this.ensureDirectories();
        this.rebuildIndex();
    }

    ensureDirectories() {
        DATA_TYPES.forEach(dir => {
            const fullPath = path.join(this.dataDir, dir);
            if (!fs.existsSync(fullPath)) {
                fs.mkdirSync(fullPath, { recursive: true });
            }
        });
    }

    rebuildIndex() {
        console.log('🔍 Scanning existing data files...');
        this.index = { batches: [], batchDetails: {}, live: {}, topics: {}, content: {} };
        
        DATA_TYPES.forEach(type => {
            if (type === 'meta') return;
            const dirPath = path.join(this.dataDir, type);
            if (fs.existsSync(dirPath)) {
                const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.json'));
                files.forEach(file => {
                    const id = file.replace('.json', '');
                    try {
                        const data = JSON.parse(fs.readFileSync(path.join(dirPath, file), 'utf8'));
                        if (type === 'batches') {
                            this.index.batches.push({
                                _id: id,
                                name: data.name || data.batchName || id,
                                timestamp: new Date().toISOString()
                            });
                        }
                    } catch(e) {
                        console.log(`⚠️ Error reading ${type}/${id}`);
                    }
                });
            }
        });
        
        console.log(`✅ Index built: ${this.index.batches.length} batches found`);
        this.saveIndex();
    }

    saveJSON(type, id, data) {
        const filePath = path.join(this.dataDir, type, `${id}.json`);
        
        // ✅ Always save data
        const isNew = !fs.existsSync(filePath);
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
        
        // Verify file was written
        if (fs.existsSync(filePath)) {
            const stats = fs.statSync(filePath);
            console.log(`   ${isNew ? '💾 Saved' : '🔄 Updated'}: ${type}/${id} (${(stats.size/1024).toFixed(1)} KB)`);
        } else {
            console.error(`   ❌ FAILED to save: ${type}/${id}`);
        }
        
        // Update index
        if (type === 'batches') {
            const existing = this.index.batches.findIndex(b => b._id === id);
            const batchEntry = {
                _id: id,
                name: data.name || data.batchName || id,
                timestamp: new Date().toISOString()
            };
            if (existing >= 0) {
                this.index.batches[existing] = batchEntry;
            } else {
                this.index.batches.push(batchEntry);
            }
        } else {
            if (!this.index[type]) this.index[type] = {};
            this.index[type][id] = {
                timestamp: new Date().toISOString(),
                size: JSON.stringify(data).length
            };
        }
        
        // Save index
        this.saveIndex();
        
        // Update cache
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
            } catch (e) {
                console.error(`Error loading ${type}/${id}:`, e.message);
            }
        }
        return null;
    }

    listJSON(type) {
        const dirPath = path.join(this.dataDir, type);
        if (!fs.existsSync(dirPath)) return [];
        
        const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.json'));
        const results = [];
        
        for (const file of files) {
            const data = this.loadJSON(type, file.replace('.json', ''));
            if (data) results.push(data);
        }
        
        return results;
    }

    getAllBatchIds() {
        if (this.index.batches.length > 0) {
            return this.index.batches.map(b => b._id);
        }
        
        // Fallback: scan directory
        const dir = path.join(this.dataDir, 'batches');
        if (fs.existsSync(dir)) {
            return fs.readdirSync(dir)
                .filter(f => f.endsWith('.json'))
                .map(f => f.replace('.json', ''));
        }
        
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
                files.forEach(f => {
                    try {
                        totalSize += fs.statSync(path.join(dirPath, f)).size;
                    } catch(e) {}
                });
                stats[type] = { count: files.length, size: totalSize };
            } else {
                stats[type] = { count: 0, size: 0 };
            }
        });
        return stats;
    }

    saveIndex() {
        const indexPath = path.join(this.dataDir, 'meta', 'index.json');
        fs.writeFileSync(indexPath, JSON.stringify(this.index, null, 2));
    }

    clearCache() {
        this.cache.clear();
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
            const resp = await fetch(
                `https://securetoken.googleapis.com/v1/token?key=${CONFIG.FIREBASE_API_KEY}`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: `grant_type=refresh_token&refresh_token=${this.tokens.refreshToken}`
                }
            );
            
            if (!resp.ok) return this.login();
            
            const data = await resp.json();
            this.tokens.idToken = data.id_token;
            this.tokens.refreshToken = data.refresh_token;
            return this.tokens.idToken;
        } catch (error) {
            return this.login();
        }
    }

    async login() {
        console.log('🔑 Logging into MixVibe...');
        const resp = await fetch(
            `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${CONFIG.FIREBASE_API_KEY}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    email: CONFIG.MIXVIBE_EMAIL,
                    password: CONFIG.MIXVIBE_PASSWORD,
                    returnSecureToken: true
                })
            }
        );
        
        if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            throw new Error(`Login failed: ${err.error?.message || resp.status}`);
        }
        
        const data = await resp.json();
        this.tokens.idToken = data.id_token;
        this.tokens.refreshToken = data.refresh_token;
        console.log('✅ Logged in successfully');
        return this.tokens.idToken;
    }
}

// ==================== API Client ====================
class MixVibeClient {
    constructor(authManager) {
        this.auth = authManager;
    }

    async apiCall(endpoint, retries = CONFIG.RETRY_ATTEMPTS) {
        let token = await this.auth.getToken();
        
        for (let attempt = 0; attempt <= retries; attempt++) {
            const headers = {
                'X-Security-Token': CONFIG.SECURITY_TOKEN,
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/json',
                'User-Agent': 'MixVibe-Mirror/2.0'
            };
            
            try {
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), 60000);
                
                const resp = await fetch(`${CONFIG.MIXVIBE_BASE}${endpoint}`, {
                    headers,
                    signal: controller.signal
                });
                
                clearTimeout(timeout);
                
                if (resp.status === 401) {
                    token = await this.auth.refreshToken();
                    continue;
                }
                
                if (resp.status === 429) {
                    const wait = Math.min(+(resp.headers.get('Retry-After') || 5), 15);
                    console.log(`⏳ Rate limited, waiting ${wait}s...`);
                    await new Promise(r => setTimeout(r, wait * 1000));
                    continue;
                }
                
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                
                return await resp.json();
            } catch (e) {
                if (e.name === 'AbortError') console.log(`Timeout: ${endpoint}`);
                if (attempt === retries) throw e;
                const delay = CONFIG.RETRY_DELAY * Math.pow(1.5, attempt);
                await new Promise(r => setTimeout(r, delay));
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
            startTime: null,
            processed: 0,
            total: 0,
            currentBatch: '',
            errors: [],
            warnings: [],
            lastRun: null,
            totalSubjects: 0,
            totalTopics: 0,
            totalContent: 0
        };
    }

    async extractAll() {
        if (this.running) throw new Error('Extraction already in progress');

        this.running = true;
        this.stats = {
            startTime: new Date().toISOString(),
            processed: 0,
            total: 0,
            currentBatch: '',
            errors: [],
            warnings: [],
            lastRun: null,
            totalSubjects: 0,
            totalTopics: 0,
            totalContent: 0
        };

        extractionEvents.emit('extraction:start', this.stats);

        try {
            console.log('\n🚀 Starting extraction...');
            const { batches } = await this.client.apiCall('/api/batches');
            
            if (!batches || !Array.isArray(batches)) {
                throw new Error('Invalid batches response');
            }

            console.log(`📦 Source has ${batches.length} batches`);
            
            if (batches.length === 0) {
                console.log('No batches to process');
                extractionEvents.emit('extraction:complete', this.stats);
                return { added: 0, total: 0 };
            }

            this.stats.total = batches.length;

            // Process ALL batches
            const chunks = this.chunkArray(batches, CONFIG.MAX_CONCURRENT);
            
            for (const chunk of chunks) {
                await Promise.allSettled(
                    chunk.map(batch => this.processBatchComplete(batch))
                );
                await new Promise(r => setTimeout(r, CONFIG.REQUEST_DELAY));
            }

            // Save final stats
            this.stats.lastRun = new Date().toISOString();
            this.storage.saveJSON('meta', 'extraction-stats', this.stats);
            this.storage.saveIndex();

            console.log(`\n✅ Extraction complete!`);
            console.log(`   Processed: ${this.stats.processed} batches`);
            console.log(`   Subjects: ${this.stats.totalSubjects}`);
            console.log(`   Topics: ${this.stats.totalTopics}`);
            console.log(`   Content: ${this.stats.totalContent}`);
            console.log(`   Storage: ${this.storage.getAllBatchIds().length} total batches\n`);
            
            extractionEvents.emit('extraction:complete', this.stats);

            return { added: this.stats.processed, total: batches.length, stats: this.stats };
            
        } catch (error) {
            console.error('❌ Extraction failed:', error.message);
            this.stats.errors.push(error.message);
            extractionEvents.emit('extraction:error', error);
            throw error;
        } finally {
            this.running = false;
        }
    }

    async processBatchComplete(batch) {
        try {
            this.stats.currentBatch = batch.name || batch._id;
            console.log(`\n📦 [${this.stats.processed + 1}/${this.stats.total}] ${batch.name || batch._id}`);

            // Save batch immediately
            this.storage.saveJSON('batches', batch._id, batch);

            // Fetch live classes
            await this.fetchAllLive(batch._id);
            await new Promise(r => setTimeout(r, CONFIG.REQUEST_DELAY));

            // Fetch batch details
            const details = await this.fetchBatchDetails(batch._id);
            
            if (details && details.data && details.data.subjects) {
                const subjects = details.data.subjects;
                console.log(`  📚 ${subjects.length} subjects`);
                
                for (const subject of subjects) {
                    await this.fetchAllTopics(batch._id, subject);
                    this.stats.totalSubjects++;
                    await new Promise(r => setTimeout(r, CONFIG.REQUEST_DELAY));
                }
            }

            this.stats.processed++;
            extractionEvents.emit('extraction:progress', this.stats);

        } catch (error) {
            console.error(`  ❌ Error: ${error.message}`);
            this.stats.errors.push(`Batch ${batch._id}: ${error.message}`);
        }
    }

    async fetchAllLive(batchId) {
        try {
            const liveData = await this.client.apiCall(`/api/live?batchId=${batchId}`);
            if (liveData?.data?.length > 0) {
                this.storage.saveJSON('live', batchId, liveData);
                console.log(`  📡 Live: ${liveData.data.length}`);
            }
        } catch (error) {
            this.stats.warnings.push(`Live: ${error.message}`);
        }
    }

    async fetchBatchDetails(batchId) {
        try {
            const details = await this.client.apiCall(`/api/batchdetails?batchId=${batchId}`);
            if (details?.success && details.data) {
                this.storage.saveJSON('batchdetails', batchId, details);
                return details;
            }
        } catch (error) {
            this.stats.warnings.push(`Details: ${error.message}`);
        }
        return null;
    }

    async fetchAllTopics(batchId, subject) {
        try {
            const topicData = await this.client.apiCall(
                `/api/topics?batchId=${batchId}&subjectId=${subject._id}`
            );
            
            if (topicData?.success && topicData.data) {
                const key = `${batchId}_${subject._id}`;
                this.storage.saveJSON('topics', key, topicData);
                
                const topics = topicData.data;
                console.log(`    📖 ${subject.name}: ${topics.length} topics`);
                
                for (const topic of topics) {
                    await this.fetchAllContent(batchId, subject._id, topic._id);
                    this.stats.totalTopics++;
                    await new Promise(r => setTimeout(r, CONFIG.REQUEST_DELAY));
                }
            }
        } catch (error) {
            this.stats.warnings.push(`Topics: ${error.message}`);
        }
    }

    async fetchAllContent(batchId, subjectId, topicId) {
        const contentTypes = ['videos', 'notes', 'dpp'];
        
        for (const type of contentTypes) {
            try {
                const content = await this.client.apiCall(
                    `/api/content?batchId=${batchId}&subjectId=${subjectId}&topicId=${topicId}&contentType=${type}`
                );
                
                if (content?.success && content.data?.length > 0) {
                    const key = `${batchId}_${subjectId}_${topicId}_${type}`;
                    this.storage.saveJSON('content', key, content);
                    this.stats.totalContent++;
                    console.log(`      📄 ${type}: ${content.data.length} items`);
                }
            } catch (error) {
                // Silently continue
            }
            await new Promise(r => setTimeout(r, CONFIG.REQUEST_DELAY));
        }
    }

    chunkArray(array, size) {
        const chunks = [];
        for (let i = 0; i < array.length; i += size) {
            chunks.push(array.slice(i, i + size));
        }
        return chunks;
    }

    getStatus() {
        return {
            running: this.running,
            stats: this.stats
        };
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
        // API Routes
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
        
        // Static files
        this.addRoute('GET', '/', this.serveAdminHTML.bind(this));
        this.addRoute('GET', '/admin', this.serveAdminHTML.bind(this));
    }

    addRoute(method, path, handler) {
        if (!this.routes.has(method)) this.routes.set(method, new Map());
        this.routes.get(method).set(path, handler);
    }

    serveFile(filePath, contentType, res) {
        try {
            if (!fs.existsSync(filePath)) {
                res.writeHead(404);
                res.end('File not found');
                return;
            }
            const content = fs.readFileSync(filePath);
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(content);
        } catch (e) {
            res.writeHead(500);
            res.end('Error loading file');
        }
    }

    async handleStatic(req, res) {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const pathname = url.pathname;
        
        const mimeTypes = {
            '.html': 'text/html',
            '.css': 'text/css',
            '.js': 'application/javascript',
            '.json': 'application/json',
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.svg': 'image/svg+xml',
            '.ico': 'image/x-icon',
        };
        
        const ext = path.extname(pathname);
        const contentType = mimeTypes[ext] || 'text/plain';
        const safePath = path.normalize(path.join(CONFIG.PUBLIC_DIR, pathname));
        
        if (!safePath.startsWith(CONFIG.PUBLIC_DIR)) {
            res.writeHead(403);
            res.end('Forbidden');
            return;
        }
        
        this.serveFile(safePath, contentType, res);
    }

    async handleRequest(req, res) {
        const clientIP = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
        
        if (!this.rateLimiter.isAllowed(clientIP)) {
            res.writeHead(429, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Too many requests', retryAfter: 30 }));
            return;
        }

        const url = new URL(req.url, `http://${req.headers.host}`);
        const method = req.method;
        const pathname = url.pathname;

        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        res.setHeader('X-Powered-By', 'MixVibe Mirror');

        if (method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }

        const methodRoutes = this.routes.get(method);
        if (methodRoutes) {
            const handler = methodRoutes.get(pathname);
            if (handler) {
                try {
                    await handler(req, res, url.searchParams);
                } catch (error) {
                    console.error('Route error:', error);
                    this.sendError(res, 500, 'Internal server error');
                }
                return;
            }
        }

        if (method === 'GET') {
            await this.handleStatic(req, res);
            return;
        }

        this.sendError(res, 404, 'Not found');
    }

    async serveAdminHTML(req, res, params) {
        const filePath = path.join(CONFIG.PUBLIC_DIR, 'admin.html');
        if (!fs.existsSync(filePath)) {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(this.getFallbackHTML());
            return;
        }
        this.serveFile(filePath, 'text/html', res);
    }

    getFallbackHTML() {
        return `<!DOCTYPE html>
<html>
<head>
    <title>MixVibe Mirror</title>
    <style>
        body { font-family: system-ui; background: #0d1117; color: #c9d1d9; padding: 2rem; }
        button { padding: 1rem 2rem; background: #238636; color: white; border: none; border-radius: 8px; cursor: pointer; font-size: 1rem; margin: 0.5rem; }
        button:hover { background: #2ea043; }
        button:disabled { opacity: 0.5; }
        .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 1rem; margin: 2rem 0; }
        .stat { background: #161b22; padding: 1rem; border-radius: 8px; text-align: center; }
        .stat-value { font-size: 2rem; color: #58a6ff; font-weight: bold; }
        .stat-label { color: #8b949e; margin-top: 0.3rem; font-size: 0.8rem; }
        .terminal { background: #000; color: #00ff00; padding: 1rem; border-radius: 8px; font-family: monospace; max-height: 300px; overflow-y: auto; margin-top: 1rem; }
    </style>
</head>
<body>
    <h1>🚀 MixVibe Mirror</h1>
    <p>Place admin.html, style.css, script.js in /public folder for full admin panel</p>
    <div class="stats">
        <div class="stat"><div class="stat-value" id="batches">-</div><div class="stat-label">Batches</div></div>
        <div class="stat"><div class="stat-value" id="content">-</div><div class="stat-label">Content</div></div>
    </div>
    <button onclick="extract()">🔄 Extract</button>
    <button onclick="loadStats()">🔃 Refresh</button>
    <div id="status"></div>
    <div class="terminal" id="terminal"><div>> Ready...</div></div>
    <script>
        async function loadStats() {
            const r = await fetch('/api/stats');
            const d = await r.json();
            document.getElementById('batches').textContent = d.files.batches?.count || 0;
            document.getElementById('content').textContent = d.files.content?.count || 0;
        }
        async function extract() {
            document.querySelector('button').disabled = true;
            document.getElementById('status').textContent = 'Extracting...';
            document.getElementById('terminal').innerHTML += '<div>> Starting extraction...</div>';
            try {
                await fetch('/api/extract', { method: 'POST' });
                document.getElementById('terminal').innerHTML += '<div>> ✅ Done!</div>';
            } catch(e) {
                document.getElementById('terminal').innerHTML += '<div>> ❌ Error: ' + e.message + '</div>';
            }
            document.querySelector('button').disabled = false;
            document.getElementById('status').textContent = '';
            loadStats();
        }
        loadStats();
        setInterval(loadStats, 5000);
    </script>
</body>
</html>`;
    }

    async handleGetBatches(req, res, params) {
        const page = parseInt(params.get('page') || '1');
        const limit = parseInt(params.get('limit') || '0');
        const search = params.get('search')?.toLowerCase();
        
        let batches = this.storage.listJSON('batches');
        
        if (search) {
            batches = batches.filter(b => 
                b.name?.toLowerCase().includes(search) ||
                b.description?.toLowerCase().includes(search)
            );
        }
        
        const total = batches.length;
        
        if (limit > 0) {
            const start = (page - 1) * limit;
            batches = batches.slice(start, start + limit);
        }
        
        this.sendJSON(res, {
            success: true,
            batches,
            pagination: { page, limit: limit || total, total, pages: limit > 0 ? Math.ceil(total / limit) : 1 },
            timestamp: new Date().toISOString()
        });
    }

    async handleGetBatchDetails(req, res, params) {
        const batchId = params.get('batchId');
        if (!batchId) return this.sendError(res, 400, 'batchId is required');
        
        const details = this.storage.loadJSON('batchdetails', batchId);
        if (!details) return this.sendError(res, 404, 'Batch details not found');
        
        this.sendJSON(res, details);
    }

    async handleGetLive(req, res, params) {
        const batchId = params.get('batchId');
        if (!batchId) return this.sendError(res, 400, 'batchId is required');
        
        const live = this.storage.loadJSON('live', batchId);
        this.sendJSON(res, live || { data: [] });
    }

    async handleGetTopics(req, res, params) {
        const { batchId, subjectId } = params;
        if (!batchId || !subjectId) return this.sendError(res, 400, 'batchId and subjectId required');
        
        const key = `${batchId}_${subjectId}`;
        const topics = this.storage.loadJSON('topics', key);
        this.sendJSON(res, topics || { success: false, data: [] });
    }

    async handleGetContent(req, res, params) {
        const { batchId, subjectId, topicId, contentType } = params;
        if (!batchId || !subjectId || !topicId || !contentType) {
            return this.sendError(res, 400, 'All parameters required');
        }
        
        const key = `${batchId}_${subjectId}_${topicId}_${contentType}`;
        const content = this.storage.loadJSON('content', key);
        this.sendJSON(res, content || { success: false, data: [] });
    }

    async handleGetStats(req, res, params) {
        const fileStats = this.storage.getStats();
        const extractionStatus = this.extraction.getStatus();
        
        let totalSize = 0;
        Object.values(fileStats).forEach(stat => totalSize += stat.size);
        
        this.sendJSON(res, {
            success: true,
            files: fileStats,
            totalSize: {
                bytes: totalSize,
                mb: (totalSize / (1024 * 1024)).toFixed(2),
                gb: (totalSize / (1024 * 1024 * 1024)).toFixed(2)
            },
            extraction: extractionStatus,
            dataProtected: true,
            server: {
                uptime: process.uptime(),
                memory: process.memoryUsage(),
                nodeVersion: process.version,
                platform: process.platform
            }
        });
    }

    async handleExtract(req, res, params) {
        try {
            if (this.extraction.running) return this.sendError(res, 409, 'Extraction already running');
            
            this.extraction.extractAll().catch(err => console.error('Background extraction error:', err));
            
            this.sendJSON(res, {
                success: true,
                message: 'Extraction started - data will be saved immediately',
                timestamp: new Date().toISOString()
            });
        } catch (error) {
            this.sendError(res, 500, error.message);
        }
    }

    async handleExtractAll(req, res, params) {
        try {
            if (this.extraction.running) return this.sendError(res, 409, 'Extraction already running');
            
            this.extraction.extractAll().catch(err => console.error('Background extraction error:', err));
            
            this.sendJSON(res, {
                success: true,
                message: 'Full extraction started',
                timestamp: new Date().toISOString()
            });
        } catch (error) {
            this.sendError(res, 500, error.message);
        }
    }

    async handleSearch(req, res, params) {
        const query = params.get('q')?.toLowerCase();
        if (!query) return this.sendError(res, 400, 'Search query required');
        
        const results = { batches: [], subjects: [], topics: [] };
        
        const batches = this.storage.listJSON('batches');
        for (const batch of batches) {
            if (batch.name?.toLowerCase().includes(query) || batch.description?.toLowerCase().includes(query)) {
                results.batches.push(batch);
            }
        }
        
        this.sendJSON(res, {
            success: true,
            query,
            results,
            total: Object.values(results).reduce((sum, arr) => sum + arr.length, 0)
        });
    }

    async handleExport(req, res, params) {
        const type = params.get('type') || 'all';
        
        try {
            const exportData = {
                metadata: { exportedAt: new Date().toISOString(), version: '2.0', type }
            };
            
            if (type === 'all' || type === 'batches') exportData.batches = this.storage.listJSON('batches');
            if (type === 'all' || type === 'batchdetails') exportData.batchDetails = this.storage.listJSON('batchdetails');
            if (type === 'all' || type === 'content') exportData.content = this.storage.listJSON('content');
            
            res.writeHead(200, {
                'Content-Type': 'application/json',
                'Content-Disposition': `attachment; filename=mixvibe-export-${Date.now()}.json`
            });
            res.end(JSON.stringify(exportData, null, 2));
        } catch (error) {
            this.sendError(res, 500, 'Export failed: ' + error.message);
        }
    }

    async handleHealth(req, res, params) {
        this.sendJSON(res, {
            status: 'ok',
            timestamp: new Date().toISOString(),
            extraction: this.extraction.running ? 'running' : 'idle',
            storage: this.storage.getStats()
        });
    }

    sendJSON(res, data, statusCode = 200) {
        const json = JSON.stringify(data, null, CONFIG.NODE_ENV === 'development' ? 2 : 0);
        res.writeHead(statusCode, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-cache',
            'Content-Length': Buffer.byteLength(json)
        });
        res.end(json);
    }

    sendError(res, statusCode, message) {
        this.sendJSON(res, { success: false, error: message, timestamp: new Date().toISOString() }, statusCode);
    }
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
        // Load existing stats
        const stats = this.storage.loadJSON('meta', 'extraction-stats');
        if (stats) {
            this.extraction.stats = stats;
        }

        const server = http.createServer((req, res) => {
            this.router.handleRequest(req, res);
        });

        server.listen(CONFIG.PORT, CONFIG.HOST, () => {
            console.log('\n' + '='.repeat(60));
            console.log('🚀 MixVibe Mirror Server - READY');
            console.log('='.repeat(60));
            console.log(`📡 Server: http://${CONFIG.DOMAIN}:${CONFIG.PORT}`);
            console.log(`🖥️  Admin: http://${CONFIG.DOMAIN}:${CONFIG.PORT}/admin`);
            console.log(`💾 Storage: ${CONFIG.DATA_DIR}`);
            console.log(`📦 Batches: ${this.storage.getAllBatchIds().length}`);
            console.log('='.repeat(60));
            console.log('💡 Data saves immediately after extraction');
            console.log('💡 Check /api/batches to see your data');
            console.log('='.repeat(60) + '\n');
            
            if (CONFIG.EXTRACT_INTERVAL > 0) {
                console.log(`⏰ Auto-extraction every ${CONFIG.EXTRACT_INTERVAL}ms`);
                setInterval(() => this.extraction.extractAll().catch(console.error), CONFIG.EXTRACT_INTERVAL);
            }
        });

        process.on('SIGTERM', () => this.shutdown(server));
        process.on('SIGINT', () => this.shutdown(server));
    }

    shutdown(server) {
        console.log('\nShutting down...');
        server.close(() => {
            console.log('Server closed');
            process.exit(0);
        });
        setTimeout(() => process.exit(1), 10000);
    }
}

// ==================== Startup ====================
console.log('🔧 Initializing MixVibe Mirror Server...\n');
const server = new MixVibeMirrorServer();
server.start().catch(console.error);
