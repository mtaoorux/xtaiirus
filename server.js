// server.js - Production ready for Render
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 10000;

// ============ SECURITY & MIDDLEWARE ============

// Rate limiting
const limiter = rateLimit({
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW) * 60 * 1000 || 15 * 60 * 1000,
    max: parseInt(process.env.RATE_LIMIT_MAX) || 100,
    message: { success: false, error: 'Too many requests, please try again later.' }
});

// Security middleware
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            scriptSrc: ["'self'", "'unsafe-inline'"],
        },
    },
}));
app.use(compression());
app.use(cors({
    origin: process.env.CORS_ORIGIN || '*',
    credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Apply rate limiting to all routes
app.use('/api/', limiter);

// ============ DATABASE ============

let db;

// Initialize database with retry logic
function initDatabase() {
    return new Promise((resolve, reject) => {
        const dbPath = process.env.DATABASE_PATH || './brainbox.db';
        
        // Check if database exists
        const dbExists = fs.existsSync(dbPath);
        
        db = new sqlite3.Database(dbPath, (err) => {
            if (err) {
                console.error('❌ Database connection error:', err);
                reject(err);
                return;
            }
            console.log(`✅ Database connected: ${dbPath}`);
            
            // Create tables if not exists
            if (!dbExists) {
                createTables();
            }
            resolve(db);
        });
    });
}

function createTables() {
    db.serialize(() => {
        const tables = [
            `CREATE TABLE IF NOT EXISTS batches (
                id INTEGER PRIMARY KEY,
                name TEXT,
                description TEXT,
                start_date TEXT,
                end_date TEXT,
                status TEXT,
                course_id INTEGER,
                raw_data TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`,
            `CREATE TABLE IF NOT EXISTS courses (
                id INTEGER PRIMARY KEY,
                name TEXT,
                description TEXT,
                category TEXT,
                duration TEXT,
                price REAL,
                raw_data TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`,
            `CREATE TABLE IF NOT EXISTS contents (
                id INTEGER PRIMARY KEY,
                title TEXT,
                description TEXT,
                type TEXT,
                course_id INTEGER,
                batch_id INTEGER,
                url TEXT,
                raw_data TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`,
            `CREATE TABLE IF NOT EXISTS media (
                id INTEGER PRIMARY KEY,
                title TEXT,
                type TEXT,
                url TEXT,
                duration INTEGER,
                size INTEGER,
                content_id INTEGER,
                raw_data TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`,
            `CREATE TABLE IF NOT EXISTS live_sessions (
                id INTEGER PRIMARY KEY,
                title TEXT,
                batch_id INTEGER,
                start_time TEXT,
                end_time TEXT,
                status TEXT,
                token TEXT,
                raw_data TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`,
            `CREATE TABLE IF NOT EXISTS live_tokens (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                batch_id INTEGER,
                token TEXT,
                created_at TEXT,
                expires_at TEXT,
                raw_data TEXT,
                saved_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`
        ];

        tables.forEach(sql => {
            db.run(sql, (err) => {
                if (err) console.error('Table creation error:', err);
            });
        });

        console.log('✅ Database tables created/verified');
    });
}

// Helper function for database queries with error handling
function queryDatabase(sql, params = []) {
    return new Promise((resolve, reject) => {
        if (!db) {
            reject(new Error('Database not initialized'));
            return;
        }
        db.all(sql, params, (err, rows) => {
            if (err) {
                console.error('Database query error:', err);
                reject(err);
            } else {
                resolve(rows);
            }
        });
    });
}

// ============ API ROUTES ============

// Health check endpoint (for Render)
app.get('/health', (req, res) => {
    res.status(200).json({
        success: true,
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});

// Root endpoint with API documentation
app.get('/', (req, res) => {
    res.json({
        name: 'Brainbox Institute API v2',
        version: '2.0.0',
        status: 'online',
        environment: process.env.NODE_ENV || 'development',
        documentation: {
            endpoints: {
                'GET /': 'API documentation',
                'GET /health': 'Health check',
                'GET /api/batches': 'Get all batches',
                'GET /api/batches/:id': 'Get specific batch',
                'GET /api/batches/:batchId/contents': 'Get contents for batch',
                'GET /api/batches/:batchId/live': 'Get live session for batch',
                'GET /api/courses': 'Get all courses',
                'GET /api/courses/:id': 'Get specific course',
                'GET /api/courses/:courseId/batches': 'Get batches for course',
                'GET /api/contents': 'Get all contents',
                'GET /api/contents/:id': 'Get specific content',
                'GET /api/media': 'Get all media',
                'GET /api/media/:id': 'Get specific media',
                'GET /api/live': 'Get all live sessions',
                'GET /api/live/:id': 'Get specific live session',
                'GET /api/live-token/:batchId': 'Get live token for batch',
                'GET /api/search': 'Search across all content',
                'GET /api/stats': 'Get system statistics',
                'GET /api/export/:type': 'Export data by type'
            }
        },
        base_url: req.protocol + '://' + req.get('host')
    });
});

// ============ API ENDPOINTS ============

// 1. Batches
app.get('/api/batches', async (req, res) => {
    try {
        const { status, courseId } = req.query;
        let sql = `
            SELECT b.*, 
                   c.name as course_name,
                   (SELECT COUNT(*) FROM contents WHERE batch_id = b.id) as content_count
            FROM batches b
            LEFT JOIN courses c ON b.course_id = c.id
            WHERE 1=1
        `;
        const params = [];
        
        if (status) {
            sql += ' AND b.status = ?';
            params.push(status);
        }
        if (courseId) {
            sql += ' AND b.course_id = ?';
            params.push(courseId);
        }
        
        sql += ' ORDER BY b.id DESC';
        
        const rows = await queryDatabase(sql, params);
        res.json({
            success: true,
            data: rows,
            count: rows.length,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/batches/:id', async (req, res) => {
    try {
        const sql = `
            SELECT b.*, 
                   c.name as course_name,
                   (SELECT COUNT(*) FROM contents WHERE batch_id = b.id) as content_count
            FROM batches b
            LEFT JOIN courses c ON b.course_id = c.id
            WHERE b.id = ?
        `;
        const rows = await queryDatabase(sql, [req.params.id]);
        if (rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Batch not found' });
        }
        res.json({
            success: true,
            data: rows[0],
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/batches/:batchId/contents', async (req, res) => {
    try {
        const sql = `
            SELECT c.*, 
                   b.name as batch_name,
                   m.url as media_url,
                   m.type as media_type
            FROM contents c
            LEFT JOIN batches b ON c.batch_id = b.id
            LEFT JOIN media m ON c.id = m.content_id
            WHERE c.batch_id = ?
            ORDER BY c.id ASC
        `;
        const rows = await queryDatabase(sql, [req.params.batchId]);
        res.json({
            success: true,
            data: rows,
            count: rows.length,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/batches/:batchId/live', async (req, res) => {
    try {
        const sql = `
            SELECT ls.*, lt.token as live_token
            FROM live_sessions ls
            LEFT JOIN live_tokens lt ON ls.batch_id = lt.batch_id
            WHERE ls.batch_id = ?
            ORDER BY ls.start_time DESC
            LIMIT 1
        `;
        const rows = await queryDatabase(sql, [req.params.batchId]);
        if (rows.length === 0) {
            return res.status(404).json({ success: false, error: 'No live session found for this batch' });
        }
        res.json({
            success: true,
            data: rows[0],
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 2. Courses
app.get('/api/courses', async (req, res) => {
    try {
        const { category } = req.query;
        let sql = `
            SELECT c.*, 
                   (SELECT COUNT(*) FROM batches WHERE course_id = c.id) as batch_count,
                   (SELECT COUNT(*) FROM contents WHERE course_id = c.id) as content_count
            FROM courses c
            WHERE 1=1
        `;
        const params = [];
        
        if (category) {
            sql += ' AND c.category = ?';
            params.push(category);
        }
        
        sql += ' ORDER BY c.id DESC';
        
        const rows = await queryDatabase(sql, params);
        res.json({
            success: true,
            data: rows,
            count: rows.length,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/courses/:id', async (req, res) => {
    try {
        const sql = `
            SELECT c.*, 
                   (SELECT COUNT(*) FROM batches WHERE course_id = c.id) as batch_count,
                   (SELECT COUNT(*) FROM contents WHERE course_id = c.id) as content_count
            FROM courses c
            WHERE c.id = ?
        `;
        const rows = await queryDatabase(sql, [req.params.id]);
        if (rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Course not found' });
        }
        res.json({
            success: true,
            data: rows[0],
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/courses/:courseId/batches', async (req, res) => {
    try {
        const sql = `
            SELECT b.*, 
                   (SELECT COUNT(*) FROM contents WHERE batch_id = b.id) as content_count
            FROM batches b
            WHERE b.course_id = ?
            ORDER BY b.id DESC
        `;
        const rows = await queryDatabase(sql, [req.params.courseId]);
        res.json({
            success: true,
            data: rows,
            count: rows.length,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 3. Contents
app.get('/api/contents', async (req, res) => {
    try {
        const { batchId, courseId, type } = req.query;
        let sql = `
            SELECT c.*, 
                   b.name as batch_name,
                   co.name as course_name,
                   m.url as media_url,
                   m.type as media_type
            FROM contents c
            LEFT JOIN batches b ON c.batch_id = b.id
            LEFT JOIN courses co ON c.course_id = co.id
            LEFT JOIN media m ON c.id = m.content_id
            WHERE 1=1
        `;
        const params = [];
        
        if (batchId) {
            sql += ' AND c.batch_id = ?';
            params.push(batchId);
        }
        if (courseId) {
            sql += ' AND c.course_id = ?';
            params.push(courseId);
        }
        if (type) {
            sql += ' AND c.type = ?';
            params.push(type);
        }
        
        sql += ' ORDER BY c.id ASC';
        
        const rows = await queryDatabase(sql, params);
        res.json({
            success: true,
            data: rows,
            count: rows.length,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/contents/:id', async (req, res) => {
    try {
        const sql = `
            SELECT c.*, 
                   b.name as batch_name,
                   co.name as course_name,
                   m.url as media_url,
                   m.type as media_type,
                   m.duration,
                   m.size
            FROM contents c
            LEFT JOIN batches b ON c.batch_id = b.id
            LEFT JOIN courses co ON c.course_id = co.id
            LEFT JOIN media m ON c.id = m.content_id
            WHERE c.id = ?
        `;
        const rows = await queryDatabase(sql, [req.params.id]);
        if (rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Content not found' });
        }
        res.json({
            success: true,
            data: rows[0],
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 4. Media
app.get('/api/media', async (req, res) => {
    try {
        const { type, contentId } = req.query;
        let sql = 'SELECT * FROM media WHERE 1=1';
        const params = [];
        
        if (type) {
            sql += ' AND type = ?';
            params.push(type);
        }
        if (contentId) {
            sql += ' AND content_id = ?';
            params.push(contentId);
        }
        
        sql += ' ORDER BY id DESC';
        
        const rows = await queryDatabase(sql, params);
        res.json({
            success: true,
            data: rows,
            count: rows.length,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/media/:id', async (req, res) => {
    try {
        const sql = 'SELECT * FROM media WHERE id = ?';
        const rows = await queryDatabase(sql, [req.params.id]);
        if (rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Media not found' });
        }
        res.json({
            success: true,
            data: rows[0],
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 5. Live Sessions
app.get('/api/live', async (req, res) => {
    try {
        const { status, batchId } = req.query;
        let sql = `
            SELECT ls.*, 
                   b.name as batch_name,
                   lt.token as live_token
            FROM live_sessions ls
            LEFT JOIN batches b ON ls.batch_id = b.id
            LEFT JOIN live_tokens lt ON ls.batch_id = lt.batch_id
            WHERE 1=1
        `;
        const params = [];
        
        if (status) {
            sql += ' AND ls.status = ?';
            params.push(status);
        }
        if (batchId) {
            sql += ' AND ls.batch_id = ?';
            params.push(batchId);
        }
        
        sql += ' ORDER BY ls.start_time DESC';
        
        const rows = await queryDatabase(sql, params);
        res.json({
            success: true,
            data: rows,
            count: rows.length,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/live/:id', async (req, res) => {
    try {
        const sql = `
            SELECT ls.*, 
                   b.name as batch_name,
                   lt.token as live_token
            FROM live_sessions ls
            LEFT JOIN batches b ON ls.batch_id = b.id
            LEFT JOIN live_tokens lt ON ls.batch_id = lt.batch_id
            WHERE ls.id = ?
        `;
        const rows = await queryDatabase(sql, [req.params.id]);
        if (rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Live session not found' });
        }
        res.json({
            success: true,
            data: rows[0],
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/live-token/:batchId', async (req, res) => {
    try {
        const sql = `
            SELECT * FROM live_tokens 
            WHERE batch_id = ?
            ORDER BY created_at DESC
            LIMIT 1
        `;
        const rows = await queryDatabase(sql, [req.params.batchId]);
        if (rows.length === 0) {
            return res.status(404).json({ success: false, error: 'No live token found for this batch' });
        }
        res.json({
            success: true,
            data: rows[0],
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 6. Search
app.get('/api/search', async (req, res) => {
    try {
        const query = req.query.q || '';
        const searchTerms = query.split(' ').filter(term => term.length > 1);
        
        if (searchTerms.length === 0) {
            return res.json({
                success: true,
                data: [],
                count: 0,
                searchTerm: query,
                timestamp: new Date().toISOString()
            });
        }

        let sql = `
            SELECT 'batch' as type, b.id, b.name as title, b.description, b.status,
                   c.name as category
            FROM batches b
            LEFT JOIN courses c ON b.course_id = c.id
            WHERE 1=0
            UNION ALL
            SELECT 'course' as type, c.id, c.name as title, c.description, c.category,
                   c.duration as category
            FROM courses c
            WHERE 1=0
            UNION ALL
            SELECT 'content' as type, c.id, c.title, c.description, c.type,
                   b.name as category
            FROM contents c
            LEFT JOIN batches b ON c.batch_id = b.id
            WHERE 1=0
        `;

        const params = [];
        for (const term of searchTerms) {
            const like = `%${term}%`;
            // Replace first WHERE 1=0 with conditions
            if (sql.includes('WHERE 1=0', sql.lastIndexOf('WHERE 1=0') + 1)) {
                // More than one WHERE clause
                sql = sql.replace(/WHERE 1=0/, `WHERE (title LIKE ? OR description LIKE ? OR category LIKE ?)`);
                params.push(like, like, like);
            } else {
                // First WHERE clause
                sql = sql.replace(/WHERE 1=0/, `WHERE (title LIKE ? OR description LIKE ? OR category LIKE ?)`);
                params.push(like, like, like);
            }
        }

        const rows = await queryDatabase(sql, params);
        res.json({
            success: true,
            data: rows,
            count: rows.length,
            searchTerm: query,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 7. Stats
app.get('/api/stats', async (req, res) => {
    try {
        const stats = await queryDatabase(`
            SELECT 
                (SELECT COUNT(*) FROM batches) as total_batches,
                (SELECT COUNT(*) FROM courses) as total_courses,
                (SELECT COUNT(*) FROM contents) as total_contents,
                (SELECT COUNT(*) FROM media) as total_media,
                (SELECT COUNT(*) FROM live_sessions) as total_live_sessions,
                (SELECT COUNT(*) FROM live_tokens) as total_live_tokens,
                (SELECT COUNT(*) FROM batches WHERE status = 'active') as active_batches,
                (SELECT COUNT(*) FROM live_sessions WHERE status = 'live') as active_live_sessions,
                (SELECT COUNT(*) FROM contents WHERE type = 'video') as video_contents,
                (SELECT COUNT(*) FROM contents WHERE type = 'document') as document_contents
        `);
        
        res.json({
            success: true,
            data: stats[0] || {},
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 8. Export
app.get('/api/export/:type', async (req, res) => {
    try {
        const { type } = req.params;
        const validTypes = ['batches', 'courses', 'contents', 'media', 'live_sessions', 'live_tokens'];
        
        if (!validTypes.includes(type)) {
            return res.status(400).json({ success: false, error: 'Invalid export type' });
        }

        const sql = `SELECT * FROM ${type} ORDER BY id DESC`;
        const rows = await queryDatabase(sql);
        
        res.json({
            success: true,
            data: rows,
            count: rows.length,
            exportType: type,
            exportedAt: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============ ERROR HANDLING ============

// 404 handler
app.use((req, res) => {
    res.status(404).json({
        success: false,
        error: 'Endpoint not found',
        path: req.originalUrl,
        timestamp: new Date().toISOString()
    });
});

// Global error handler
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({
        success: false,
        error: 'Internal server error',
        message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong',
        timestamp: new Date().toISOString()
    });
});

// ============ START SERVER ============

async function startServer() {
    try {
        // Initialize database
        await initDatabase();
        
        // Start server
        app.listen(PORT, '0.0.0.0', () => {
            console.log(`
            🚀 Brainbox Institute API v2
            🌐 Running on: http://localhost:${PORT}
            📊 Database: ${process.env.DATABASE_PATH || './brainbox.db'}
            🔧 Environment: ${process.env.NODE_ENV || 'development'}
            
            📡 Available endpoints:
            GET  /health - Health check
            GET  /api/batches - Get all batches
            GET  /api/batches/:id - Get specific batch
            GET  /api/batches/:batchId/contents - Get contents for batch
            GET  /api/batches/:batchId/live - Get live session for batch
            GET  /api/courses - Get all courses
            GET  /api/courses/:id - Get specific course
            GET  /api/courses/:courseId/batches - Get batches for course
            GET  /api/contents - Get all contents
            GET  /api/contents/:id - Get specific content
            GET  /api/media - Get all media
            GET  /api/media/:id - Get specific media
            GET  /api/live - Get all live sessions
            GET  /api/live/:id - Get specific live session
            GET  /api/live-token/:batchId - Get live token for batch
            GET  /api/search?q=query - Search across all content
            GET  /api/stats - Get system statistics
            GET  /api/export/:type - Export data by type
            `);
        });

        // Graceful shutdown
        process.on('SIGTERM', shutdown);
        process.on('SIGINT', shutdown);

    } catch (error) {
        console.error('❌ Failed to start server:', error);
        process.exit(1);
    }
}

function shutdown() {
    console.log('👋 Shutting down gracefully...');
    if (db) {
        db.close((err) => {
            if (err) {
                console.error('Error closing database:', err);
            } else {
                console.log('✅ Database closed');
            }
            process.exit(0);
        });
    } else {
        process.exit(0);
    }
}

// Start the server
startServer();
