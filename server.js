// server.js – MixVibe Mirror Backend (No Limits Edition - Data Protected)
// Zero dependencies, Node.js 18+ required
// Run: node server.js
// Data stored in /data folder - NEVER overwritten or deleted

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

// ==================== Configuration ====================
const CONFIG = {
    // Server
    PORT: process.env.PORT || 3000,
    HOST: process.env.HOST || '0.0.0.0',
    DOMAIN: process.env.DOMAIN || 'localhost',
    NODE_ENV: process.env.NODE_ENV || 'development',
    
    // SSL (for production)
    SSL_ENABLED: process.env.SSL_ENABLED === 'true',
    SSL_KEY: process.env.SSL_KEY_PATH || path.join(__dirname, 'certs', 'privkey.pem'),
    SSL_CERT: process.env.SSL_CERT_PATH || path.join(__dirname, 'certs', 'fullchain.pem'),
    
    // Source
    MIXVIBE_BASE: process.env.MIXVIBE_BASE || 'https://pw.mixvibe.site',
    SECURITY_TOKEN: process.env.SECURITY_TOKEN || 'sdjfgeoriughdritvtiuohdorsiugh',
    FIREBASE_API_KEY: process.env.FIREBASE_API_KEY || 'AIzaSyC5gZ9DxjlabtJuDyIU1sY1yy1N7YVBdlU',
    MIXVIBE_EMAIL: process.env.MIXVIBE_EMAIL || 'vawig47668@hotkev.com',
    MIXVIBE_PASSWORD: process.env.MIXVIBE_PASSWORD || 'vawig47668@hotkev.com',
    
    // Storage
    DATA_DIR: process.env.DATA_DIR || path.join(__dirname, 'data'),
    
    // NO LIMITS - Extract EVERYTHING
    MAX_CONCURRENT: parseInt(process.env.MAX_CONCURRENT || '10'),
    RETRY_ATTEMPTS: 5,
    RETRY_DELAY: 1000,
    REQUEST_DELAY: 100,
    
    // Auto extraction (disabled by default, enable with env var)
    EXTRACT_INTERVAL: parseInt(process.env.EXTRACT_INTERVAL || '0'),
};

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
        this.loadIndex();
    }

    ensureDirectories() {
        const dirs = ['batches', 'batchdetails', 'live', 'topics', 'content', 'meta'];
        dirs.forEach(dir => {
            const fullPath = path.join(this.dataDir, dir);
            if (!fs.existsSync(fullPath)) {
                fs.mkdirSync(fullPath, { recursive: true });
            }
        });
    }

    saveJSON(type, id, data) {
        const filePath = path.join(this.dataDir, type, `${id}.json`);
        
        // 🔒 NEVER OVERWRITE EXISTING DATA
        if (fs.existsSync(filePath)) {
            return; // Skip - data already saved
        }
        
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
        
        // Update index
        if (type === 'batches') {
            const existing = this.index.batches.findIndex(b => b._id === id);
            if (existing >= 0) {
                this.index.batches[existing] = data;
            } else {
                this.index.batches.push({ _id: id, name: data.name, timestamp: new Date().toISOString() });
            }
        } else {
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
        // Check cache first
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
        return this.index.batches.map(b => b._id);
    }

    getStats() {
        const stats = {};
        const types = ['batches', 'batchdetails', 'live', 'topics', 'content'];
        
        types.forEach(type => {
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

    loadIndex() {
        const indexPath = path.join(this.dataDir, 'meta', 'index.json');
        if (fs.existsSync(indexPath)) {
            try {
                this.index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
            } catch(e) {
                console.log('Error loading index, starting fresh');
            }
        }
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
        const clientData = this.clients.get(clientIP) || { requests: [], blocked: false };

        clientData.requests = clientData.requests.filter(time => now - time < this.windowMs);

        if (clientData.requests.length >= this.maxRequests) {
            return false;
        }

        clientData.requests.push(now);
        this.clients.set(clientIP, clientData);
        return true;
    }

    cleanup() {
        const now = Date.now();
        for (const [ip, data] of this.clients.entries()) {
            data.requests = data.requests.filter(time => now - time < this.windowMs);
            if (data.requests.length === 0) {
                this.clients.delete(ip);
            }
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
        if (!this.tokens.idToken) {
            await this.login();
        }
        return this.tokens.idToken;
    }

    async refreshToken() {
        if (!this.tokens.refreshToken) {
            console.log('No refresh token – doing full login');
            return this.login();
        }
        
        console.log('Refreshing auth token...');
        try {
            const resp = await fetch(
                `https://securetoken.googleapis.com/v1/token?key=${CONFIG.FIREBASE_API_KEY}`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: `grant_type=refresh_token&refresh_token=${this.tokens.refreshToken}`
                }
            );
            
            if (!resp.ok) {
                console.log('Refresh failed – re‑logging in');
                return this.login();
            }
            
            const data = await resp.json();
            this.tokens.idToken = data.id_token;
            this.tokens.refreshToken = data.refresh_token;
            console.log('Auth token refreshed successfully');
            return this.tokens.idToken;
        } catch (error) {
            console.error('Refresh error:', error.message);
            return this.login();
        }
    }

    async login() {
        console.log('Logging into MixVibe...');
        try {
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
            console.log('Successfully logged in');
            return this.tokens.idToken;
        } catch (error) {
            console.error('Login error:', error.message);
            throw error;
        }
    }
}

// ==================== API Client ====================
class MixVibeClient {
    constructor(authManager) {
        this.auth = authManager;
        this.requestCount = 0;
        this.lastRequestTime = Date.now();
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
                this.requestCount++;
                
                if (resp.status === 401) {
                    console.log('Auth expired – refreshing token');
                    token = await this.auth.refreshToken();
                    continue;
                }
                
                if (resp.status === 429) {
                    const wait = Math.min(+(resp.headers.get('Retry-After') || 5), 15);
                    console.log(`Rate limited, waiting ${wait}s...`);
                    await new Promise(r => setTimeout(r, wait * 1000));
                    continue;
                }
                
                if (!resp.ok) {
                    throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
                }
                
                const data = await resp.json();
                return data;
            } catch (e) {
                if (e.name === 'AbortError') {
                    console.log(`Request timeout for ${endpoint}`);
                }
                if (attempt === retries) throw e;
                const delay = CONFIG.RETRY_DELAY * Math.pow(1.5, attempt);
                console.log(`Retry ${attempt + 1}/${retries} after ${delay}ms...`);
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
        if (this.running) {
            throw new Error('Extraction already in progress');
        }

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
            console.log('🚀 Starting extraction (NEW BATCHES ONLY)...');
            const { batches } = await this.client.apiCall('/api/batches');
            
            if (!batches || !Array.isArray(batches)) {
                throw new Error('Invalid batches response');
            }

            console.log(`Found ${batches.length} total batches in source`);
            
            // 🔒 ONLY extract NEW batches - never re-process existing ones
            const existingIds = new Set(this.storage.getAllBatchIds());
            const newBatches = batches.filter(b => !existingIds.has(b._id));

            if (newBatches.length === 0) {
                console.log('✅ No new batches to extract. All data is safe!');
                this.stats.total = batches.length;
                this.stats.processed = batches.length;
                extractionEvents.emit('extraction:complete', this.stats);
                return { added: 0, total: batches.length };
            }

            console.log(`🆕 Found ${newBatches.length} NEW batches to extract`);
            this.stats.total = newBatches.length;

            // Process ONLY new batches with high concurrency
            const chunks = this.chunkArray(newBatches, CONFIG.MAX_CONCURRENT);
            
            for (const chunk of chunks) {
                await Promise.allSettled(
                    chunk.map(batch => this.processBatchComplete(batch))
                );
                await new Promise(r => setTimeout(r, CONFIG.REQUEST_DELAY));
            }

            // Save stats
            this.stats.lastRun = new Date().toISOString();
            this.storage.saveJSON('meta', 'extraction-stats', this.stats);

            console.log(`✅ Extraction complete: ${this.stats.processed} new batches processed`);
            console.log(`💾 Total batches in storage: ${this.storage.getAllBatchIds().length}`);
            console.log(`   Subjects: ${this.stats.totalSubjects}, Topics: ${this.stats.totalTopics}, Content: ${this.stats.totalContent}`);
            
            extractionEvents.emit('extraction:complete', this.stats);

            return {
                added: newBatches.length,
                total: batches.length,
                stats: this.stats
            };
        } catch (error) {
            console.error('Extraction failed:', error);
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
            console.log(`\n📦 Processing: ${batch.name} (${this.stats.processed + 1}/${this.stats.total})`);

            // Save batch (will skip if already exists)
            this.storage.saveJSON('batches', batch._id, batch);

            // Fetch live classes
            await this.fetchAllLive(batch._id);
            await new Promise(r => setTimeout(r, CONFIG.REQUEST_DELAY));

            // Fetch ALL batch details (subjects)
            const details = await this.fetchBatchDetails(batch._id);
            
            if (details && details.data && details.data.subjects) {
                const subjects = details.data.subjects;
                console.log(`  📚 Found ${subjects.length} subjects`);
                
                for (const subject of subjects) {
                    await this.fetchAllTopics(batch._id, subject);
                    this.stats.totalSubjects++;
                    await new Promise(r => setTimeout(r, CONFIG.REQUEST_DELAY));
                }
            }

            this.stats.processed++;
            extractionEvents.emit('extraction:progress', this.stats);

        } catch (error) {
            console.error(`Error processing batch ${batch._id}:`, error.message);
            this.stats.errors.push(`Batch ${batch._id}: ${error.message}`);
        }
    }

    async fetchAllLive(batchId) {
        try {
            const liveData = await this.client.apiCall(`/api/live?batchId=${batchId}`);
            if (liveData && liveData.data && liveData.data.length > 0) {
                this.storage.saveJSON('live', batchId, liveData);
                console.log(`  📡 Live classes: ${liveData.data.length}`);
            }
        } catch (error) {
            this.stats.warnings.push(`Live fetch for ${batchId}: ${error.message}`);
        }
    }

    async fetchBatchDetails(batchId) {
        try {
            const details = await this.client.apiCall(`/api/batchdetails?batchId=${batchId}`);
            if (details && details.success && details.data) {
                this.storage.saveJSON('batchdetails', batchId, details);
                return details;
            }
        } catch (error) {
            this.stats.warnings.push(`Details fetch for ${batchId}: ${error.message}`);
        }
        return null;
    }

    async fetchAllTopics(batchId, subject) {
        try {
            const topicData = await this.client.apiCall(
                `/api/topics?batchId=${batchId}&subjectId=${subject._id}`
            );
            
            if (topicData && topicData.success && topicData.data) {
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
            this.stats.warnings.push(`Topics fetch for ${batchId}/${subject._id}: ${error.message}`);
        }
    }

    async fetchAllContent(batchId, subjectId, topicId) {
        const contentTypes = ['videos', 'notes', 'dpp'];
        
        for (const type of contentTypes) {
            try {
                const content = await this.client.apiCall(
                    `/api/content?batchId=${batchId}&subjectId=${subjectId}&topicId=${topicId}&contentType=${type}`
                );
                
                if (content && content.success && content.data && content.data.length > 0) {
                    const key = `${batchId}_${subjectId}_${topicId}_${type}`;
                    this.storage.saveJSON('content', key, content);
                    this.stats.totalContent++;
                    console.log(`      📄 ${type}: ${content.data.length} items`);
                }
            } catch (error) {
                // Silently continue for individual content failures
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
        // API Routes only - NO admin routes
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
        
        // Home route - simple JSON status
        this.addRoute('GET', '/', this.handleHome.bind(this));
    }

    addRoute(method, path, handler) {
        if (!this.routes.has(method)) {
            this.routes.set(method, new Map());
        }
        this.routes.get(method).set(path, handler);
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

        // CORS headers
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        res.setHeader('X-Powered-By', 'MixVibe Mirror - Unlimited Edition');
        res.setHeader('X-Content-Type-Options', 'nosniff');

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
                    console.error('Route handler error:', error);
                    this.sendError(res, 500, 'Internal server error');
                }
                return;
            }
        }

        this.sendError(res, 404, 'Not found');
    }

    async handleHome(req, res, params) {
        const fileStats = this.storage.getStats();
        let totalSize = 0;
        Object.values(fileStats).forEach(stat => totalSize += stat.size);
        
        this.sendJSON(res, {
            name: 'MixVibe Mirror API',
            version: '2.0',
            status: 'running',
            dataProtected: true,
            stats: {
                batches: fileStats.batches?.count || 0,
                content: fileStats.content?.count || 0,
                totalSizeMB: (totalSize / (1024 * 1024)).toFixed(2)
            },
            endpoints: {
                batches: '/api/batches',
                batchDetails: '/api/batchdetails?batchId=',
                live: '/api/live?batchId=',
                topics: '/api/topics?batchId=&subjectId=',
                content: '/api/content?batchId=&subjectId=&topicId=&contentType=',
                stats: '/api/stats',
                extract: 'POST /api/extract',
                extractAll: 'POST /api/extract-all',
                search: '/api/search?q=',
                export: '/api/export',
                health: '/health'
            }
        });
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
            pagination: {
                page,
                limit: limit || total,
                total,
                pages: limit > 0 ? Math.ceil(total / limit) : 1
            },
            timestamp: new Date().toISOString()
        });
    }

    async handleGetBatchDetails(req, res, params) {
        const batchId = params.get('batchId');
        if (!batchId) {
            return this.sendError(res, 400, 'batchId is required');
        }
        
        const details = this.storage.loadJSON('batchdetails', batchId);
        if (!details) {
            return this.sendError(res, 404, 'Batch details not found');
        }
        
        this.sendJSON(res, details);
    }

    async handleGetLive(req, res, params) {
        const batchId = params.get('batchId');
        if (!batchId) {
            return this.sendError(res, 400, 'batchId is required');
        }
        
        const live = this.storage.loadJSON('live', batchId);
        this.sendJSON(res, live || { data: [] });
    }

    async handleGetTopics(req, res, params) {
        const batchId = params.get('batchId');
        const subjectId = params.get('subjectId');
        
        if (!batchId || !subjectId) {
            return this.sendError(res, 400, 'batchId and subjectId are required');
        }
        
        const key = `${batchId}_${subjectId}`;
        const topics = this.storage.loadJSON('topics', key);
        this.sendJSON(res, topics || { success: false, data: [] });
    }

    async handleGetContent(req, res, params) {
        const batchId = params.get('batchId');
        const subjectId = params.get('subjectId');
        const topicId = params.get('topicId');
        const contentType = params.get('contentType');
        
        if (!batchId || !subjectId || !topicId || !contentType) {
            return this.sendError(res, 400, 'All parameters are required');
        }
        
        const key = `${batchId}_${subjectId}_${topicId}_${contentType}`;
        const content = this.storage.loadJSON('content', key);
        this.sendJSON(res, content || { success: false, data: [] });
    }

    async handleGetStats(req, res, params) {
        const fileStats = this.storage.getStats();
        const extractionStatus = this.extraction.getStatus();
        
        let totalSize = 0;
        Object.values(fileStats).forEach(stat => {
            totalSize += stat.size;
        });
        
        const stats = {
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
        };
        
        this.sendJSON(res, stats);
    }

    async handleExtract(req, res, params) {
        try {
            if (this.extraction.running) {
                return this.sendError(res, 409, 'Extraction already in progress');
            }
            
            this.extraction.extractAll().catch(err => {
                console.error('Background extraction error:', err);
            });
            
            this.sendJSON(res, {
                success: true,
                message: 'Extraction started - only new batches will be added, existing data is safe',
                timestamp: new Date().toISOString()
            });
        } catch (error) {
            this.sendError(res, 500, error.message);
        }
    }

    async handleExtractAll(req, res, params) {
        try {
            if (this.extraction.running) {
                return this.sendError(res, 409, 'Extraction already in progress');
            }
            
            this.extraction.extractAll().catch(err => {
                console.error('Background extraction error:', err);
            });
            
            this.sendJSON(res, {
                success: true,
                message: 'Full extraction started - only new content will be added, nothing will be overwritten',
                timestamp: new Date().toISOString()
            });
        } catch (error) {
            this.sendError(res, 500, error.message);
        }
    }

    async handleSearch(req, res, params) {
        const query = params.get('q')?.toLowerCase();
        const type = params.get('type') || 'all';
        
        if (!query) {
            return this.sendError(res, 400, 'Search query is required');
        }
        
        const results = {
            batches: [],
            subjects: [],
            topics: []
        };
        
        const batches = this.storage.listJSON('batches');
        for (const batch of batches) {
            if (batch.name?.toLowerCase().includes(query) ||
                batch.description?.toLowerCase().includes(query)) {
                results.batches.push(batch);
            }
        }
        
        const batchDetailsList = this.storage.listJSON('batchdetails');
        for (const details of batchDetailsList) {
            if (details.data?.subjects) {
                for (const subject of details.data.subjects) {
                    if (subject.name?.toLowerCase().includes(query)) {
                        results.subjects.push({
                            ...subject,
                            batchId: details.data._id
                        });
                    }
                }
            }
        }
        
        this.sendJSON(res, {
            success: true,
            query,
            results: type === 'all' ? results : results[type] || [],
            total: Object.values(results).reduce((sum, arr) => sum + arr.length, 0)
        });
    }

    async handleExport(req, res, params) {
        const format = params.get('format') || 'json';
        const type = params.get('type') || 'all';
        
        try {
            const exportData = {
                metadata: {
                    exportedAt: new Date().toISOString(),
                    version: '2.0',
                    type: type
                }
            };
            
            if (type === 'all' || type === 'batches') {
                exportData.batches = this.storage.listJSON('batches');
            }
            if (type === 'all' || type === 'batchdetails') {
                exportData.batchDetails = this.storage.listJSON('batchdetails');
            }
            if (type === 'all' || type === 'content') {
                exportData.content = this.storage.listJSON('content');
            }
            
            if (format === 'json') {
                res.writeHead(200, {
                    'Content-Type': 'application/json',
                    'Content-Disposition': `attachment; filename=mixvibe-export-${Date.now()}.json`
                });
                res.end(JSON.stringify(exportData, null, 2));
            } else {
                this.sendError(res, 400, 'Unsupported format');
            }
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
            'Cache-Control': 'public, max-age=60',
            'Content-Length': Buffer.byteLength(json)
        });
        res.end(json);
    }

    sendError(res, statusCode, message) {
        this.sendJSON(res, {
            success: false,
            error: message,
            timestamp: new Date().toISOString()
        }, statusCode);
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
            console.log('Loaded existing extraction stats');
            this.extraction.stats = stats;
        }

        // Create server
        const server = http.createServer((req, res) => {
            this.router.handleRequest(req, res);
        });

        // Start listening
        server.listen(CONFIG.PORT, CONFIG.HOST, () => {
            console.log('='.repeat(60));
            console.log('🚀 MixVibe Mirror Server - UNLIMITED EDITION');
            console.log('='.repeat(60));
            console.log('🔒 DATA PROTECTION: Never overwrites or deletes existing data');
            console.log('💡 Only extracts NEW content not already in storage');
            console.log('='.repeat(60));
            console.log(`Environment: ${CONFIG.NODE_ENV}`);
            console.log(`Server: http://${CONFIG.DOMAIN}:${CONFIG.PORT}`);
            console.log(`Storage: ${CONFIG.DATA_DIR}`);
            console.log(`Max Concurrent: ${CONFIG.MAX_CONCURRENT}`);
            console.log('='.repeat(60));
            console.log('API Endpoints:');
            console.log('  GET  /api/batches');
            console.log('  GET  /api/batchdetails?batchId=');
            console.log('  GET  /api/live?batchId=');
            console.log('  GET  /api/topics?batchId=&subjectId=');
            console.log('  GET  /api/content?batchId=&subjectId=&topicId=&contentType=');
            console.log('  GET  /api/stats');
            console.log('  GET  /api/search?q=');
            console.log('  GET  /api/export');
            console.log('  POST /api/extract');
            console.log('  POST /api/extract-all');
            console.log('  GET  /health');
            console.log('='.repeat(60));
            
            // Auto-extraction if enabled
            if (CONFIG.EXTRACT_INTERVAL > 0) {
                console.log(`Auto-extraction every ${CONFIG.EXTRACT_INTERVAL}ms`);
                setInterval(() => {
                    this.extraction.extractAll().catch(console.error);
                }, CONFIG.EXTRACT_INTERVAL);
            }
        });

        // Graceful shutdown
        process.on('SIGTERM', () => this.shutdown(server));
        process.on('SIGINT', () => this.shutdown(server));
    }

    shutdown(server) {
        console.log('\nShutting down gracefully...');
        server.close(() => {
            console.log('Server closed');
            process.exit(0);
        });
        
        setTimeout(() => {
            console.log('Forced shutdown');
            process.exit(1);
        }, 10000);
    }
}

// ==================== Startup ====================
const server = new MixVibeMirrorServer();
server.start().catch(console.error);
    
