// auto-setup.js - Fully automated extraction & storage
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const axios = require('axios');

const DATA_DIR = './extracted-data';
const DB_PATH = process.env.DATABASE_PATH || './brainbox.db';

// ============ LOGGING ============
const log = {
    info: (msg) => console.log(`ℹ️ ${msg}`),
    success: (msg) => console.log(`✅ ${msg}`),
    error: (msg) => console.log(`❌ ${msg}`),
    warn: (msg) => console.log(`⚠️ ${msg}`),
    section: (msg) => console.log(`\n📌 ${msg}`),
    data: (msg) => console.log(`📊 ${msg}`)
};

// ============ CREATE SAMPLE DATA ============
function createSampleData() {
    log.section('CREATING SAMPLE DATA STRUCTURE');
    
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    // Sample data structure - REPLACE WITH YOUR ACTUAL DATA
    const sampleData = {
        batches: {
            data: [
                {
                    id: 1,
                    name: "Web Development Batch 2024",
                    description: "Full stack web development with React & Node.js",
                    start_date: "2024-01-15",
                    end_date: "2024-06-15",
                    status: "active",
                    course_id: 1
                },
                {
                    id: 2,
                    name: "Data Science Batch 2024",
                    description: "Data science, AI & Machine Learning",
                    start_date: "2024-02-01",
                    end_date: "2024-07-01",
                    status: "active",
                    course_id: 2
                },
                {
                    id: 3,
                    name: "Digital Marketing Batch 2024",
                    description: "Complete digital marketing course",
                    start_date: "2024-03-01",
                    end_date: "2024-08-01",
                    status: "upcoming",
                    course_id: 3
                }
            ]
        },
        courses: {
            data: [
                {
                    id: 1,
                    name: "Full Stack Web Development",
                    description: "Complete web development with React, Node.js, MongoDB",
                    category: "Programming",
                    duration: "6 months",
                    price: 999
                },
                {
                    id: 2,
                    name: "Data Science & AI",
                    description: "Data science, ML, AI fundamentals with Python",
                    category: "Data Science",
                    duration: "6 months",
                    price: 1099
                },
                {
                    id: 3,
                    name: "Digital Marketing",
                    description: "SEO, SEM, Social Media Marketing",
                    category: "Marketing",
                    duration: "4 months",
                    price: 799
                }
            ]
        },
        contents: {
            data: [
                {
                    id: 1,
                    title: "Introduction to HTML & CSS",
                    description: "Learn HTML5 and CSS3 fundamentals",
                    type: "video",
                    course_id: 1,
                    batch_id: 1,
                    url: "https://example.com/html-css-intro"
                },
                {
                    id: 2,
                    title: "JavaScript Fundamentals",
                    description: "ES6+, DOM manipulation, APIs",
                    type: "video",
                    course_id: 1,
                    batch_id: 1,
                    url: "https://example.com/javascript"
                },
                {
                    id: 3,
                    title: "React.js Complete Guide",
                    description: "Hooks, Context, Redux, Next.js",
                    type: "video",
                    course_id: 1,
                    batch_id: 1,
                    url: "https://example.com/react-guide"
                },
                {
                    id: 4,
                    title: "Python for Data Science",
                    description: "NumPy, Pandas, Matplotlib, Scikit-learn",
                    type: "video",
                    course_id: 2,
                    batch_id: 2,
                    url: "https://example.com/python-data-science"
                }
            ]
        },
        media: {
            data: [
                {
                    id: 1,
                    title: "HTML CSS Video",
                    type: "video",
                    url: "https://example.com/videos/html-css.mp4",
                    duration: 3600,
                    size: 1024,
                    content_id: 1
                },
                {
                    id: 2,
                    title: "JavaScript Video",
                    type: "video",
                    url: "https://example.com/videos/javascript.mp4",
                    duration: 5400,
                    size: 1536,
                    content_id: 2
                }
            ]
        },
        live: {
            data: [
                {
                    id: 1,
                    title: "Week 1: HTML/CSS Live Session",
                    batch_id: 1,
                    start_time: "2024-01-20T10:00:00",
                    end_time: "2024-01-20T12:00:00",
                    status: "completed"
                },
                {
                    id: 2,
                    title: "Week 2: JavaScript Live Session",
                    batch_id: 1,
                    start_time: "2024-01-27T10:00:00",
                    end_time: "2024-01-27T12:00:00",
                    status: "upcoming"
                },
                {
                    id: 3,
                    title: "Week 1: Python for Data Science",
                    batch_id: 2,
                    start_time: "2024-02-10T14:00:00",
                    end_time: "2024-02-10T16:00:00",
                    status: "scheduled"
                }
            ]
        }
    };

    // Save individual files
    Object.keys(sampleData).forEach(key => {
        const filePath = path.join(DATA_DIR, `${key}.json`);
        fs.writeFileSync(filePath, JSON.stringify(sampleData[key], null, 2));
        log.success(`${key}.json created`);
    });

    // Save combined data
    fs.writeFileSync(
        path.join(DATA_DIR, 'all-data.json'),
        JSON.stringify({
            extractedAt: new Date().toISOString(),
            data: sampleData
        }, null, 2)
    );
    
    log.success('All data files created');
    return sampleData;
}

