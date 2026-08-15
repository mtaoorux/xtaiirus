const express = require('express');
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const cors = require('cors');
const morgan = require('morgan');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(morgan('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Constants
const TOKEN_URL = 'https://mtaiirus.vercel.app/apv/tokenbyxyro-mtaiirus.json';
const BASE_URL = process.env.BASE_URL || 'https://sachinacademyapi.classx.co.in';
const ENDPOINT = '/get/fetchVideoDetailsById';
const RESPONSES_DIR = path.join(__dirname, 'responses');

// Ensure responses directory exists
async function ensureResponsesDir() {
    try {
        await fs.mkdir(RESPONSES_DIR, { recursive: true });
    } catch (error) {
        console.error('Error creating responses directory:', error);
    }
}

// Fetch token from URL
async function fetchToken() {
    try {
        console.log('📡 Fetching token from:', TOKEN_URL);
        const response = await axios.get(TOKEN_URL, { timeout: 10000 });
        const data = response.data;
        
        // Handle array of token objects
        if (Array.isArray(data) && data.length > 0) {
            // Try to find token for userId 1880403 (most recent)
            let tokenEntry = data.find(item => item.userId === '1880403');
            if (!tokenEntry) {
                tokenEntry = data[0]; // Fallback to first token
            }
            if (tokenEntry && tokenEntry.token) {
                let token = tokenEntry.token;
                // Clean token - remove any extra characters
                if (token.includes('\\n')) {
                    token = token.replace(/\\n/g, '').trim();
                }
                console.log(`✅ Token fetched for userId: ${tokenEntry.userId}`);
                return token;
            }
        }
        
        // If data is a single object with token
        if (data.token) {
            return data.token;
        }
        
        throw new Error('No valid token found in response');
    } catch (error) {
        console.error('❌ Error fetching token:', error.message);
        throw error;
    }
}

// API: Fetch video details (GET)
app.get('/api/video/details', async (req, res) => {
    try {
        const { course_id, video_id, ytflag = 0, folder_wise_course = 0 } = req.query;
        
        // Validate required parameters
        if (!course_id || !video_id) {
            return res.status(400).json({
                success: false,
                error: 'Missing required parameters: course_id and video_id are required'
            });
        }
        
        // Fetch token
        let token;
        try {
            token = await fetchToken();
        } catch (error) {
            return res.status(401).json({
                success: false,
                error: 'Authentication failed: Unable to fetch token',
                details: error.message
            });
        }
        
        // Construct URL with query parameters directly in URL
        const url = `${BASE_URL}${ENDPOINT}?course_id=${course_id}&video_id=${video_id}&ytflag=${ytflag}&folder_wise_course=${folder_wise_course}&lc_app_api_url=`;
        
        console.log(`📡 Fetching from Sachin Academy API...`);
        console.log(`🔗 URL: ${url}`);
        console.log(`📚 Course ID: ${course_id}, Video ID: ${video_id}`);
        
        // Make API request
        const response = await axios.get(url, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            timeout: 30000
        });
        
        // Save response to file
        const timestamp = Date.now();
        const filename = `video_details_${course_id}_${video_id}_${timestamp}.json`;
        await ensureResponsesDir();
        const filePath = path.join(RESPONSES_DIR, filename);
        await fs.writeFile(filePath, JSON.stringify(response.data, null, 2));
        console.log(`💾 Response saved to ${filePath}`);
        
        // Return response
        res.json({
            success: true,
            data: response.data,
            saved_to: filename,
            timestamp: new Date().toISOString(),
            course_id: course_id,
            video_id: video_id
        });
        
    } catch (error) {
        console.error('❌ Error fetching video details:', error.message);
        
        if (error.response) {
            return res.status(error.response.status).json({
                success: false,
                error: 'API request failed',
                status: error.response.status,
                data: error.response.data
            });
        } else if (error.request) {
            return res.status(503).json({
                success: false,
                error: 'No response from Sachin Academy API',
                details: error.message
            });
        } else {
            return res.status(500).json({
                success: false,
                error: 'Internal server error',
                details: error.message
            });
        }
    }
});

// API: Fetch video details (POST)
app.post('/api/video/fetch', async (req, res) => {
    try {
        const { course_id, video_id, ytflag = 0, folder_wise_course = 0 } = req.body;
        
        if (!course_id || !video_id) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields: course_id and video_id'
            });
        }
        
        // Fetch token
        const token = await fetchToken();
        
        // Construct URL
        const url = `${BASE_URL}${ENDPOINT}?course_id=${course_id}&video_id=${video_id}&ytflag=${ytflag}&folder_wise_course=${folder_wise_course}&lc_app_api_url=`;
        
        console.log(`📡 Fetching from Sachin Academy API (POST)...`);
        console.log(`🔗 URL: ${url}`);
        
        const response = await axios.get(url, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            timeout: 30000
        });
        
        // Save response
        const timestamp = Date.now();
        const filename = `video_details_${course_id}_${video_id}_${timestamp}.json`;
        await ensureResponsesDir();
        const filePath = path.join(RESPONSES_DIR, filename);
        await fs.writeFile(filePath, JSON.stringify(response.data, null, 2));
        
        res.json({
            success: true,
            data: response.data,
            saved_to: filename,
            timestamp: new Date().toISOString(),
            course_id: course_id,
            video_id: video_id
        });
        
    } catch (error) {
        console.error('❌ Error:', error.message);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch video details',
            details: error.message
        });
    }
});

