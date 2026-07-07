// server.js - Main API Server
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');

// Run auto setup if database doesn't exist
const DB_PATH = process.env.DATABASE_PATH || './brainbox.db';
if (!fs.existsSync(DB_PATH)) {
    console.log('📦 Database not found. Running auto setup...');
    require('./auto-setup.js').autoSetup()
        .then(() => {
            console.log('✅ Setup completed. Starting server...');
            startServer();
        })
        .catch(err => {
            console.error('❌ Setup failed:', err);
            process.exit(1);
        });
} else {
    startServer();
}

function startServer() {
    const app = express();
    const PORT = process.env.PORT || 10000;

    // ============ MIDDLEWARE ============

    const limiter = rateLimit({
        windowMs: parseInt(process.env.RATE_LIMIT_WINDOW) * 60 * 1000 || 15 * 60 * 1000,
        max: parseInt(process.env.RATE_LIMIT_MAX) || 100,
        message: { success: false, error: 'Too many requests' }
    });

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
    app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
    app.use(express.json());
    app.use('/api/', limiter);

    // ============ DATABASE ============

    let db = new sqlite3.Database(DB_PATH, (err) => {
        if (err) {
            console.error('❌ Database error:', err);
            process.exit(1);
        }
        console.log('✅ Database connected');
    });

    function query(sql, params = []) {
        return new Promise((resolve, reject) => {
            db.all(sql, params, (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });
    }

    // ============ ROUTES ============

    // Health check
    app.get('/health', (req, res) => {
        res.json({
            success: true,
            status: 'online',
            database: fs.existsSync(DB_PATH) ? 'connected' : 'not found',
            timestamp: new Date().toISOString(),
            uptime: process.uptime()
        });
    });

    // API Documentation
    app.get('/', (req, res) => {
        res.json({
            name: 'Brainbox Institute API v2',
            version: '2.0.0',
            description: 'Fully automated Brainbox API - No manual setup required',
            status: 'online',
            endpoints: {
                'GET /': 'API documentation',
                'GET /health': 'Health check',
                'GET /api/batches': 'Get all batches',
                'GET /api/batches/:id': 'Get specific batch',
                'GET /api/batches/:id/contents': 'Get contents for a batch',
                'GET /api/courses': 'Get all courses',
                'GET /api/courses/:id': 'Get specific course',
                'GET /api/courses/:id/batches': 'Get batches for a course',
                'GET /api/contents': 'Get all contents',
                'GET /api/contents/:id': 'Get specific content',
                'GET /api/media': 'Get all media',
                'GET /api/media/:id': 'Get specific media',
                'GET /api/live': 'Get all live sessions',
                'GET /api/live/:id': 'Get specific live session',
                'GET /api/search': 'Search across all content',
                'GET /api/stats': 'Get system statistics'
            }
        });
    });

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
            
            const rows = await query(sql, params);
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
            const rows = await query(sql, [req.params.id]);
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
            const rows = await query(sql, [req.params.batchId]);
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
            
            const rows = await query(sql, params);
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
            const rows = await query(sql, [req.params.id]);
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
            const rows = await query(sql, [req.params.courseId]);
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
            
            const rows = await query(sql, params);
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
            const rows = await query(sql, [req.params.id]);
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
            
            const rows = await query(sql, params);
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
            const rows = await query(sql, [req.params.id]);
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
                       b.name as batch_name
                FROM live_sessions ls
                LEFT JOIN batches b ON ls.batch_id = b.id
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
            
            const rows = await query(sql, params);
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
                       b.name as batch_name
                FROM live_sessions ls
                LEFT JOIN batches b ON ls.batch_id = b.id
                WHERE ls.id = ?
            `;
            const rows = await query(sql, [req.params.id]);
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

    // 6. Search
    app.get('/api/search', async (req, res) => {
        try {
            const queryText = req.query.q || '';
            const searchTerms = queryText.split(' ').filter(term => term.length > 1);
            
            if (searchTerms.length === 0) {
                return res.json({
                    success: true,
                    data: [],
                    count: 0,
                    searchTerm: queryText,
                    timestamp: new Date().toISOString()
                });
            }

            let sql = `
                SELECT 'batch' as type, b.id, b.name as title, b.description, b.status as category
                FROM batches b
                WHERE 1=0
                UNION ALL
                SELECT 'course' as type, c.id, c.name as title, c.description, c.category
                FROM courses c
                WHERE 1=0
                UNION ALL
                SELECT 'content' as type, c.id, c.title, c.description, c.type as category
                FROM contents c
                WHERE 1=0
            `;

            const params = [];
            for (const term of searchTerms) {
                const like = `%${term}%`;
                sql = sql.replace(/WHERE 1=0/, `WHERE (title LIKE ? OR description LIKE ? OR category LIKE ?)`);
                params.push(like, like, like);
            }

            const rows = await query(sql, params);
            res.json({
                success: true,
                data: rows,
                count: rows.length,
                searchTerm: queryText,
                timestamp: new Date().toISOString()
            });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 7. Stats
    app.get('/api/stats', async (req, res) => {
        try {
            const stats = await query(`
                SELECT 
                    (SELECT COUNT(*) FROM batches) as total_batches,
                    (SELECT COUNT(*) FROM courses) as total_courses,
                    (SELECT COUNT(*) FROM contents) as total_contents,
                    (SELECT COUNT(*) FROM media) as total_media,
                    (SELECT COUNT(*) FROM live_sessions) as total_live_sessions,
                    (SELECT COUNT(*) FROM batches WHERE status = 'active') as active_batches,
                    (SELECT COUNT(*) FROM live_sessions WHERE status = 'live') as active_live_sessions
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
            const validTypes = ['batches', 'courses', 'contents', 'media', 'live_sessions'];
            
            if (!validTypes.includes(type)) {
                return res.status(400).json({ success: false, error: 'Invalid export type' });
            }

            const sql = `SELECT * FROM ${type} ORDER BY id DESC`;
            const rows = await query(sql);
            
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

    // 404 handler
    app.use((req, res) => {
        res.status(404).json({
            success: false,
            error: 'Endpoint not found',
            path: req.originalUrl,
            timestamp: new Date().toISOString()
        });
    });

    // Error handler
    app.use((err, req, res, next) => {
        console.error('Unhandled error:', err);
        res.status(500).json({
            success: false,
            error: 'Internal server error',
            message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong',
            timestamp: new Date().toISOString()
        });
    });

    // Start server
    app.listen(PORT, '0.0.0.0', () => {
        console.log('\n' + '='.repeat(60));
        console.log(`🚀 BRAINBOX API v2 - DEPLOYED SUCCESSFULLY`);
        console.log('='.repeat(60));
        console.log(`🌐 URL: http://localhost:${PORT}`);
        console.log(`📊 Database: ${DB_PATH}`);
        console.log(`🔧 Environment: ${process.env.NODE_ENV || 'development'}`);
        console.log('='.repeat(60));
        console.log('\n📡 Available Endpoints:');
        console.log('   GET  / - API Documentation');
        console.log('   GET  /health - Health Check');
        console.log('   GET  /api/batches - Get all batches');
        console.log('   GET  /api/batches/:id - Get specific batch');
        console.log('   GET  /api/batches/:id/contents - Get batch contents');
        console.log('   GET  /api/courses - Get all courses');
        console.log('   GET  /api/courses/:id - Get specific course');
        console.log('   GET  /api/courses/:id/batches - Get course batches');
        console.log('   GET  /api/contents - Get all contents');
        console.log('   GET  /api/contents/:id - Get specific content');
        console.log('   GET  /api/media - Get all media');
        console.log('   GET  /api/media/:id - Get specific media');
        console.log('   GET  /api/live - Get all live sessions');
        console.log('   GET  /api/live/:id - Get specific live session');
        console.log('   GET  /api/search?q=query - Search');
        console.log('   GET  /api/stats - Get statistics');
        console.log('   GET  /api/export/:type - Export data');
        console.log('='.repeat(60) + '\n');
    });
}
