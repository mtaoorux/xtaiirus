// extractBrainboxData.js - Updated for Render
require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// Configuration from environment variables
const BASE_URL = process.env.BASE_URL || 'https://nt.brainboxinstitute.in';
const TOKEN = process.env.TOKEN;

if (!TOKEN) {
    console.error('❌ TOKEN environment variable is required!');
    console.log('Please set TOKEN in your .env file or Render environment variables.');
    process.exit(1);
}

// Create directories
const DATA_DIR = './extracted-data';
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

// API endpoints configuration
const endpoints = [
    {
        name: 'batches',
        url: '/api/nt/batches',
        method: 'GET',
        requiresToken: false
    },
    {
        name: 'courses',
        url: '/api/nt/course',
        method: 'GET',
        requiresToken: true,
        params: { token: TOKEN }
    },
    {
        name: 'contents',
        url: '/api/nt/content',
        method: 'GET',
        requiresToken: true,
        params: { token: TOKEN }
    },
    {
        name: 'media',
        url: '/api/nt/media',
        method: 'GET',
        requiresToken: true,
        params: { token: TOKEN }
    },
    {
        name: 'live',
        url: '/api/nt/live',
        method: 'GET',
        requiresToken: true,
        params: { token: TOKEN }
    }
];

// Custom delay between requests
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Main extraction function
async function extractAllData() {
    console.log('🚀 Starting data extraction from Brainbox API...');
    console.log(`📡 Base URL: ${BASE_URL}\n`);
    
    const allData = {};
    let totalItems = 0;

    for (const endpoint of endpoints) {
        try {
            console.log(`📡 Fetching ${endpoint.name}...`);
            
            const params = endpoint.params || {};
            const response = await axios.get(`${BASE_URL}${endpoint.url}`, {
                params: params,
                headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': 'Brainbox-Extractor/1.0'
                },
                timeout: 30000 // 30 second timeout
            });

            // Store data
            allData[endpoint.name] = response.data;
            
            // Count items
            let itemCount = 0;
            if (Array.isArray(response.data)) {
                itemCount = response.data.length;
            } else if (response.data.data) {
                if (Array.isArray(response.data.data)) {
                    itemCount = response.data.data.length;
                } else {
                    itemCount = 1;
                }
            }
            totalItems += itemCount;

            // Save individual file
            fs.writeFileSync(
                path.join(DATA_DIR, `${endpoint.name}.json`),
                JSON.stringify(response.data, null, 2)
            );

            console.log(`✅ ${endpoint.name}: ${itemCount} items saved`);
            
            // If live data exists, fetch live-token for each batch
            if (endpoint.name === 'live' && response.data && response.data.data) {
                await extractLiveTokens(response.data.data);
            }

            // Wait between requests
            await delay(1000);

        } catch (error) {
            console.error(`❌ Failed to fetch ${endpoint.name}:`, error.message);
            allData[endpoint.name] = { error: error.message };
            
            // Save error state
            fs.writeFileSync(
                path.join(DATA_DIR, `${endpoint.name}-error.json`),
                JSON.stringify({ 
                    error: error.message, 
                    timestamp: new Date().toISOString() 
                }, null, 2)
            );
        }
    }

    // Save combined data
    fs.writeFileSync(
        path.join(DATA_DIR, 'all-data-combined.json'),
        JSON.stringify({
            extractedAt: new Date().toISOString(),
            totalItems: totalItems,
            data: allData
        }, null, 2)
    );

    console.log(`\n📦 Extraction complete! Total items: ${totalItems}`);
    console.log(`📁 Data saved in ${DATA_DIR}/`);
    
    return allData;
}

// Function to extract live tokens for each batch
async function extractLiveTokens(liveData) {
    console.log('  🔑 Fetching live tokens for batches...');
    
    const liveTokens = [];
    const batchList = Array.isArray(liveData) ? liveData : 
                     (Array.isArray(liveData.data) ? liveData.data : []);
    
    let tokenCount = 0;
    for (const batch of batchList) {
        if (batch.id || batch.batchId) {
            try {
                const batchId = batch.id || batch.batchId;
                const response = await axios.get(`${BASE_URL}/api/nt/live-token`, {
                    params: { batchId: batchId },
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    timeout: 10000
                });
                
                liveTokens.push({
                    batchId: batchId,
                    token: response.data,
                    batchName: batch.name || batch.title || 'Unknown'
                });
                
                tokenCount++;
                console.log(`    ✅ Batch ${batchId}: Token fetched`);
                
                // Small delay for next token
                await delay(500);
                
            } catch (error) {
                console.error(`    ❌ Failed to fetch token for batch ${batch.id}:`, error.message);
                liveTokens.push({
                    batchId: batch.id,
                    error: error.message
                });
            }
        }
    }

    // Save live tokens
    fs.writeFileSync(
        path.join(DATA_DIR, 'live-tokens.json'),
        JSON.stringify({
            extractedAt: new Date().toISOString(),
            totalBatches: liveTokens.length,
            tokens: liveTokens
        }, null, 2)
    );
    
    console.log(`  ✅ ${tokenCount} live tokens fetched and saved`);
}

// Run extraction
if (require.main === module) {
    extractAllData()
        .then(() => {
            console.log('\n✅ All data extracted successfully!');
            console.log('📋 You can now run the data processing step.');
        })
        .catch(error => {
            console.error('\n❌ Extraction failed:', error);
            process.exit(1);
        });
}

module.exports = { extractAllData };