// API: Fetch all course videos (optional)
app.get('/api/course/:course_id/videos', async (req, res) => {
    try {
        const { course_id } = req.params;
        const { ytflag = 0, folder_wise_course = 0 } = req.query;
        
        if (!course_id) {
            return res.status(400).json({
                success: false,
                error: 'Course ID is required'
            });
        }
        
        // This endpoint could be extended to fetch multiple videos
        // For now, we'll just return a list of saved responses for this course
        await ensureResponsesDir();
        const files = await fs.readdir(RESPONSES_DIR);
        const courseFiles = files
            .filter(file => file.includes(`_${course_id}_`))
            .map(file => ({
                filename: file,
                path: `/api/responses/${file}`,
                timestamp: file.replace('video_details_', '').replace('.json', '')
            }));
        
        res.json({
            success: true,
            course_id: course_id,
            count: courseFiles.length,
            files: courseFiles
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: 'Failed to fetch course videos',
            details: error.message
        });
    }
});

// API: Fetch token status
app.get('/api/token/status', async (req, res) => {
    try {
        const token = await fetchToken();
        res.json({
            success: true,
            token_exists: true,
            token_length: token.length,
            token_preview: token.substring(0, 20) + '...',
            source: TOKEN_URL,
            base_url: BASE_URL
        });
    } catch (error) {
        res.json({
            success: false,
            token_exists: false,
            error: error.message,
            source: TOKEN_URL,
            base_url: BASE_URL
        });
    }
});

// API: Get all saved responses
app.get('/api/responses', async (req, res) => {
    try {
        await ensureResponsesDir();
        const files = await fs.readdir(RESPONSES_DIR);
        const responseFiles = files
            .filter(file => file.endsWith('.json'))
            .map(file => {
                // Extract course_id and video_id from filename
                const parts = file.replace('video_details_', '').replace('.json', '').split('_');
                let course_id = null;
                let video_id = null;
                let timestamp = parts[parts.length - 1];
                
                if (parts.length >= 3) {
                    course_id = parts[0];
                    video_id = parts[1];
                }
                
                return {
                    filename: file,
                    path: `/api/responses/${file}`,
                    course_id: course_id,
                    video_id: video_id,
                    timestamp: timestamp
                };
            })
            .sort((a, b) => b.timestamp - a.timestamp);
        
        res.json({
            success: true,
            count: responseFiles.length,
            files: responseFiles
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: 'Failed to list responses',
            details: error.message
        });
    }
});

// API: Get specific response
app.get('/api/responses/:filename', async (req, res) => {
    try {
        const { filename } = req.params;
        const filePath = path.join(RESPONSES_DIR, filename);
        const data = await fs.readFile(filePath, 'utf8');
        res.json(JSON.parse(data));
    } catch (error) {
        res.status(404).json({
            success: false,
            error: 'Response file not found'
        });
    }
});

// Root endpoint
app.get('/', (req, res) => {
    res.json({
        name: 'Sachin Academy Video API Server',
        version: '1.0.0',
        description: 'Fetches video details from Sachin Academy API',
        base_url: BASE_URL,
        token_source: TOKEN_URL,
        endpoints: {
            'GET /api/video/details': 'Fetch video details (params: course_id, video_id, ytflag, folder_wise_course)',
            'POST /api/video/fetch': 'Fetch video details (body: course_id, video_id, ytflag, folder_wise_course)',
            'GET /api/course/:course_id/videos': 'Get saved videos for a course',
            'GET /api/responses': 'List saved responses',
            'GET /api/responses/:filename': 'Get specific response file',
            'GET /api/token/status': 'Check token status',
            'GET /': 'This help message'
        },
        example: '/api/video/details?course_id=281&video_id=330105'
    });
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({
        success: false,
        error: 'Internal server error',
        details: err.message
    });
});

// Start server
app.listen(PORT, async () => {
    await ensureResponsesDir();
    console.log(`🚀 Sachin Academy Video API Server running on http://localhost:${PORT}`);
    console.log(`🔗 Base URL: ${BASE_URL}`);
    console.log(`🔗 Token source: ${TOKEN_URL}`);
    console.log(`📁 Responses saved to: ${RESPONSES_DIR}`);
    console.log('\n📋 Available endpoints:');
    console.log(`  GET  /api/video/details?course_id=281&video_id=330105`);
    console.log(`  POST /api/video/fetch (body: { course_id, video_id })`);
    console.log(`  GET  /api/course/:course_id/videos`);
    console.log(`  GET  /api/responses`);
    console.log(`  GET  /api/token/status`);
    console.log(`  GET  /`);
    
    // Test token on startup
    try {
        const token = await fetchToken();
        console.log(`✅ Token verified (length: ${token.length})`);
        console.log(`✅ Server ready to fetch from Sachin Academy API`);
    } catch (error) {
        console.log(`⚠️  Token verification failed: ${error.message}`);
        console.log(`⚠️  Please check token source: ${TOKEN_URL}`);
    }
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n👋 Shutting down server...');
    process.exit(0);
});
