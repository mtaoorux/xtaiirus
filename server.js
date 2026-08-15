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

// Improved token fetching with fallback
async function fetchToken() {
    try {
        console.log('📡 Fetching token from:', TOKEN_URL);
        const response = await axios.get(TOKEN_URL, { 
            timeout: 10000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });
        
        const data = response.data;
        console.log('📦 Token data structure:', typeof data, Array.isArray(data) ? `Array with ${data.length} items` : 'Object');
        
        // Handle array of token objects
        if (Array.isArray(data) && data.length > 0) {
            // Log first item structure
            console.log('🔍 First token item:', JSON.stringify(data[0]).substring(0, 200));
            
            // Try to find token for userId 1880403
            let tokenEntry = data.find(item => item.userId === '1880403' || item.userId === 1880403);
            if (!tokenEntry) {
                tokenEntry = data[0]; // Fallback to first token
            }
            
            if (tokenEntry) {
                let token = tokenEntry.token || tokenEntry.accessToken || tokenEntry.access_token;
                if (token) {
                    // Clean token
                    token = token.replace(/\\n/g, '').replace(/\\r/g, '').trim();
                    console.log(`✅ Token fetched for userId: ${tokenEntry.userId || 'unknown'}`);
                    return token;
                }
            }
        }
        
        // If data is a single object with token
        if (data.token || data.accessToken || data.access_token) {
            let token = data.token || data.accessToken || data.access_token;
            token = token.replace(/\\n/g, '').replace(/\\r/g, '').trim();
            console.log('✅ Token fetched from single object');
            return token;
        }
        
        // If data itself is a token string
        if (typeof data === 'string' && data.length > 10) {
            return data.trim();
        }
        
        throw new Error('No valid token found in response');
    } catch (error) {
        console.error('❌ Error fetching token:', error.message);
        if (error.response) {
            console.error('📄 Response status:', error.response.status);
            console.error('📄 Response data:', JSON.stringify(error.response.data).substring(0, 200));
        }
        throw error;
    }
}

// Test endpoint to debug token
app.get('/api/test/token', async (req, res) => {
    try {
        const token = await fetchToken();
        res.json({
            success: true,
            token: token.substring(0, 50) + '...',
            token_length: token.length,
            token_source: TOKEN_URL
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message,
            stack: error.stack
        });
    }
});

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
        
        // Try to get token from environment or fetch
        let token;
        try {
            token = process.env.TOKEN || await fetchToken();
        } catch (error) {
            return res.status(401).json({
                success: false,
                error: 'Authentication failed: Unable to fetch token',
                details: error.message
            });
        }
        
        // Construct URL
        const url = `${BASE_URL}${ENDPOINT}?course_id=${course_id}&video_id=${video_id}&ytflag=${ytflag}&folder_wise_course=${folder_wise_course}`;
        
        console.log(`📡 Fetching from Sachin Academy API...`);
        console.log(`🔗 URL: ${url}`);
        console.log(`📚 Course ID: ${course_id}, Video ID: ${video_id}`);
        console.log(`🔑 Token (first 20 chars): ${token.substring(0, 20)}...`);
        
        // Make API request
        const response = await axios.get(url, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            timeout: 30000
        });
        
        console.log('✅ API Response received:', response.status);
        
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
            console.error('📄 Response status:', error.response.status);
            console.error('📄 Response data:', JSON.stringify(error.response.data));
            return res.status(error.response.status).json({
                success: false,
                error: 'API request failed',
                status: error.response.status,
                data: error.response.data,
                message: error.response.data?.message || error.message
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
                details: error.message,
                stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
            });
        }
    }
});

// Debug endpoint to check environment
app.get('/api/debug', (req, res) => {
    res.json({
        environment: process.env.NODE_ENV || 'development',
        base_url: BASE_URL,
        token_url: TOKEN_URL,
        responses_dir: RESPONSES_DIR,
        node_version: process.version,
        platform: process.platform
    });
});

// Start server
app.listen(PORT, async () => {
    await ensureResponsesDir();
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`🔗 Base URL: ${BASE_URL}`);
    console.log(`📁 Responses saved to: ${RESPONSES_DIR}`);
    
    // Test endpoints
    console.log('\n📋 Test the API:');
    console.log(`1. Debug: http://localhost:${PORT}/api/debug`);
    console.log(`2. Test Token: http://localhost:${PORT}/api/test/token`);
    console.log(`3. Fetch Video: http://localhost:${PORT}/api/video/details?course_id=281&video_id=330105`);
});