// ============ DATABASE FUNCTIONS ============

function createTables(db) {
    return new Promise((resolve, reject) => {
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
                )`
            ];

            let completed = 0;
            tables.forEach(sql => {
                db.run(sql, (err) => {
                    if (err) reject(err);
                    completed++;
                    if (completed === tables.length) {
                        log.success('Database tables created/verified');
                        resolve();
                    }
                });
            });
        });
    });
}

function insertData(db, data) {
    return new Promise((resolve, reject) => {
        db.serialize(() => {
            try {
                // Insert batches
                if (data.batches?.data) {
                    const stmt = db.prepare(`
                        INSERT OR REPLACE INTO batches (id, name, description, start_date, end_date, status, course_id, raw_data)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    `);
                    const items = Array.isArray(data.batches.data) ? data.batches.data : [data.batches.data];
                    items.forEach(item => {
                        stmt.run(
                            item.id || null,
                            item.name || item.title || null,
                            item.description || null,
                            item.start_date || item.startDate || null,
                            item.end_date || item.endDate || null,
                            item.status || 'active',
                            item.course_id || item.courseId || null,
                            JSON.stringify(item)
                        );
                    });
                    stmt.finalize();
                    log.success(`Batches: ${items.length} records inserted`);
                }

                // Insert courses
                if (data.courses?.data) {
                    const stmt = db.prepare(`
                        INSERT OR REPLACE INTO courses (id, name, description, category, duration, price, raw_data)
                        VALUES (?, ?, ?, ?, ?, ?, ?)
                    `);
                    const items = Array.isArray(data.courses.data) ? data.courses.data : [data.courses.data];
                    items.forEach(item => {
                        stmt.run(
                            item.id || null,
                            item.name || item.title || null,
                            item.description || null,
                            item.category || null,
                            item.duration || null,
                            item.price || 0,
                            JSON.stringify(item)
                        );
                    });
                    stmt.finalize();
                    log.success(`Courses: ${items.length} records inserted`);
                }

                // Insert contents
                if (data.contents?.data) {
                    const stmt = db.prepare(`
                        INSERT OR REPLACE INTO contents (id, title, description, type, course_id, batch_id, url, raw_data)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    `);
                    const items = Array.isArray(data.contents.data) ? data.contents.data : [data.contents.data];
                    items.forEach(item => {
                        stmt.run(
                            item.id || null,
                            item.title || null,
                            item.description || null,
                            item.type || 'video',
                            item.course_id || item.courseId || null,
                            item.batch_id || item.batchId || null,
                            item.url || null,
                            JSON.stringify(item)
                        );
                    });
                    stmt.finalize();
                    log.success(`Contents: ${items.length} records inserted`);
                }

                // Insert media
                if (data.media?.data) {
                    const stmt = db.prepare(`
                        INSERT OR REPLACE INTO media (id, title, type, url, duration, size, content_id, raw_data)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    `);
                    const items = Array.isArray(data.media.data) ? data.media.data : [data.media.data];
                    items.forEach(item => {
                        stmt.run(
                            item.id || null,
                            item.title || null,
                            item.type || 'file',
                            item.url || null,
                            item.duration || 0,
                            item.size || 0,
                            item.content_id || item.contentId || null,
                            JSON.stringify(item)
                        );
                    });
                    stmt.finalize();
                    log.success(`Media: ${items.length} records inserted`);
                }

                // Insert live sessions
                if (data.live?.data) {
                    const stmt = db.prepare(`
                        INSERT OR REPLACE INTO live_sessions (id, title, batch_id, start_time, end_time, status, token, raw_data)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    `);
                    const items = Array.isArray(data.live.data) ? data.live.data : [data.live.data];
                    items.forEach(item => {
                        stmt.run(
                            item.id || null,
                            item.title || null,
                            item.batch_id || item.batchId || null,
                            item.start_time || item.startTime || null,
                            item.end_time || item.endTime || null,
                            item.status || 'scheduled',
                            item.token || null,
                            JSON.stringify(item)
                        );
                    });
                    stmt.finalize();
                    log.success(`Live Sessions: ${items.length} records inserted`);
                }

                resolve();
            } catch (error) {
                reject(error);
            }
        });
    });
}

function getStats(db) {
    return new Promise((resolve, reject) => {
        db.all(`
            SELECT 
                (SELECT COUNT(*) FROM batches) as total_batches,
                (SELECT COUNT(*) FROM courses) as total_courses,
                (SELECT COUNT(*) FROM contents) as total_contents,
                (SELECT COUNT(*) FROM media) as total_media,
                (SELECT COUNT(*) FROM live_sessions) as total_live_sessions
        `, (err, rows) => {
            if (err) reject(err);
            else resolve(rows[0]);
        });
    });
}

// ============ MAIN AUTO SETUP FUNCTION ============

async function autoSetup() {
    console.log('\n' + '='.repeat(60));
    console.log('🚀 BRAINBOX API - AUTOMATIC SETUP');
    console.log('='.repeat(60) + '\n');

    let db = null;

    try {
        // Step 1: Create sample data
        log.section('STEP 1: Creating Data Structure');
        const data = createSampleData();

        // Step 2: Initialize database
        log.section('STEP 2: Setting up Database');
        db = new sqlite3.Database(DB_PATH);
        log.success(`Database created: ${DB_PATH}`);

        // Step 3: Create tables
        log.section('STEP 3: Creating Tables');
        await createTables(db);

        // Step 4: Insert data
        log.section('STEP 4: Inserting Data');
        await insertData(db, data);

        // Step 5: Get statistics
        log.section('STEP 5: Setup Complete!');
        const stats = await getStats(db);
        
        console.log('\n📊 DATABASE STATISTICS:');
        console.log(`   🎓 Total Batches: ${stats.total_batches || 0}`);
        console.log(`   📚 Total Courses: ${stats.total_courses || 0}`);
        console.log(`   📝 Total Contents: ${stats.total_contents || 0}`);
        console.log(`   🎬 Total Media: ${stats.total_media || 0}`);
        console.log(`   🎥 Total Live Sessions: ${stats.total_live_sessions || 0}`);

        console.log('\n' + '='.repeat(60));
        console.log('✅ SETUP COMPLETE! Ready to start server');
        console.log('='.repeat(60) + '\n');

        // Close database
        db.close((err) => {
            if (err) {
                console.error('Error closing database:', err);
            }
        });

        return true;

    } catch (error) {
        console.error('\n❌ Setup failed:', error);
        if (db) {
            db.close();
        }
        return false;
    }
}

// Run setup if called directly
if (require.main === module) {
    autoSetup()
        .then((success) => {
            if (success) {
                process.exit(0);
            } else {
                process.exit(1);
            }
        })
        .catch((error) => {
            console.error('Fatal error:', error);
            process.exit(1);
        });
}

module.exports = { autoSetup };
