/**
 * cors-proxy with debugging and Google CDN support
 */

const express = require('express');
const fetch = require('node-fetch');
const { URL } = require('url');
const dns = require('dns').promises;
const net = require('net');

const app = express();
const PORT = process.env.PORT || 8080;

// ---- Configuration -------------------------------------------------------

const ALLOWED_HOSTS = [
  'api.github.com',
  'jsonplaceholder.typicode.com',
  'transcoded-videos.classx.co.in',
  '*.classx.co.in',
];

// ---- Debug endpoint to test URLs ----
app.get('/debug', async (req, res) => {
  const target = req.query.url;
  if (!target) {
    return res.status(400).json({ error: 'Missing "url" query parameter' });
  }

  console.log('\n=== DEBUG START ===');
  console.log('Original URL:', target);

  try {
    const parsed = new URL(target);
    console.log('Parsed URL:', {
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      pathname: parsed.pathname,
      search: parsed.search,
      href: parsed.href
    });

    // Try different approaches
    const results = {};

    // 1. Direct request
    try {
      console.log('\n--- Attempt 1: Direct request ---');
      const res1 = await fetch(target, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        }
      });
      results.direct = {
        status: res1.status,
        headers: Object.fromEntries(res1.headers),
        bodySample: (await res1.text()).substring(0, 500)
      };
      console.log('Direct request status:', res1.status);
    } catch (e) {
      results.direct = { error: e.message };
      console.log('Direct request failed:', e.message);
    }

    // 2. Request with different path variations
    const paths = [
      parsed.pathname,
      parsed.pathname.replace(/\/+/g, '/'), // Remove double slashes
      '/' + parsed.pathname.split('/').filter(p => p).join('/'), // Normalize
    ];

    for (const path of paths) {
      const testUrl = `${parsed.protocol}//${parsed.hostname}${path}${parsed.search || ''}`;
      if (testUrl === target) continue; // Skip if same as original
      
      try {
        console.log(`\n--- Attempt with path: ${path} ---`);
        const res = await fetch(testUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          }
        });
        results[`path_${path}`] = {
          url: testUrl,
          status: res.status,
          headers: Object.fromEntries(res.headers),
        };
        console.log('Path variation status:', res.status);
      } catch (e) {
        console.log('Path variation failed:', e.message);
      }
    }

    res.json({
      originalUrl: target,
      parsed: {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        pathname: parsed.pathname,
        search: parsed.search,
      },
      results
    });

  } catch (err) {
    res.json({
      error: 'Failed to parse or fetch URL',
      message: err.message,
      stack: err.stack
    });
  }
  console.log('=== DEBUG END ===\n');
});

// ---- Main proxy with better error handling ----
app.get('/proxy', async (req, res) => {
  const target = req.query.url;
  if (!target) {
    return res.status(400).json({ error: 'Missing "url" query parameter' });
  }

  // Parse the URL
  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    return res.status(400).json({ error: 'Invalid URL format' });
  }

  // Check if host is allowed
  const isAllowed = ALLOWED_HOSTS.some(pattern => {
    if (pattern.startsWith('*.')) {
      const base = pattern.slice(2);
      return parsed.hostname === base || parsed.hostname.endsWith('.' + base);
    }
    return parsed.hostname === pattern;
  });

  if (!isAllowed) {
    return res.status(403).json({ 
      error: `Host "${parsed.hostname}" is not allowed`,
      allowedHosts: ALLOWED_HOSTS
    });
  }

  console.log(`Proxying: ${target}`);

  try {
    // Try with browser-like headers
    const response = await fetch(target, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'identity',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'cross-site',
      },
      redirect: 'follow',
      follow: 5,
    });

    console.log(`Response: ${response.status} ${response.statusText}`);
    
    // Log response headers for debugging
    const responseHeaders = Object.fromEntries(response.headers);
    console.log('Response headers:', JSON.stringify(responseHeaders, null, 2));

    // Set CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Expose-Headers', '*');

    // If it's a 404, provide debugging info
    if (response.status === 404) {
      const body = await response.text();
      console.log('404 Body:', body.substring(0, 500));
      
      return res.status(404).json({
        error: 'File not found at the specified URL',
        url: target,
        hostname: parsed.hostname,
        pathname: parsed.pathname,
        debugInfo: body.substring(0, 300),
        suggestion: 'Try the /debug?url= endpoint to test different URL variations'
      });
    }

    // Forward successful response
    res.status(response.status);
    
    // Forward headers
    response.headers.forEach((value, key) => {
      if (!key.toLowerCase().startsWith('access-control')) {
        res.setHeader(key, value);
      }
    });

    res.setHeader('Accept-Ranges', 'bytes');

    // Stream the response
    if (response.body) {
      response.body.pipe(res);
    } else {
      res.end();
    }

  } catch (err) {
    console.error('Proxy error:', err);
    res.status(502).json({
      error: 'Failed to fetch URL',
      message: err.message,
      url: target
    });
  }
});

// ---- Video streaming specific endpoint ----
app.get('/video', async (req, res) => {
  const target = req.query.url;
  if (!target) {
    return res.status(400).json({ error: 'Missing "url" query parameter' });
  }

  // Quick host check
  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  if (!ALLOWED_HOSTS.some(p => {
    if (p.startsWith('*.')) {
      const base = p.slice(2);
      return parsed.hostname === base || parsed.hostname.endsWith('.' + base);
    }
    return parsed.hostname === p;
  })) {
    return res.status(403).json({ error: 'Host not allowed' });
  }

  console.log(`Streaming video: ${target}`);

  try {
    const response = await fetch(target, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'video/webm,video/mp4,video/*;q=0.9,*/*;q=0.8',
        'Accept-Encoding': 'identity',
        'Range': req.headers.range || '',
        'Referer': `${parsed.protocol}//${parsed.hostname}/`,
        'Origin': `${parsed.protocol}//${parsed.hostname}`,
      },
      redirect: 'follow',
    });

    res.status(response.status);
    response.headers.forEach((value, key) => {
      if (!key.toLowerCase().startsWith('access-control')) {
        res.setHeader(key, value);
      }
    });
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Accept-Ranges', 'bytes');

    if (response.body) {
      response.body.pipe(res);
    }
  } catch (err) {
    res.status(502).json({ error: 'Streaming failed', message: err.message });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ ok: true, allowedHosts: ALLOWED_HOSTS });
});

app.listen(PORT, () => {
  console.log(`🚀 Proxy running on http://localhost:${PORT}`);
  console.log('📋 Endpoints:');
  console.log('  /proxy?url=URL  - Main proxy');
  console.log('  /video?url=URL  - Video streaming');
  console.log('  /debug?url=URL  - Debug URL issues');
  console.log('  /health         - Health check');
});
