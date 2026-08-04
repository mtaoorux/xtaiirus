/**
 * cors-proxy
 * -----------
 * A minimal proxy whose only job is to fetch an allowlisted URL server-side
 * and return it with permissive CORS headers, so a browser app can read a
 * response that the origin server doesn't send CORS headers for.
 *
 * This is NOT a general-purpose open proxy. It intentionally:
 *   - only proxies GET requests
 *   - only proxies to domains you explicitly allow (see ALLOWED_HOSTS below)
 *   - blocks requests to private/internal/loopback IPs (basic SSRF guard)
 *   - caps response size and request time
 *
 * Run:
 *   npm install
 *   npm start
 *
 * Use from the browser:
 *   fetch('http://localhost:8080/proxy?url=' + encodeURIComponent('https://example.com/api/data'))
 */

const express = require('express');
const fetch = require('node-fetch');
const { URL } = require('url');
const dns = require('dns').promises;
const net = require('net');

const app = express();
const PORT = process.env.PORT || 8080;

// ---- Configuration -------------------------------------------------------

// Only these hostnames may be proxied. Add the domains you actually need.
// Wildcards like "*.example.com" are supported.
const ALLOWED_HOSTS = [
  'api.github.com',
  'jsonplaceholder.typicode.com',
  // 'api.example.com',
];

const MAX_RESPONSE_BYTES = 5 * 1024 * 1024; // 5 MB
const REQUEST_TIMEOUT_MS = 10_000;

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
  if (net.isIP(ip) === 0) return true; // not a valid IP -> treat as unsafe
  // IPv4 private/reserved ranges + loopback + link-local + cloud metadata IP
  const privateV4Patterns = [
    /^127\./,
    /^10\./,
    /^169\.254\./, // includes 169.254.169.254 cloud metadata endpoint
    /^192\.168\./,
    /^172\.(1[6-9]|2\d|3[0-1])\./,
    /^0\./,
  ];
  if (net.isIP(ip) === 4) {
    return privateV4Patterns.some((re) => re.test(ip));
  }
  // IPv6: block loopback (::1), unique local (fc00::/7), link-local (fe80::/10)
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

  // Resolve DNS ourselves and reject if it points at a private/internal IP.
  // This stops "allowed hostname that actually resolves to an internal IP"
  // (DNS rebinding) style SSRF tricks.
  const addresses = await dns.lookup(parsed.hostname, { all: true });
  for (const { address } of addresses) {
    if (isPrivateIp(address)) {
      throw new Error('Target resolves to a disallowed private address');
    }
  }

  return parsed;
}

// ---- Routes ----------------------------------------------------------------

// Permissive CORS headers on every response from this proxy.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

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
    const upstreamRes = await fetch(parsedTarget.toString(), {
      method: 'GET',
      redirect: 'manual', // don't silently follow redirects off the allowlist
      signal: controller.signal,
      headers: { 'User-Agent': 'cors-proxy/1.0' },
    });

    // Refuse to follow redirects automatically; tell the client instead.
    if (upstreamRes.status >= 300 && upstreamRes.status < 400) {
      return res.status(502).json({
        error: 'Upstream returned a redirect, which this proxy does not follow',
      });
    }

    const contentLength = upstreamRes.headers.get('content-length');
    if (contentLength && Number(contentLength) > MAX_RESPONSE_BYTES) {
      return res.status(502).json({ error: 'Upstream response too large' });
    }

    res.status(upstreamRes.status);
    const contentType = upstreamRes.headers.get('content-type');
    if (contentType) res.setHeader('Content-Type', contentType);

    const buffer = await upstreamRes.buffer();
    if (buffer.length > MAX_RESPONSE_BYTES) {
      return res.status(502).json({ error: 'Upstream response too large' });
    }

    res.send(buffer);
  } catch (err) {
    if (err.name === 'AbortError') {
      return res.status(504).json({ error: 'Upstream request timed out' });
    }
    res.status(502).json({ error: 'Failed to fetch upstream URL' });
  } finally {
    clearTimeout(timeout);
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`cors-proxy listening on http://localhost:${PORT}`);
  console.log(`Allowed hosts: ${ALLOWED_HOSTS.join(', ') || '(none configured!)'}`);
});
