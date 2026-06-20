// server.js – MixVibe Mirror Backend (No Limits Edition)
// Zero dependencies, Node.js 18+ required
// Run: node server.js

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
    MAX_CONCURRENT: parseInt(process.env.MAX_CONCURRENT || '10'), // Increased concurrency
    RETRY_ATTEMPTS: 5,
    RETRY_DELAY: 1000,
    REQUEST_DELAY: 100, // Minimal delay between requests
    
    // Auto extraction (disabled by default, enable with env var)
    EXTRACT_INTERVAL: parseInt(process.env.EXTRACT_INTERVAL || '0'), // milliseconds, 0 = disabled
    
    // Remove all content limits
    // MAX_SUBJECTS and MAX_TOPICS are removed entirely
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

// ==================== Rate Limiter (For API consumers only) ====================
class RateLimiter {
    constructor(windowMs = 60000, maxRequests = 1000) { // Increased limits
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

// ==================== API Client (Aggressive Mode) ====================
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
                const timeout = setTimeout(() => controller.abort(), 60000); // 60 second timeout
                
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
                    const wait = Math.min(+(resp.headers.get('Retry-After') || 5), 15); // Max 15s wait
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
                const delay = CONFIG.RETRY_DELAY * Math.pow(1.5, attempt); // Reduced exponential backoff
                console.log(`Retry ${attempt + 1}/${retries} after ${delay}ms...`);
                await new Promise(r => setTimeout(r, delay));
            }
        }
    }
}

