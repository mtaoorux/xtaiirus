/**
 * cors-proxy with enhanced video/CDN support
 * -----------------------------------------
 * Handles Google Cloud CDN, edge caching, and video streaming
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
  '*.classx.co.in',  // Allows all subdomains
];

const MAX_RESPONSE_BYTES = 200 * 1024 * 1024; // 200 MB for video
const REQUEST_TIMEOUT_MS = 300_000; // 5 minutes for video

// ---- Helpers ---------------------------------------------------------------

function hostIsAllowed(hostname) {
  return ALLOWED_HOSTS.some((pattern) => {
    if (pattern.startsWith('*.')) {
      const base = pattern.slice(2);
      return hostname === base || hostname.endsWith('.' + base);
    }
    return hostname === pattern;
  });
}

function isPrivateIp(ip) {
  if (net.isIP(ip) === 0) return true;
  const privateV4Patterns = [
    /^127\./,
    /^10\./,
    /^169\.254\./,
    /^192\.168\./,
    /^172\.(1[6-9]|2\d|3[0-1])\./,
    /^0\./,
  ];
  if (net.isIP(ip) === 4) {
    return privateV4Patterns.some((re) => re.test(ip));
  }
  const lower = ip.toLowerCase();
  return (
    lower === '::1' ||
    lower.startsWith('fc') ||
    lower.startsWith('fd') ||
    lower.startsWith('fe80')
  );
}

async function assertSafeTarget(targetUrl) {
  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch {
    throw new Error('Invalid URL');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http/https URLs are allowed');
  }

  if (!hostIsAllowed(parsed.hostname)) {
    throw new Error(`Host "${parsed.hostname}" is not in the allowlist`);
  }

  const addresses = await dns.lookup(parsed.hostname, { all: true });
  for (const { address } of addresses) {
    if (isPrivateIp(address)) {
      throw new Error('Target resolves to a disallowed private address');
    }
  }

  return parsed;
}

// ---- Routes ----------------------------------------------------------------

// CORS headers for ALL responses
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS, POST');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Expose-Headers', '*');
  res.setHeader('Access-Control-Max-Age', '86400');
  
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

// Main streaming endpoint - handles everything
app.get('/proxy', async (req, res) => {
  const target = req.query.url;
  if (!target) {
    return res.status(400).json({ error: 'Missing "url" query parameter' });
  }

  let parsedTarget;
  try {
    parsedTarget = await assertSafeTarget(target);
  } catch (err) {
    return res.status(403).json({ error: err.message });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    // Mimic a browser's headers to get past CDN restrictions
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'identity', // Don't accept compressed to stream properly
      'Connection': 'keep-alive',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
    };
    
    // Forward Range header for video seeking
    if (req.headers.range) {
      headers['Range'] = req.headers.range;
    }

    // Forward any other useful headers from the client
    ['if-modified-since', 'if-none-match', 'if-range'].forEach(header => {
      if (req.headers[header]) {
        headers[header] = req.headers[header];
      }
    });

    console.log(`Proxying: ${parsedTarget.toString()}`);
    console.log('Request headers:', JSON.stringify(headers, null, 2));

    const upstreamRes = await fetch(parsedTarget.toString(), {
      method: 'GET',
      redirect: 'follow', // Follow redirects
      signal: controller.signal,
      headers: headers,
      compress: false, // Don't decompress
    });

    console.log(`Response status: ${upstreamRes.status}`);
    console.log('Response headers:', JSON.stringify(Object.fromEntries(upstreamRes.headers), null, 2));

    // Set response status
    res.status(upstreamRes.status);

    // Forward ALL headers from upstream
    upstreamRes.headers.forEach((value, key) => {
      // Skip headers that might conflict
      const lowerKey = key.toLowerCase();
      if (!['transfer-encoding', 'access-control-allow-origin', 'access-control-allow-methods', 'access-control-allow-headers'].includes(lowerKey)) {
        res.setHeader(key, value);
      }
    });

    // Ensure these headers are set for video streaming
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Expose-Headers', '*');
    
    // Add cache headers to work with Google Edge Cache
    if (!upstreamRes.headers.has('cache-control')) {
      res.setHeader('Cache-Control', 'public, max-age=3600');
    }

    // Handle errors from upstream
    if (upstreamRes.status >= 400) {
      const errorBody = await upstreamRes.text();
      console.error(`Upstream error ${upstreamRes.status}:`, errorBody.substring(0, 500));
      return res.status(502).json({
        error: `Upstream returned status ${upstreamRes.status}`,
        details: errorBody.substring(0, 200)
      });
    }

    // Stream the response
    if (upstreamRes.body) {
      upstreamRes.body.on('error', (err) => {
        console.error('Stream error:', err);
        if (!res.headersSent) {
          res.status(502).json({ error: 'Stream error' });
        }
      });

      upstreamRes.body.pipe(res);

      // Handle client disconnect
      req.on('close', () => {
        console.log('Client disconnected');
        upstreamRes.body.destroy();
        controller.abort();
      });

    } else {
      res.end();
    }

  } catch (err) {
    console.error('Proxy error:', err);
    if (err.name === 'AbortError') {
      return res.status(504).json({ error: 'Upstream request timed out' });
    }
    res.status(502).json({ 
      error: 'Failed to fetch upstream URL',
      message: err.message 
    });
  } finally {
    clearTimeout(timeout);
  }
});

// Direct video streaming endpoint
app.get('/video', async (req, res) => {
  const target = req.query.url;
  if (!target) {
    return res.status(400).json({ error: 'Missing "url" query parameter' });
  }

  let parsedTarget;
  try {
    parsedTarget = await assertSafeTarget(target);
  } catch (err) {
    return res.status(403).json({ error: err.message });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'video/webm,video/mp4,video/*;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
      'Accept-Encoding': 'identity',
      'Referer': parsedTarget.origin,
      'Origin': parsedTarget.origin,
      'Connection': 'keep-alive',
      'Sec-Fetch-Dest': 'video',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'cross-site',
    };
    
    if (req.headers.range) {
      headers['Range'] = req.headers.range;
    }

    console.log(`Streaming video: ${parsedTarget.toString()}`);

    const upstreamRes = await fetch(parsedTarget.toString(), {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: headers,
      compress: false,
    });

    console.log(`Video status: ${upstreamRes.status}`);
    console.log('Video headers:', Object.fromEntries(upstreamRes.headers));

    res.status(upstreamRes.status);

    // Forward headers
    upstreamRes.headers.forEach((value, key) => {
      const lowerKey = key.toLowerCase();
      if (!['transfer-encoding', 'access-control-allow-origin'].includes(lowerKey)) {
        res.setHeader(key, value);
      }
    });

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    
    if (upstreamRes.body) {
      upstreamRes.body.pipe(res);
    }
  } catch (err) {
    console.error('Video streaming error:', err);
    if (err.name === 'AbortError') {
      return res.status(504).json({ error: 'Video request timed out' });
    }
    res.status(502).json({ 
      error: 'Failed to stream video',
      message: err.message 
    });
  } finally {
    clearTimeout(timeout);
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    ok: true,
    allowedHosts: ALLOWED_HOSTS,
    uptime: process.uptime()
  });
});

// Test endpoint to check if a URL is accessible
app.get('/test', async (req, res) => {
  const target = req.query.url;
  if (!target) {
    return res.status(400).json({ error: 'Missing "url" query parameter' });
  }

  try {
    const parsedTarget = await assertSafeTarget(target);
    
    const testRes = await fetch(parsedTarget.toString(), {
      method: 'HEAD',
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    });

    res.json({
      accessible: true,
      status: testRes.status,
      headers: Object.fromEntries(testRes.headers),
    });
  } catch (err) {
    res.json({
      accessible: false,
      error: err.message,
    });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 cors-proxy running on http://localhost:${PORT}`);
  console.log(`✅ Allowed hosts: ${ALLOWED_HOSTS.join(', ')}`);
  console.log('\n📋 Available endpoints:');
  console.log('  GET /proxy?url=URL  - General proxy');
  console.log('  GET /video?url=URL  - Video streaming optimized');
  console.log('  GET /test?url=URL   - Test if URL is accessible');
  console.log('  GET /health         - Health check');
});
