// ==========================================================
// ASB API SERVER - Nexttoppers Course Proxy
// Direct API Integration with No Frontend Dependencies
// ==========================================================

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ==========================================
// CONFIGURATION
// ==========================================
const CONFIG = {
    // Nexttoppers API Headers
    NT_HEADERS: {
        'accept': 'application/json, text/plain, */*',
        'app_id': '1772100600',
        'authorization': 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VyX2lkIjozMTY4MDcyLCJhcHBfaWQiOiIxNzcyMTAwNjAwIiwiZGV2aWNlX2lkIjoiNmZiYzk3OGYtYmEzZC00ZjcyLTg2ZTItZGI3OGI1MzY3YzQwIiwicGxhdGZvcm0iOiIzIiwidXNlcl90eXBlIjoxLCJpYXQiOjE3ODQ0NDMyNzgsImV4cCI6MTc4NzAzNTI3OH0.Ub-QZZHhSpS5i-GZRW79f29JlIHMCng90j6Q3QtlzcU',
        'content-type': 'application/json',
        'origin': 'https://missionjeet.in',
        'platform': '3',
        'referer': 'https://missionjeet.in/',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'user_id': '3168072',
        'version': '1'
    },
    
    // API Endpoints
    API: {
        OVERVIEW: 'https://course.nexttoppers.com/course/course-details',
        CONTENT: 'https://course.nexttoppers.com/course/all-content',
        MEDIA: 'https://course.nexttoppers.com/course/content-details',
        CONTENT_DETAILS: 'https://sp-api-seven.vercel.app/api/content-details'
    }
};

// ==========================================
// CORE ASB API FUNCTIONS
// ==========================================

/**
 * Make ASB API Request to Nexttoppers
 */
async function asbRequest(endpoint, method = 'POST', payload = null) {
    try {
        const response = await axios({
            method: method,
            url: endpoint,
            headers: CONFIG.NT_HEADERS,
            data: payload || {},
            timeout: 30000
        });
        
        return {
            success: true,
            data: response.data,
            status: response.status
        };
    } catch (error) {
        console.error('ASB API Error:', error.message);
        
        // Return error response
        return {
            success: false,
            error: error.message,
            status: error.response?.status || 500,
            data: error.response?.data || null
        };
    }
}

/**
 * Fetch Course Overview
 */
async function getCourseOverview(courseId) {
    const payload = {
        course_id: String(courseId),
        parent_id: "0"
    };
    
    return await asbRequest(
        CONFIG.API.OVERVIEW,
        'POST',
        payload
    );
}

/**
 * Fetch Course Content (Folders & Items)
 */
async function getCourseContent(courseId, folderId = "0", limit = "1000", page = "1") {
    const payload = {
        course_id: String(courseId),
        folder_id: String(folderId),
        is_free: "",
        keyword: "",
        limit: String(limit),
        page: String(page),
        parent_course_id: "0"
    };
    
    return await asbRequest(
        CONFIG.API.CONTENT,
        'POST',
        payload
    );
}

/**
 * Fetch Media Details
 */
async function getMediaDetails(contentId, courseId) {
    const payload = {
        content_id: String(contentId),
        course_id: String(courseId)
    };
    
    return await asbRequest(
        CONFIG.API.MEDIA,
        'POST',
        payload
    );
}

/**
 * Get Content Details with Direct API (For PDFs/Documents)
 */
async function getContentDetails(contentId, courseId) {
    try {
        const url = `${CONFIG.API.CONTENT_DETAILS}?content_id=${contentId}&course_id=${courseId}`;
        const response = await axios({
            method: 'GET',
            url: url,
            headers: CONFIG.NT_HEADERS,
            timeout: 30000
        });
        
        return {
            success: true,
            data: response.data,
            status: response.status
        };
    } catch (error) {
        return {
            success: false,
            error: error.message,
            status: error.response?.status || 500
        };
    }
}

// ==========================================
// BATCH PROCESSING FUNCTIONS
// ==========================================

/**
 * Get Multiple Course Overviews
 */
async function getMultipleCourses(courseIds) {
    const results = [];
    
    for (const id of courseIds) {
        const data = await getCourseOverview(id);
        results.push({
            course_id: id,
            data: data
        });
    }
    
    return results;
}

/**
 * Scan Course for Live Content
 */
async function scanForLiveContent(courseId, maxDepth = 5) {
    const liveItems = [];
    const scannedFolders = new Set();
    
    async function scanFolder(folderId, depth = 0) {
        if (depth > maxDepth || scannedFolders.has(folderId)) return;
        scannedFolders.add(folderId);
        
        const content = await getCourseContent(courseId, folderId);
        if (!content.success || !content.data || !content.data.data) return;
        
        const items = Array.isArray(content.data.data) 
            ? content.data.data 
            : (Array.isArray(content.data.data.list) ? content.data.data.list : []);
        
        const subFolders = [];
        
        for (const item of items) {
            const type = (item.type || "").toLowerCase();
            const d = item.data || {};
            const vType = parseInt(item.video_type || d.video_type || 0);
            
            // Check for live content
            if (vType === 3 || type === 'live' || 
                parseInt(d.is_live) === 1 || parseInt(item.is_live) === 1) {
                liveItems.push({
                    ...item,
                    parent_folder_id: folderId
                });
            }
            
            // Collect sub-folders
            if (type === 'folder' || type === 'subject' || type === 'chapter') {
                const id = d.id || item.entity_id || item.id;
                if (id) subFolders.push(id);
            }
        }
        
        // Recursively scan sub-folders
        for (const subId of subFolders) {
            await scanFolder(subId, depth + 1);
        }
    }
    
    await scanFolder("0");
    return liveItems;
}

