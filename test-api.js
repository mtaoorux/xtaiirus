// test-api.js
const axios = require('axios');

const BASE_URL = process.env.BASE_URL || 'http://localhost:10000';

async function testAPI() {
    console.log('\n🧪 Testing Brainbox API...\n');
    
    const tests = [
        { name: 'Health Check', url: '/health' },
        { name: 'Batches', url: '/api/batches' },
        { name: 'Courses', url: '/api/courses' },
        { name: 'Contents', url: '/api/contents' },
        { name: 'Media', url: '/api/media' },
        { name: 'Live Sessions', url: '/api/live' },
        { name: 'Stats', url: '/api/stats' },
        { name: 'Search', url: '/api/search?q=web' }
    ];

    let passed = 0;
    let failed = 0;

    for (const test of tests) {
        try {
            const response = await axios.get(`${BASE_URL}${test.url}`, {
                timeout: 5000
            });
            if (response.data.success !== false) {
                console.log(`✅ ${test.name}: OK`);
                passed++;
            } else {
                console.log(`❌ ${test.name}: Failed`);
                failed++;
            }
        } catch (error) {
            console.log(`❌ ${test.name}: ${error.message}`);
            failed++;
        }
    }

    console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
    
    if (failed === 0) {
        console.log('🎉 All tests passed! API is working perfectly.');
    }
}

testAPI().catch(console.error);