// ==================== Extraction Engine (No Limits) ====================
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
            console.log('🚀 Starting FULL extraction (NO LIMITS)...');
            const { batches } = await this.client.apiCall('/api/batches');
            
            if (!batches || !Array.isArray(batches)) {
                throw new Error('Invalid batches response');
            }

            console.log(`Found ${batches.length} total batches in source`);
            
            const existingIds = new Set(this.storage.getAllBatchIds());
            const newBatches = batches.filter(b => !existingIds.has(b._id));
            
            // Also process existing batches to get any new content
            const allBatchesToProcess = batches; // Process EVERYTHING

            if (allBatchesToProcess.length === 0) {
                console.log('No batches to process');
                this.stats.processed = 0;
                this.stats.total = 0;
                extractionEvents.emit('extraction:complete', this.stats);
                return { added: 0, total: 0 };
            }

            this.stats.total = allBatchesToProcess.length;

            // Process ALL batches with high concurrency
            const chunks = this.chunkArray(allBatchesToProcess, CONFIG.MAX_CONCURRENT);
            
            for (const chunk of chunks) {
                await Promise.allSettled(
                    chunk.map(batch => this.processBatchComplete(batch))
                );
                // Minimal delay between chunks
                await new Promise(r => setTimeout(r, CONFIG.REQUEST_DELAY));
            }

            // Save stats
            this.stats.lastRun = new Date().toISOString();
            this.storage.saveJSON('meta', 'extraction-stats', this.stats);

            console.log(`✅ Extraction complete: ${this.stats.processed} batches processed`);
            console.log(`   Subjects: ${this.stats.totalSubjects}, Topics: ${this.stats.totalTopics}, Content: ${this.stats.totalContent}`);
            
            extractionEvents.emit('extraction:complete', this.stats);

            return {
                processed: allBatchesToProcess.length,
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

            // Save batch
            this.storage.saveJSON('batches', batch._id, batch);

            // Fetch live classes
            await this.fetchAllLive(batch._id);
            await new Promise(r => setTimeout(r, CONFIG.REQUEST_DELAY));

            // Fetch ALL batch details (subjects)
            const details = await this.fetchBatchDetails(batch._id);
            
            if (details && details.data && details.data.subjects) {
                const subjects = details.data.subjects; // ALL subjects, no limit
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
                
                const topics = topicData.data; // ALL topics, no limit
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
        const contentTypes = ['videos', 'notes', 'dpp']; // ALL content types
        
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
        this.addRoute('GET', '/admin', this.handleAdmin.bind(this));
        this.addRoute('GET', '/', this.handleAdmin.bind(this));
    }

    addRoute(method, path, handler) {
        if (!this.routes.has(method)) {
            this.routes.set(method, new Map());
        }
        this.routes.get(method).set(path, handler);
    }

    async handleRequest(req, res) {
        const clientIP = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
        
        // Rate limiting (more lenient)
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

    async handleGetBatches(req, res, params) {
        const page = parseInt(params.get('page') || '1');
        const limit = parseInt(params.get('limit') || '0'); // 0 = no limit
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
        
        // Calculate total size
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
                message: 'Extraction started - extracting ALL content without limits',
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
            
            // Force re-extraction of everything
            this.extraction.extractAll().catch(err => {
                console.error('Background extraction error:', err);
            });
            
            this.sendJSON(res, {
                success: true,
                message: 'Full extraction started - processing ALL batches, subjects, topics and content',
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
        
        // Search batches
        const batches = this.storage.listJSON('batches');
        for (const batch of batches) {
            if (batch.name?.toLowerCase().includes(query) ||
                batch.description?.toLowerCase().includes(query)) {
                results.batches.push(batch);
            }
        }
        
        // Search batch details for subjects
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

    async handleAdmin(req, res, params) {
        const html = this.generateAdminHTML();
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(html);
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

    generateAdminHTML() {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>MixVibe Mirror - Unlimited Edition</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #0a0e27 0%, #1a1f3a 100%);
            color: #e1e8ed;
            line-height: 1.6;
            min-height: 100vh;
        }
        .container { max-width: 1400px; margin: 0 auto; padding: 2rem; }
        
        /* Animated header */
        .header {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
            margin-bottom: 2rem;
        }
        h1 { font-size: 3rem; font-weight: 800; }
        .subtitle { font-size: 1.2rem; opacity: 0.8; color: #94a3b8; }
        
        /* Stats grid */
        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
            gap: 1.5rem;
            margin: 2rem 0;
        }
        .stat-card {
            background: linear-gradient(135deg, rgba(30, 41, 59, 0.8), rgba(15, 23, 42, 0.9));
            padding: 1.5rem;
            border-radius: 16px;
            border: 1px solid rgba(51, 65, 85, 0.5);
            backdrop-filter: blur(10px);
            transition: transform 0.3s, box-shadow 0.3s;
        }
        .stat-card:hover {
            transform: translateY(-5px);
            box-shadow: 0 10px 30px rgba(0, 0, 0, 0.3);
        }
        .stat-card h3 { color: #94a3b8; font-size: 0.9rem; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 0.5rem; }
        .stat-card .value { font-size: 2.5rem; font-weight: bold; background: linear-gradient(135deg, #38bdf8, #818cf8); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; }
        .stat-card .size { font-size: 0.9rem; color: #64748b; margin-top: 0.5rem; }
        
        /* Buttons */
        .button-group { display: flex; gap: 1rem; margin: 2rem 0; flex-wrap: wrap; }
        button {
            padding: 1rem 2rem;
            border: none;
            border-radius: 12px;
            cursor: pointer;
            font-size: 1rem;
            font-weight: 600;
            transition: all 0.3s;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        .btn-primary {
            background: linear-gradient(135deg, #3b82f6, #2563eb);
            color: white;
        }
        .btn-danger {
            background: linear-gradient(135deg, #ef4444, #dc2626);
            color: white;
        }
        .btn-success {
            background: linear-gradient(135deg, #10b981, #059669);
            color: white;
        }
        button:hover { transform: translateY(-2px); box-shadow: 0 5px 20px rgba(0, 0, 0, 0.3); }
        button:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
        
        /* Status */
        .status-panel {
            background: rgba(30, 41, 59, 0.8);
            padding: 1.5rem;
            border-radius: 16px;
            margin: 2rem 0;
            border: 1px solid rgba(51, 65, 85, 0.5);
        }
        .progress-bar {
            width: 100%;
            height: 6px;
            background: #1e293b;
            border-radius: 3px;
            margin: 1rem 0;
            overflow: hidden;
        }
        .progress-fill {
            height: 100%;
            background: linear-gradient(90deg, #38bdf8, #818cf8);
            transition: width 0.5s;
            width: 0%;
            border-radius: 3px;
        }
        
        /* Terminal */
        .terminal {
            background: #000;
            color: #00ff00;
            padding: 1.5rem;
            border-radius: 12px;
            font-family: 'Courier New', monospace;
            max-height: 400px;
            overflow-y: auto;
            margin-top: 2rem;
            border: 1px solid #00ff00;
            box-shadow: 0 0 20px rgba(0, 255, 0, 0.1);
        }
        .terminal-line { padding: 0.2rem 0; }
        
        /* API Endpoints */
        .endpoints {
            background: rgba(30, 41, 59, 0.8);
            padding: 2rem;
            border-radius: 16px;
            margin-top: 2rem;
        }
        .endpoint {
            padding: 0.8rem;
            margin: 0.5rem 0;
            background: #0f172a;
            border-radius: 8px;
            font-family: monospace;
            display: flex;
            align-items: center;
        }
        .method {
            padding: 0.2rem 0.5rem;
            border-radius: 4px;
            font-weight: bold;
            margin-right: 1rem;
            min-width: 60px;
            text-align: center;
        }
        .method.get { background: #10b981; color: white; }
        .method.post { background: #3b82f6; color: white; }
        
        /* Responsive */
        @media (max-width: 768px) {
            .container { padding: 1rem; }
            h1 { font-size: 2rem; }
            .stats-grid { grid-template-columns: 1fr; }
            .button-group { flex-direction: column; }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🚀 MixVibe Mirror</h1>
            <p class="subtitle">Unlimited Edition - Extract Everything</p>
        </div>
        
        <div class="stats-grid" id="statsGrid"></div>
        
        <div class="button-group">
            <button class="btn-primary" onclick="startExtraction()" id="extractBtn">
                🔄 Extract New Content
            </button>
            <button class="btn-danger" onclick="forceExtractAll()" id="extractAllBtn">
                ⚡ Force Extract ALL
            </button>
            <button class="btn-success" onclick="exportData()">
                📥 Export All Data
            </button>
            <button onclick="refreshStats()">
                🔃 Refresh
            </button>
        </div>
        
        <div class="status-panel">
            <h3>Extraction Status</h3>
            <div id="statusText" style="margin: 1rem 0;">Idle</div>
            <div class="progress-bar">
                <div class="progress-fill" id="progressBar"></div>
            </div>
            <div id="extractionDetails" style="color: #94a3b8; font-size: 0.9rem;"></div>
        </div>
        
        <div class="endpoints">
            <h2>📡 API Endpoints (No Limits)</h2>
            <div class="endpoint"><span class="method get">GET</span> /api/batches</div>
            <div class="endpoint"><span class="method get">GET</span> /api/batchdetails?batchId={id}</div>
            <div class="endpoint"><span class="method get">GET</span> /api/live?batchId={id}</div>
            <div class="endpoint"><span class="method get">GET</span> /api/topics?batchId={id}&subjectId={sid}</div>
            <div class="endpoint"><span class="method get">GET</span> /api/content?batchId={id}&subjectId={sid}&topicId={tid}&contentType={type}</div>
            <div class="endpoint"><span class="method get">GET</span> /api/stats</div>
            <div class="endpoint"><span class="method post">POST</span> /api/extract</div>
            <div class="endpoint"><span class="method post">POST</span> /api/extract-all</div>
            <div class="endpoint"><span class="method get">GET</span> /api/search?q={query}</div>
            <div class="endpoint"><span class="method get">GET</span> /api/export</div>
            <div class="endpoint"><span class="method get">GET</span> /health</div>
        </div>
        
        <div class="terminal" id="terminal">
            <div class="terminal-line">> MixVibe Mirror v2.0 - Unlimited Edition</div>
            <div class="terminal-line">> All limits removed - extracting everything</div>
            <div class="terminal-line">> Ready for commands...</div>
        </div>
    </div>

    <script>
        const API_BASE = window.location.origin;
        let statsInterval;
        
        async function fetchAPI(endpoint, options = {}) {
            const response = await fetch(API_BASE + endpoint, options);
            return response.json();
        }
        
        async function refreshStats() {
            try {
                const stats = await fetchAPI('/api/stats');
                const grid = document.getElementById('statsGrid');
                const statusText = document.getElementById('statusText');
                const progressBar = document.getElementById('progressBar');
                const details = document.getElementById('extractionDetails');
                
                // Update stats grid
                grid.innerHTML = '';
                for (const [key, data] of Object.entries(stats.files)) {
                    const sizeMB = (data.size / (1024 * 1024)).toFixed(2);
                    grid.innerHTML += \`
                        <div class="stat-card">
                            <h3>\${key}</h3>
                            <div class="value">\${data.count}</div>
                            <div class="size">\${sizeMB} MB</div>
                        </div>
                    \`;
                }
                
                // Add total size card
                grid.innerHTML += \`
                    <div class="stat-card">
                        <h3>Total Storage</h3>
                        <div class="value">\${stats.totalSize.mb}</div>
                        <div class="size">MB (\${stats.totalSize.gb} GB)</div>
                    </div>
                \`;
                
                // Update extraction status
                if (stats.extraction.running) {
                    const pct = stats.extraction.stats.total > 0 
                        ? ((stats.extraction.stats.processed / stats.extraction.stats.total) * 100).toFixed(1)
                        : 0;
                    statusText.innerHTML = \`⏳ Extracting: <strong>\${stats.extraction.stats.processed}/\${stats.extraction.stats.total}</strong> batches (\${pct}%)\`;
                    statusText.innerHTML += \`<br>Current: \${stats.extraction.stats.currentBatch}\`;
                    progressBar.style.width = pct + '%';
                    
                    details.innerHTML = \`
                        Subjects: \${stats.extraction.stats.totalSubjects} | 
                        Topics: \${stats.extraction.stats.totalTopics} | 
                        Content: \${stats.extraction.stats.totalContent}
                    \`;
                } else {
                    statusText.innerHTML = '✅ Idle - Ready for extraction';
                    progressBar.style.width = '0%';
                    details.innerHTML = \`Last run: \${stats.extraction.stats.lastRun || 'Never'}\`;
                }
                
                // Update button states
                document.getElementById('extractBtn').disabled = stats.extraction.running;
                document.getElementById('extractAllBtn').disabled = stats.extraction.running;
            } catch (error) {
                logTerminal('Error refreshing stats: ' + error.message);
            }
        }
        
        async function startExtraction() {
            const btn = document.getElementById('extractBtn');
            btn.disabled = true;
            
            try {
                logTerminal('Starting extraction...');
                const response = await fetch(API_BASE + '/api/extract', { method: 'POST' });
                const data = await response.json();
                logTerminal('✅ ' + data.message);
            } catch (error) {
                logTerminal('❌ Error: ' + error.message);
            }
            
            btn.disabled = false;
        }
        
        async function forceExtractAll() {
            if (!confirm('This will re-extract ALL content. Continue?')) return;
            
            const btn = document.getElementById('extractAllBtn');
            btn.disabled = true;
            
            try {
                logTerminal('⚡ Starting FULL extraction...');
                const response = await fetch(API_BASE + '/api/extract-all', { method: 'POST' });
                const data = await response.json();
                logTerminal('✅ ' + data.message);
            } catch (error) {
                logTerminal('❌ Error: ' + error.message);
            }
            
            btn.disabled = false;
        }
        
        async function exportData() {
            try {
                logTerminal('📥 Preparing export...');
                window.open(API_BASE + '/api/export?format=json', '_blank');
                logTerminal('✅ Export started');
            } catch (error) {
                logTerminal('❌ Error: ' + error.message);
            }
        }
        
        function logTerminal(message) {
            const terminal = document.getElementById('terminal');
            const time = new Date().toLocaleTimeString();
            terminal.innerHTML += \`<div class="terminal-line">[\${time}] \${message}</div>\`;
            terminal.scrollTop = terminal.scrollHeight;
        }
        
        // Start auto-refresh
        refreshStats();
        statsInterval = setInterval(refreshStats, 2000);
        
        // Listen for extraction events
        const eventSource = new EventSource(API_BASE + '/api/extract/events');
        eventSource.onmessage = (event) => {
            const data = JSON.parse(event.data);
            if (data.type === 'progress') {
                logTerminal(\`Processing: \${data.batch}\`);
            }
        };
    </script>
</body>
</html>`;
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
            console.log('⚠️  ALL LIMITS REMOVED - Extracting everything');
            console.log('='.repeat(60));
            console.log(`Environment: ${CONFIG.NODE_ENV}`);
            console.log(`Server: http://${CONFIG.DOMAIN}:${CONFIG.PORT}`);
            console.log(`Admin: http://${CONFIG.DOMAIN}:${CONFIG.PORT}/admin`);
            console.log(`Storage: ${CONFIG.DATA_DIR}`);
            console.log(`Max Concurrent: ${CONFIG.MAX_CONCURRENT}`);
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
                                