// ==========================================
// ROUTES
// ==========================================

// Health Check
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        version: '1.0.0'
    });
});

// Get Course Overview
app.get('/api/course/:courseId/overview', async (req, res) => {
    const { courseId } = req.params;
    const result = await getCourseOverview(courseId);
    
    if (result.success) {
        res.json(result);
    } else {
        res.status(result.status || 500).json(result);
    }
});

// Get Course Content
app.get('/api/course/:courseId/content', async (req, res) => {
    const { courseId } = req.params;
    const { folder_id = "0", limit = "1000", page = "1" } = req.query;
    
    const result = await getCourseContent(courseId, folder_id, limit, page);
    
    if (result.success) {
        res.json(result);
    } else {
        res.status(result.status || 500).json(result);
    }
});

// Get Media Details
app.get('/api/media/:contentId', async (req, res) => {
    const { contentId } = req.params;
    const { courseId } = req.query;
    
    if (!courseId) {
        return res.status(400).json({
            success: false,
            error: 'courseId is required'
        });
    }
    
    const result = await getMediaDetails(contentId, courseId);
    
    if (result.success) {
        res.json(result);
    } else {
        res.status(result.status || 500).json(result);
    }
});

// Get Content Details (PDF/Document Support)
app.get('/api/content-details/:contentId', async (req, res) => {
    const { contentId } = req.params;
    const { courseId } = req.query;
    
    if (!courseId) {
        return res.status(400).json({
            success: false,
            error: 'courseId is required'
        });
    }
    
    const result = await getContentDetails(contentId, courseId);
    
    if (result.success) {
        res.json(result);
    } else {
        res.status(result.status || 500).json(result);
    }
});

// Scan for Live Content
app.get('/api/course/:courseId/live', async (req, res) => {
    const { courseId } = req.params;
    const { maxDepth = 5 } = req.query;
    
    try {
        const liveItems = await scanForLiveContent(courseId, parseInt(maxDepth));
        res.json({
            success: true,
            data: liveItems,
            count: liveItems.length
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Batch Course Overview
app.post('/api/courses/batch', async (req, res) => {
    const { courseIds } = req.body;
    
    if (!courseIds || !Array.isArray(courseIds)) {
        return res.status(400).json({
            success: false,
            error: 'courseIds array is required'
        });
    }
    
    const results = await getMultipleCourses(courseIds);
    res.json({
        success: true,
        data: results
    });
});

// Generic Proxy - Forward any request to Nexttoppers
app.post('/api/proxy', async (req, res) => {
    const { target_url, method = 'POST', payload = null } = req.body;
    
    if (!target_url) {
        return res.status(400).json({
            success: false,
            error: 'target_url is required'
        });
    }
    
    const result = await asbRequest(target_url, method, payload);
    
    if (result.success) {
        res.json(result);
    } else {
        res.status(result.status || 500).json(result);
    }
});

// ==========================================
// BATCH SCANNER - Auto Discover Courses
// ==========================================

// Course ID ranges to scan
const COURSE_IDS = [];
for (let i = 185; i >= 184; i--) COURSE_IDS.push(i);
for (let i = 152; i >= 151; i--) COURSE_IDS.push(i);
for (let i = 161; i >= 160; i--) COURSE_IDS.push(i);

// Discover all available courses
app.get('/api/discover', async (req, res) => {
    const results = [];
    
    for (const id of COURSE_IDS) {
        try {
            const overview = await getCourseOverview(id);
            if (overview.success && overview.data && overview.data.data) {
                const details = overview.data.data.find(d => d.type === 'overview');
                if (details && details.data) {
                    const layout = details.data.find(l => l.layout_type === 'details');
                    if (layout && layout.layout_data && layout.layout_data[0]) {
                        const batchInfo = layout.layout_data[0];
                        results.push({
                            id: id,
                            title: batchInfo.title,
                            thumbnail: batchInfo.thumbnail,
                            price: batchInfo.offer_price || 0,
                            mrp: batchInfo.mrp || 0,
                            description: batchInfo.description
                        });
                    }
                }
            }
        } catch (error) {
            console.error(`Failed to fetch course ${id}:`, error.message);
        }
    }
    
    res.json({
        success: true,
        data: results,
        count: results.length
    });
});

// ==========================================
// ERROR HANDLING
// ==========================================

// 404 Handler
app.use((req, res) => {
    res.status(404).json({
        success: false,
        error: 'Route not found',
        path: req.originalUrl
    });
});

// Global Error Handler
app.use((err, req, res, next) => {
    console.error('Server Error:', err);
    res.status(500).json({
        success: false,
        error: 'Internal server error',
        message: err.message
    });
});

// ==========================================
// START SERVER
// ==========================================

app.listen(PORT, () => {
    console.log(`========================================`);
    console.log(`🚀 ASB API Server is running`);
    console.log(`📡 Port: ${PORT}`);
    console.log(`🌐 URL: http://localhost:${PORT}`);
    console.log(`========================================`);
    console.log(`📚 Available Routes:`);
    console.log(`  GET  /health`);
    console.log(`  GET  /api/course/:courseId/overview`);
    console.log(`  GET  /api/course/:courseId/content`);
    console.log(`  GET  /api/course/:courseId/live`);
    console.log(`  GET  /api/media/:contentId?courseId=xxx`);
    console.log(`  GET  /api/content-details/:contentId?courseId=xxx`);
    console.log(`  POST /api/courses/batch`);
    console.log(`  POST /api/proxy`);
    console.log(`  GET  /api/discover`);
    console.log(`========================================`);
});

module.exports = app;
