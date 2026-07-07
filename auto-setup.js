// auto-setup.js - Reads data from GitHub-stored JSON files
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const DATA_DIR = './data';
const DB_PATH = process.env.DATABASE_PATH || './brainbox.db';

// ============ LOGGING ============
const log = {
    info: (msg) => console.log(`ℹ️ ${msg}`),
    success: (msg) => console.log(`✅ ${msg}`),
    error: (msg) => console.log(`❌ ${msg}`),
    warn: (msg) => console.log(`⚠️ ${msg}`),
    section: (msg) => console.log(`\n📌 ${msg}`)
};

// ============ READ DATA FROM GITHUB FILES ============
function readDataFromFiles() {
    log.section('READING DATA FROM GITHUB');
    
    const dataTypes = ['batches', 'courses', 'contents', 'media', 'live'];
    const allData = {};
    
    dataTypes.forEach(type => {
        const filePath = path.join(DATA_DIR, `${type}.json`);
        
        if (fs.existsSync(filePath)) {
            try {
                const fileContent = fs.readFileSync(filePath, 'utf8');
                const jsonData = JSON.parse(fileContent);
                allData[type] = jsonData;
                log.success(`✅ Read ${type}.json - ${jsonData.data?.length || 0} records`);
            } catch (error) {
                log.error(`❌ Failed to read ${type}.json: ${error.message}`);
                allData[type] = { data: [] };
            }
        } else {
            log.warn(`⚠️ ${type}.json not found, creating empty dataset`);
            allData[type] = { data: [] };
            
            // Create empty file
            fs.writeFileSync(
                filePath,
                JSON.stringify({ data: [] }, null, 2)
            );
        }
    });
    
    return allData;
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
    console.log('🚀 BRAINBOX API - AUTO SETUP FROM GITHUB');
    console.log('='.repeat(60) + '\n');

    let db = null;

    try {
        // Step 1: Read data from GitHub files
        const data = readDataFromFiles();

        // Step 2: Initialize database
        log.section('SETTING UP DATABASE');
        db = new sqlite3.Database(DB_PATH);
        log.success(`Database created: ${DB_PATH}`);

        // Step 3: Create tables
        log.section('CREATING TABLES');
        await createTables(db);

        // Step 4: Insert data
        log.section('INSERTING DATA');
        await insertData(db, data);

        // Step 5: Get statistics
        log.section('SETUP COMPLETE!');
        const stats = await getStats(db);
        
        console.log('\n📊 DATABASE STATISTICS:');
        console.log(`   🎓 Total Batches: ${stats.total_batches || 0}`);
        console.log(`   📚 Total Courses: ${stats.total_courses || 0}`);
        console.log(`   📝 Total Contents: ${stats.total_contents || 0}`);
        console.log(`   🎬 Total Media: ${stats.total_media || 0}`);
        console.log(`   🎥 Total Live Sessions: ${stats.total_live_sessions || 0}`);

        console.log('\n' + '='.repeat(60));
        console.log('✅ SETUP COMPLETE! Data loaded from GitHub');
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
