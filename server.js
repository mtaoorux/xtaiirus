/**
 * cors-proxy with video streaming support
 * -----------------------------------------
 * Enhanced proxy that handles CORS bypass and video/audio streaming.
 * Supports range requests for media playback.
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
  'transcoded-videos.classx.co.in',
  // Add video hosting domains you need:
  // 'videos.example.com',
  // 'cdn.example.com',
  // '*.cloudfront.net',
];

const MAX_RESPONSE_BYTES = 100 * 1024 * 1024; // 100 MB for video
const REQUEST_TIMEOUT_MS = 120_000; // 2 minutes for video

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
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type, Origin');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Content-Type, Accept-Ranges');
  
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

// Main proxy endpoint with streaming support
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
    // Forward Range header for video streaming
    const headers = {
      'User-Agent': 'cors-proxy/1.0',
    };
    
    if (req.headers.range) {
      headers['Range'] = req.headers.range;
    }

    const upstreamRes = await fetch(parsedTarget.toString(), {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
      headers: headers,
    });

    // Handle redirects - follow them manually
    if (upstreamRes.status >= 300 && upstreamRes.status < 400) {
      const location = upstreamRes.headers.get('location');
      if (location) {
        // Recursively follow redirect (with safety check)
        const redirectUrl = new URL(location, parsedTarget).toString();
        const redirectParsed = await assertSafeTarget(redirectUrl);
        
        const redirectHeaders = { ...headers };
        const redirectRes = await fetch(redirectUrl, {
          method: 'GET',
          signal: controller.signal,
          headers: redirectHeaders,
        });
        
        // Forward response headers
        res.status(redirectRes.status);
        redirectRes.headers.forEach((value, key) => {
          if (!key.toLowerCase().startsWith('access-control')) {
            res.setHeader(key, value);
          }
        });
        res.setHeader('Accept-Ranges', 'bytes');
        
        return redirectRes.body.pipe(res);
      }
    }

    // Set response status and headers
    res.status(upstreamRes.status);
    
    // Forward all headers except CORS-related ones
    upstreamRes.headers.forEach((value, key) => {
      if (!key.toLowerCase().startsWith('access-control')) {
        res.setHeader(key, value);
      }
    });
    
    // Ensure range support is indicated
    res.setHeader('Accept-Ranges', 'bytes');

    // Stream the response (important for video)
    if (upstreamRes.body) {
      upstreamRes.body.pipe(res);
    } else {
      res.end();
    }

  } catch (err) {
    if (err.name === 'AbortError') {
      return res.status(504).json({ error: 'Upstream request timed out' });
    }
    res.status(502).json({ error: 'Failed to fetch upstream URL' });
  } finally {
    clearTimeout(timeout);
  }
});

// Simple streaming proxy endpoint - just passes through everything
app.get('/stream', async (req, res) => {
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
      'User-Agent': 'cors-proxy/1.0',
    };
    
    // Forward range headers for video seeking
    if (req.headers.range) {
      headers['Range'] = req.headers.range;
    }

    const upstreamRes = await fetch(parsedTarget.toString(), {
      method: 'GET',
      redirect: 'follow', // Follow redirects for streaming
      signal: controller.signal,
      headers: headers,
    });

    // Set CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    
    // Copy status and headers
    res.status(upstreamRes.status);
    upstreamRes.headers.forEach((value, key) => {
      if (!key.toLowerCase().startsWith('access-control')) {
        res.setHeader(key, value);
      }
    });
    res.setHeader('Accept-Ranges', 'bytes');

    // Pipe the stream
    if (upstreamRes.body) {
      upstreamRes.body.pipe(res);
    }

  } catch (err) {
    if (err.name === 'AbortError') {
      return res.status(504).json({ error: 'Upstream request timed out' });
    }
    res.status(502).json({ error: 'Failed to fetch upstream URL' });
  } finally {
    clearTimeout(timeout);
  }
});

// Health check endpoint
app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`cors-proxy listening on http://localhost:${PORT}`);
  console.log(`Allowed hosts: ${ALLOWED_HOSTS.join(', ') || '(none configured!)'}`);
  console.log('Endpoints:');
  console.log('  /proxy?url=URL  - General proxy with redirect handling');
  console.log('  /stream?url=URL - Streaming proxy for video/audio');
  console.log('  /health         - Health check');
});
