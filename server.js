// ============================================================================
// STUDYBEE API SERVER — RENDER (FULLY WORKING STREAM PROXY)
// ============================================================================

import express from "express";
import cors from "cors";
import { Readable } from "node:stream";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: "*" }));

// ============================================================================
// CONSTANTS
// ============================================================================

const TARGET_ORIGIN = "https://appx-play.akamai.net.in";
const CLASSES_API = "https://sachinacademyapi.classx.co.in/get/livecourseclassbycoursesubtopconceptapiv3";
const SUBJECT_API = "https://sachinacademyapi.classx.co.in/get/allsubjectfrmlivecourseclass";
const TOPICS_API = "https://sachinacademyapi.classx.co.in/get/alltopicfrmlivecourseclass";
const VIDEO_API = "https://sachinacademyapi.classx.co.in/get/fetchVideoDetailsById";
const LIVE_API = "https://sachinacademyapi.classx.co.in/get/live_upcoming_course_classv2";
const PREVIOUS_LIVE_API = "https://sachinacademyapi.classx.co.in/get/get_previous_live_videos";
const COURSE_API = "https://sachinacademyapi.classx.co.in/get/mycourseweb";
const DECRYPTION_KEY = "638udh3829162018";
const DEFAULT_TOPIC_ID = "1";

const MAX_PAGES = 20;
const PAGE_TIMEOUT = 15000;
const PAGE_SIZE = 40;
const UPSTREAM_CONCURRENCY = 4;
const UPSTREAM_RETRIES = 4;
const UPSTREAM_BASE_DELAY = 700;
const UPSTREAM_MAX_DELAY = 12000;
const CACHE_TTL_MS = 60_000;
const RATE_LIMIT_COOLDOWN_MS = 30_000;
const REQUEST_JITTER_MS = 150;

const ADMIN_KEYS = new Set(["shivuu", "adii"]);
const ACTIVE_KEY = "shivuu";

const JSON_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
    "Access-Control-Allow-Headers": "*",
    "Content-Type": "application/json; charset=UTF-8",
    "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
    "Pragma": "no-cache"
};

const STREAM_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges, Content-Type",
    "Access-Control-Max-Age": "86400"
};

// ============================================================================
// SIMPLE IN-MEMORY CACHE
// ============================================================================

const responseCache = new Map();
const inflightRequests = new Map();

function cacheGet(key) {
    const entry = responseCache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiry) { responseCache.delete(key); return null; }
    return entry.data;
}

function cacheSet(key, data, ttl = CACHE_TTL_MS) {
    if (responseCache.size > 500) {
        const firstKey = responseCache.keys().next().value;
        responseCache.delete(firstKey);
    }
    responseCache.set(key, { data, expiry: Date.now() + ttl });
}

// ============================================================================
// HOST COOLDOWN (anti-429)
// ============================================================================

const hostCooldowns = new Map();

function hostCooldownRemaining(host) {
    const until = hostCooldowns.get(host);
    if (!until) return 0;
    const remaining = until - Date.now();
    if (remaining <= 0) { hostCooldowns.delete(host); return 0; }
    return remaining;
}

function setHostCooldown(host, ms = RATE_LIMIT_COOLDOWN_MS) {
    hostCooldowns.set(host, Date.now() + ms);
}

// ============================================================================
// CONCURRENCY LIMITER
// ============================================================================

class ConcurrencyLimiter {
    constructor(max) { this.max = max; this.active = 0; this.queue = []; }
    async run(fn) {
        if (this.active >= this.max) await new Promise(r => this.queue.push(r));
        this.active++;
        try { return await fn(); }
        finally {
            this.active--;
            const next = this.queue.shift();
            if (next) next();
        }
    }
}

const upstreamLimiter = new ConcurrencyLimiter(UPSTREAM_CONCURRENCY);

// ============================================================================
// UTILS
// ============================================================================

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const jitter = (ms = REQUEST_JITTER_MS) => Math.floor(Math.random() * ms);

function jsonResponse(res, payload, status = 200) {
    res.status(status).set(JSON_HEADERS).send(JSON.stringify(payload, null, 4));
}

function getParam(req, name, def = "") {
    const v = req.query[name];
    if (v === null || v === undefined) return def;
    return String(v).trim();
}

function base64ToUint8Array(base64) {
    try {
        if (typeof base64 !== "string") return null;
        let n = base64.replace(/-/g, "+").replace(/_/g, "/");
        while (n.length % 4 !== 0) n += "=";
        const bin = Buffer.from(n, "base64").toString("binary");
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return bytes;
    } catch { return null; }
}

async function decrypt(enc) {
    try {
        if (typeof enc !== "string") return null;
        const [cipher, iv] = enc.split(":");
        if (!cipher || !iv) return null;
        const cb = base64ToUint8Array(cipher);
        const ib = base64ToUint8Array(iv);
        if (!cb || !ib || ib.length !== 16) return null;
        const kb = new TextEncoder().encode(DECRYPTION_KEY);
        if (kb.length !== 16) return null;
        const k = await globalThis.crypto.subtle.importKey("raw", kb, { name: "AES-CBC" }, false, ["decrypt"]);
        const d = await globalThis.crypto.subtle.decrypt({ name: "AES-CBC", iv: ib }, k, cb);
        return new TextDecoder("utf-8", { fatal: true }).decode(d);
    } catch { return null; }
}

function isEncryptedString(v) {
    if (typeof v !== "string") return false;
    const [c, i] = v.split(":");
    if (!c || !i) return false;
    const ib = base64ToUint8Array(i);
    return !!(ib && ib.length === 16);
}

async function decryptObject(value) {
    if (typeof value === "string") {
        if (!isEncryptedString(value)) return value;
        const d = await decrypt(value);
        return d === null ? value : d;
    }
    if (Array.isArray(value)) {
        const out = [];
        for (const item of value) out.push(await decryptObject(item));
        return out;
    }
    if (value !== null && typeof value === "object") {
        const out = {};
        for (const [k, v] of Object.entries(value)) out[k] = await decryptObject(v);
        return out;
    }
    return value;
}

// ============================================================================
// TOKEN STORE
// ============================================================================

const TOKEN_STORE = {
    "status": 200,
    "message": "Fetched 20 unique batches from 5 pages.",
    "pagination": { "pagesFetched": 5, "maxPages": 20, "complete": true, "stoppedByMaxPages": false, "remainingNextUrl": null },
    "stats": { "batchesReceivedAcrossPages": 33, "uniqueBatches": 20, "duplicateBatchesRemoved": 13 },
    "pages": [],
    "errors": [],
    "data": [
        { "userId": "481163", "token": "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpZCI6IjQ4MTE2MyIsInRpbWVzdGFtcCI6MTc3OTg0Mjk3MywiaXZfdmVyIjo1Mywic2Vzc2lvbiI6ImV5SjBlWEFpT2lKS1YxUWlMQ0poYkdjaU9pSklVekkxTmlKOS5leUpwWkNJNklqUTRNVEUyTXlJc0ltVnRZV2xzSWpvaWFtRnBjR3M1TlRjMlFHZHRZV2xzTG1OdmJTSXNJbTVoYldVaU9pSnFZV2tpTENKMFpXNWhiblJVZVhCbElqb2lkWE5sY2lJc0luUmxibUZ1ZEU1aGJXVWlPaUp6WVdOb2FXNWhZMkZrWlcxNVgyUmlJaXdpZEdWdVlXNTBTV1FpT2lJaUxDSmthWE53YjNOaFlteGxJanBtWVd4elpYMC43dllpRi1iUEY2YnVRUEs4bHlQcEM0ZWNhYkFob09SaUthcXNsUE1OcENvIn0.eivVG5EvjV1lqHYUMPv-4JxTrckl94sOLQxp-NjmFTQ", "batch_id": "8", "batch_name": "KVS INTERVIEW BATCH old", "batch_image": "https://appx-content-v2.classx.co.in/paid_course3/2026-04-21-0.08489777653031139.png" },
        { "userId": "533219", "token": "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpZCI6IjUzMzIxOSIsInRpbWVzdGFtcCI6MTc3OTg0MzAxNiwiaXZfdmVyIjoyOCwic2Vzc2lvbiI6ImV5SjBlWEFpT2lKS1YxUWlMQ0poYkdjaU9pSklVekkxTmlKOS5leUpwWkNJNklqVXpNekl4T1NJc0ltVnRZV2xzSWpvaWNtRm9kV3hyZFhOb2QyRm9OelF5TjBCbmJXRnBiQzVqYjIwaUxDSnVZVzFsSWpvaVVtRm9kV3dpTENKMFpXNWhiblJVZVhCbElqb2lkWE5sY2lJc0luUmxibUZ1ZEU1aGJXVWlPaUp6WVdOb2FXNWhZMkZrWlcxNVgyUmlJaXdpZEdWdVlXNTBTV1FpT2lJaUxDSmthWE53YjNOaFlteGxJanBtWVd4elpYMC4wTVYwOExHSE5ueWN5Y3JQM0Q3Vl9yQ2RQRDZRWC1RQTNfaTBadFI4TkZ3In0.ZFFl7NfsHvQX1tHkiIXL5IrtE9Ud0lTHVBiWg0NFEAY", "batch_id": "152", "batch_name": "KVS PRT COMPLETE BATCH [GENERAL PAPER + ONLINE INTERVIEW]*", "batch_image": "https://appx-content-v2.classx.co.in/paid_course3/2025-10-25-0.04739045005277498.png" },
        { "userId": "533219", "token": "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpZCI6IjUzMzIxOSIsInRpbWVzdGFtcCI6MTc3OTg0MzAxNiwiaXZfdmVyIjoyOCwic2Vzc2lvbiI6ImV5SjBlWEFpT2lKS1YxUWlMQ0poYkdjaU9pSklVekkxTmlKOS5leUpwWkNJNklqVXpNekl4T1NJc0ltVnRZV2xzSWpvaWNtRm9kV3hyZFhOb2QyRm9OelF5TjBCbmJXRnBiQzVqYjIwaUxDSnVZVzFsSWpvaVVtRm9kV3dpTENKMFpXNWhiblJVZVhCbElqb2lkWE5sY2lJc0luUmxibUZ1ZEU1aGJXVWlPaUp6WVdOb2FXNWhZMkZrWlcxNVgyUmlJaXdpZEdWdVlXNTBTV1FpT2lJaUxDSmthWE53YjNOaFlteGxJanBtWVd4elpYMC4wTVYwOExHSE5ueWN5Y3JQM0Q3Vl9yQ2RQRDZRWC1RQTNfaTBadFI4TkZ3In0.ZFFl7NfsHvQX1tHkiIXL5IrtE9Ud0lTHVBiWg0NFEAY", "batch_id": "247", "batch_name": "KVS/NVS TIER - 1 COMPLETE BATCH", "batch_image": "https://appx-content-v2.classx.co.in/paid_course3/2026-08-28-0.5798368854602307.jpeg" },
        { "userId": "533219", "token": "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpZCI6IjUzMzIxOSIsInRpbWVzdGFtcCI6MTc3OTg0MzAxNiwiaXZfdmVyIjoyOCwic2Vzc2lvbiI6ImV5SjBlWEFpT2lKS1YxUWlMQ0poYkdjaU9pSklVekkxTmlKOS5leUpwWkNJNklqVXpNekl4T1NJc0ltVnRZV2xzSWpvaWNtRm9kV3hyZFhOb2QyRm9OelF5TjBCbmJXRnBiQzVqYjIwaUxDSnVZVzFsSWpvaVVtRm9kV3dpTENKMFpXNWhiblJVZVhCbElqb2lkWE5sY2lJc0luUmxibUZ1ZEU1aGJXVWlPaUp6WVdOb2FXNWhZMkZrWlcxNVgyUmlJaXdpZEdWdVlXNTBTV1FpT2lJaUxDSmthWE53YjNOaFlteGxJanBtWVd4elpYMC4wTVYwOExHSE5ueWN5Y3JQM0Q3Vl9yQ2RQRDZRWC1RQTNfaTBadFI4TkZ3In0.ZFFl7NfsHvQX1tHkiIXL5IrtE9Ud0lTHVBiWg0NFEAY", "batch_id": "363", "batch_name": "KVS/NVS INTERVIEW BATCH", "batch_image": "https://appx-content-v2.classx.co.in/paid_course3/2026-04-21-0.08489777653031139.png" },
        { "userId": "1753568", "token": "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpZCI6IjE3NTM1NjgiLCJ0aW1lc3RhbXAiOjE3ODAwNzMwMjksIml2X3ZlciI6MSwic2Vzc2lvbiI6ImV5SjBlWEFpT2lKS1YxUWlMQ0poYkdjaU9pSklVekkxTmlKOS5leUpwWkNJNklqRTNOVE0xTmpnaUxDSmxiV0ZwYkNJNkltdDFiV0Z5YXpneE16SXhNa0JuYldGcGJDNWpiMjBpTENKdVlXMWxJam9pUzNWdVpHRnVJRXQxYldGeUlpd2lkR1Z1WVc1MFZIbHdaU0k2SW5WelpYSWlMQ0owWlc1aGJuUk9ZVzFsSWpvaWMyRmphR2x1WVdOaFpHVnRlVjlrWWlJc0luUmxibUZ1ZEVsa0lqb2lJaXdpWkdsemNHOXpZV0pzWlNJNlptRnNjMlY5LkpJS3ROTVhHVzVPdjMxZzg1WHM4MXJFbWFNdkMtNVRCUlpocTZJYWNVSmcifQ.dBOLYMRB0YsTJLWEWW5EAFCZ26n8pvVsL56FKr8kTFc", "batch_id": "364", "batch_name": "CTET PAPER 1 & 2 COURSE (2026)", "batch_image": "https://appx-content-v2.classx.co.in/paid_course3/2026-09-12-0.9822338147333287.png" },
        { "userId": "820618", "token": "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpZCI6IjgyMDYxOCIsInRpbWVzdGFtcCI6MTc4MDA4MTI3MiwiaXZfdmVyIjoxLCJzZXNzaW9uIjoiZXlKMGVYQWlPaUpLVjFRaUxDSmhiR2NpT2lKSVV6STFOaUo5LmV5SnBaQ0k2SWpneU1EWXhPQ0lzSW1WdFlXbHNJam9pYm1seVlXcG5kWEIwWVRFeU5UQkFaMjFoYVd3dVkyOXRJaXdpYm1GdFpTSTZJazVwY21GcUlFZDFjSFJoSWl3aWRHVnVZVzUwVkhsd1pTSTZJblZ6WlhJaUxDSjBaVzVoYm5ST1lXMWxJam9pYzJGamFHbHVZV05oWkdWdGVWOWtZaUlzSW5SbGJtRnVkRWxrSWpvaUlpd2laR2x6Y0c5ellXSnNaU0k2Wm1Gc2MyVjkuX3llcWxtbUgwMWNqNEpGNVVZSVF6TGZsYVRkVExXSF93WjJzMnB0aXpDMCJ9.QPrf44Zov0X6qK_LX1iKQ-ti1HX3kiAUrZ7b4NwJc34", "batch_id": "56", "batch_name": "BIHAR TRE 3.0 (9th TO 10th) COMPLETE BATCH (LANGUAGE + G.S + SST)", "batch_image": "https://appxcontent.kaxa.in/paid_course3/2024-02-20-0.4486703244894761.jpg" },
        { "userId": "820618", "token": "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpZCI6IjgyMDYxOCIsInRpbWVzdGFtcCI6MTc4MDA4MTI3MiwiaXZfdmVyIjoxLCJzZXNzaW9uIjoiZXlKMGVYQWlPaUpLVjFRaUxDSmhiR2NpT2lKSVV6STFOaUo5LmV5SnBaQ0k2SWpneU1EWXhPQ0lzSW1WdFlXbHNJam9pYm1seVlXcG5kWEIwWVRFeU5UQkFaMjFoYVd3dVkyOXRJaXdpYm1GdFpTSTZJazVwY21GcUlFZDFjSFJoSWl3aWRHVnVZVzUwVkhsd1pTSTZJblZ6WlhJaUxDSjBaVzVoYm5ST1lXMWxJam9pYzJGamFHbHVZV05oWkdWdGVWOWtZaUlzSW5SbGJtRnVkRWxrSWpvaUlpd2laR2x6Y0c5ellXSnNaU0k2Wm1Gc2MyVjkuX3llcWxtbUgwMWNqNEpGNVVZSVF6TGZsYVRkVExXSF93WjJzMnB0aXpDMCJ9.QPrf44Zov0X6qK_LX1iKQ-ti1HX3kiAUrZ7b4NwJc34", "batch_id": "72", "batch_name": "BIHAR TRE 3.0 FREE PRACTICE BATCH ", "batch_image": "https://appxcontent.kaxa.in/paid_course3/2024-03-27-0.28488634777230737.jpg" },
        { "userId": "820618", "token": "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpZCI6IjgyMDYxOCIsInRpbWVzdGFtcCI6MTc4MDA4MTI3MiwiaXZfdmVyIjoxLCJzZXNzaW9uIjoiZXlKMGVYQWlPaUpLVjFRaUxDSmhiR2NpT2lKSVV6STFOaUo5LmV5SnBaQ0k2SWpneU1EWXhPQ0lzSW1WdFlXbHNJam9pYm1seVlXcG5kWEIwWVRFeU5UQkFaMjFoYVd3dVkyOXRJaXdpYm1GdFpTSTZJazVwY21GcUlFZDFjSFJoSWl3aWRHVnVZVzUwVkhsd1pTSTZJblZ6WlhJaUxDSjBaVzVoYm5ST1lXMWxJam9pYzJGamFHbHVZV05oWkdWdGVWOWtZaUlzSW5SbGJtRnVkRWxrSWpvaUlpd2laR2x6Y0c5ellXSnNaU0k2Wm1Gc2MyVjkuX3llcWxtbUgwMWNqNEpGNVVZSVF6TGZsYVRkVExXSF93WjJzMnB0aXpDMCJ9.QPrf44Zov0X6qK_LX1iKQ-ti1HX3kiAUrZ7b4NwJc34", "batch_id": "75", "batch_name": "BPSC TRE 4.0 (9th TO 10th) COMPLETE BATCH (LANGUAGE + G.S + SST)", "batch_image": "https://appxcontent.kaxa.in/paid_course3/2024-11-07-0.9025426514436954.jpg" },
        { "userId": "820618", "token": "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpZCI6IjgyMDYxOCIsInRpbWVzdGFtcCI6MTc4MDA4MTI3MiwiaXZfdmVyIjoxLCJzZXNzaW9uIjoiZXlKMGVYQWlPaUpLVjFRaUxDSmhiR2NpT2lKSVV6STFOaUo5LmV5SnBaQ0k2SWpneU1EWXhPQ0lzSW1WdFlXbHNJam9pYm1seVlXcG5kWEIwWVRFeU5UQkFaMjFoYVd3dVkyOXRJaXdpYm1GdFpTSTZJazVwY21GcUlFZDFjSFJoSWl3aWRHVnVZVzUwVkhsd1pTSTZJblZ6WlhJaUxDSjBaVzVoYm5ST1lXMWxJam9pYzJGamFHbHVZV05oWkdWdGVWOWtZaUlzSW5SbGJtRnVkRWxrSWpvaUlpd2laR2x6Y0c5ellXSnNaU0k2Wm1Gc2MyVjkuX3llcWxtbUgwMWNqNEpGNVVZSVF6TGZsYVRkVExXSF93WjJzMnB0aXpDMCJ9.QPrf44Zov0X6qK_LX1iKQ-ti1HX3kiAUrZ7b4NwJc34", "batch_id": "278", "batch_name": "BPSC TRE 4.0 FREE NCERT PRACTICE BATCH ", "batch_image": "https://appx-content-v2.classx.co.in/paid_course3/2026-02-16-0.17555006151682273.jpeg" },
        { "userId": "1541871", "token": "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpZCI6IjE1NDE4NzEiLCJ0aW1lc3RhbXAiOjE3ODAxMDk1MDAsIml2X3ZlciI6Mywic2Vzc2lvbiI6ImV5SjBlWEFpT2lKS1YxUWlMQ0poYkdjaU9pSklVekkxTmlKOS5leUpwWkNJNklqRTFOREU0TnpFaUxDSmxiV0ZwYkNJNkluWTNOek14TmpFeFFHZHRZV2xzTG1OdmJTSXNJbTVoYldVaU9pSldZV2x6YUdGc2FTSXNJblJsYm1GdWRGUjVjR1VpT2lKMWMyVnlJaXdpZEdWdVlXNTBUbUZ0WlNJNkluTmhZMmhwYm1GallXUmxiWGxmWkdJaUxDSjBaVzVoYm5SSlpDSTZJaUlzSW1ScGMzQnZjMkZpYkdVaU9tWmhiSE5sZlEuOExNMGlUMmQwdXZfZ0lZWURwZld5YldlM0g3ZFRva0xJRXhNdkN2cGoyVSJ9.u8BMqHuX_cBPDaw0v_Bfuh2WTIzeTAAE7yIc0wu-nwM", "batch_id": "281", "batch_name": "UP SUPERTET PRIMARY (1st to 5th) COMPLETE BATCH", "batch_image": "https://appx-content-v2.classx.co.in/paid_course3/2026-09-09-0.35454020988220547.png" },
        { "userId": "860816", "token": "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpZCI6Ijg2MDgxNiIsInRpbWVzdGFtcCI6MTc4MDExNjU1MSwiaXZfdmVyIjozLCJzZXNzaW9uIjoiZXlKMGVYQWlPaUpLVjFRaUxDSmhiR2NpT2lKSVV6STFOaUo5LmV5SnBaQ0k2SWpnMk1EZ3hOaUlzSW1WdFlXbHNJam9pWVcxaGNtNWhkR2c1TURZMk5UUkFaMjFoYVd3dVkyOXRJaXdpYm1GdFpTSTZJa0Z0WVhKdVlYUm9JR3QxYldGeUlpd2lkR1Z1WVc1MFZIbHdaU0k2SW5WelpYSWlMQ0owWlc1aGJuUk9ZVzFsSWpvaWMyRmphR2x1WVdOaFpHVnRlVjlrWWlJc0luUmxibUZ1ZEVsa0lqb2lJaXdpWkdsemNHOXpZV0pzWlNJNlptRnNjMlY5LklBTnJlZFJOdERyb2lpdVU3cXBjR0Z6VVFxZlJwNEhyWE1YNDVKeHQzdm8ifQ.sc4TAXXGKmfvADLTcegfwkYHeJSYF1p_d7xuQGt6xqs", "batch_id": "248", "batch_name": "CTET PAPER - 1 & 2 COURSE*", "batch_image": "https://appx-content-v2.classx.co.in/paid_course3/2026-01-01-0.41797904061998503.jpg" },
        { "userId": "1727096", "token": "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpZCI6IjE3MjcwOTYiLCJ0aW1lc3RhbXAiOjE3ODAzMjMxMzUsIml2X3ZlciI6NTQsInNlc3Npb24iOiJleUowZVhBaU9pSktWMVFpTENKaGJHY2lPaUpJVXpJMU5pSjkuZXlKcFpDSTZJakUzTWpjd09UWWlMQ0psYldGcGJDSTZJbko1T1RnMk9EUTRPVUJuYldGcGJDNWpiMjBpTENKdVlXMWxJam9pVW1GdWFTQlpZV1JoZGlJc0luUmxibUZ1ZEZSNWNHVWlPaUoxYzJWeUlpd2lkR1Z1WVc1MFRtRnRaU0k2SW5OaFkyaHBibUZqWVdSbGJYbGZaR0lpTENKMFpXNWhiblJKWkNJNklpSXNJbVJwYzNCdmMyRmliR1VpT21aaGJITmxmUS5uNGpmczZZOXFPUWVvNHNFbkNWbGd3LWxldXNGSEh2ZmpRVFAxWng3Tm1zIn0.7XxHTfiG_z2xJM6yZZmDEuAg0dO6_cZt1Mz4uMNSXAo", "batch_id": "249", "batch_name": "CTET PAPER - 1 COURSE*", "batch_image": "https://appx-content-v2.classx.co.in/paid_course3/2026-01-01-0.755009849439867.jpg" },
        { "userId": "1727096", "token": "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpZCI6IjE3MjcwOTYiLCJ0aW1lc3RhbXAiOjE3ODAzMjMxMzUsIml2X3ZlciI6NTQsInNlc3Npb24iOiJleUowZVhBaU9pSktWMVFpTENKaGJHY2lPaUpJVXpJMU5pSjkuZXlKcFpDSTZJakUzTWpjd09UWWlMQ0psYldGcGJDSTZJbko1T1RnMk9EUTRPVUJuYldGcGJDNWpiMjBpTENKdVlXMWxJam9pVW1GdWFTQlpZV1JoZGlJc0luUmxibUZ1ZEZSNWNHVWlPaUoxYzJWeUlpd2lkR1Z1WVc1MFRtRnRaU0k2SW5OaFkyaHBibUZqWVdSbGJYbGZaR0lpTENKMFpXNWhiblJKWkNJNklpSXNJbVJwYzNCdmMyRmliR1VpT21aaGJITmxmUS5uNGpmczZZOXFPUWVvNHNFbkNWbGd3LWxldXNGSEh2ZmpRVFAxWng3Tm1zIn0.7XxHTfiG_z2xJM6yZZmDEuAg0dO6_cZt1Mz4uMNSXAo", "batch_id": "366", "batch_name": "CTET PAPER 1 COURSE (2026)", "batch_image": "https://appx-content-v2.classx.co.in/paid_course3/2026-09-12-0.8030011830980095.png" },
        { "userId": "74893", "token": "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpZCI6Ijc0ODkzIiwidGltZXN0YW1wIjoxNzgwNzMyODA4LCJpdl92ZXIiOjUsInNlc3Npb24iOiJleUowZVhBaU9pSktWMVFpTENKaGJHY2lPaUpJVXpJMU5pSjkuZXlKcFpDSTZJamMwT0Rreklpd2laVzFoYVd3aU9pSnBjMmgzWVhKamFHRnVaREEyTURjeE9UazJRR2R0WVdsc0xtTnZiU0lzSW01aGJXVWlPaUpKYzJoM1lYSmphR0Z1WkNJc0luUmxibUZ1ZEZSNWNHVWlPaUoxYzJWeUlpd2lkR1Z1WVc1MFRtRnRaU0k2SW5OaFkyaHBibUZqWVdSbGJYbGZaR0lpTENKMFpXNWhiblJKWkNJNklpSXNJbVJwYzNCdmMyRmliR1VpT21aaGJITmxmUS4wQm1ucnJfUEpQMVA1NG1Fb0RxalBGMkZUeDBNc2YzN1N1eDVhajVOcFRNIn0.yoI8Ezkd0uPrBf7jq_49N-rp9OI6O27GXe1WNb8TB_o", "batch_id": "345", "batch_name": "UP TGT COMPLETE BATCH (SCIENCE)", "batch_image": "https://appx-content-v2.classx.co.in/paid_course3/2026-09-07-0.2456988777095369.png" },
        { "userId": "203728", "token": "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpZCI6IjIwMzcyOCIsInRpbWVzdGFtcCI6MTc4MTIzMTMyNiwiaXZfdmVyIjoyLCJzZXNzaW9uIjoiZXlKMGVYQWlPaUpLVjFRaUxDSmhiR2NpT2lKSVV6STFOaUo5LmV5SnBaQ0k2SWpJd016Y3lPQ0lzSW1WdFlXbHNJam9pY21Gb2RXeDVZV1JoZGpJM01EY3hPVGszUUdkdFlXbHNMbU52YlNJc0ltNWhiV1VpT2lKeVlXaDFiQ0I1WVdSaGRpSXNJblJsYm1GdWRGUjVjR1VpT2lKMWMyVnlJaXdpZEdWdVlXNTBUbUZ0WlNJNkluTmhZMmhwYm1GallXUmxiWGxmWkdJaUxDSjBaVzVoYm5SSlpDSTZJaUlzSW1ScGMzQnZjMkZpYkdVaU9tWmhiSE5sZlEuX0RGbkNCV1JZZGF0LU9scWprZUFLSmFQcHFyVC1aX3RQeEpMb2l3SVJjZyJ9._hGDWD8UlbOFbE-1mzvnYLnGahxY3_JAHyWZZQnVeNs", "batch_id": "349", "batch_name": "UP PGT COMPLETE BATCH (HINDI)", "batch_image": "https://appx-content-v2.classx.co.in/paid_course3/2026-09-07-0.872367415319617.png" },
        { "userId": "587914", "token": "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpZCI6IjU4NzkxNCIsInRpbWVzdGFtcCI6MTc4MTUzMzc3OCwiaXZfdmVyIjoyLCJzZXNzaW9uIjoiZXlKMGVYQWlPaUpLVjFRaUxDSmhiR2NpT2lKSVV6STFOaUo5LmV5SnBaQ0k2SWpVNE56a3hOQ0lzSW1WdFlXbHNJam9pWVd0b2FXeGxjMmg1WVdSaGRqVXlORFEwUUdkdFlXbHNMbU52YlNJc0ltNWhiV1VpT2lKQlMwaEpURVZUU0NCTFZVMUJVaUJaUVVSQlZpSXNJblJsYm1GdWRGUjVjR1VpT2lKMWMyVnlJaXdpZEdWdVlXNTBUbUZ0WlNJNkluTmhZMmhwYm1GallXUmxiWGxmWkdJaUxDSjBaVzVoYm5SSlpDSTZJaUlzSW1ScGMzQnZjMkZpYkdVaU9tWmhiSE5sZlEudnlKQ1FtMmpRRXdycmx5SVF5cUFvbkI4emlHMWhBeG9oNzVvbS1qdHFOWSJ9.N7FfiUQBVM_5fHNprRzcGD87VlE1BvTLk9uquX7kY-o", "batch_id": "177", "batch_name": "BPSC TRE 4.0 PRT COMPLETE BATCH ✅", "batch_image": "https://appx-content-v2.classx.co.in/paid_course3/2025-12-21-0.7323578711421559.png" },
        { "userId": "587914", "token": "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpZCI6IjU4NzkxNCIsInRpbWVzdGFtcCI6MTc4MTUzMzc3OCwiaXZfdmVyIjoyLCJzZXNzaW9uIjoiZXlKMGVYQWlPaUpLVjFRaUxDSmhiR2NpT2lKSVV6STFOaUo5LmV5SnBaQ0k2SWpVNE56a3hOQ0lzSW1WdFlXbHNJam9pWVd0b2FXeGxjMmg1WVdSaGRqVXlORFEwUUdkdFlXbHNMbU52YlNJc0ltNWhiV1VpT2lKQlMwaEpURVZUU0NCTFZVMUJVaUJaUVVSQlZpSXNJblJsYm1GdWRGUjVjR1VpT2lKMWMyVnlJaXdpZEdWdVlXNTBUbUZ0WlNJNkluTmhZMmhwYm1GallXUmxiWGxmWkdJaUxDSjBaVzVoYm5SSlpDSTZJaUlzSW1ScGMzQnZjMkZpYkdVaU9tWmhiSE5sZlEudnlKQ1FtMmpRRXdycmx5SVF5cUFvbkI4emlHMWhBeG9oNzVvbS1qdHFOWSJ9.N7FfiUQBVM_5fHNprRzcGD87VlE1BvTLk9uquX7kY-o", "batch_id": "323", "batch_name": "BIHAR TRE 4.0 PRT COMPLETE BATCH", "batch_image": "https://appx-content-v2.classx.co.in/paid_course3/2026-09-07-0.009894269282128887.png" },
        { "userId": "512314", "token": "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpZCI6IjUxMjMxNCIsInRpbWVzdGFtcCI6MTc4MDI3ODgxMiwiaXZfdmVyIjoxOSwic2Vzc2lvbiI6ImV5SjBlWEFpT2lKS1YxUWlMQ0poYkdjaU9pSklVekkxTmlKOS5leUpwWkNJNklqVXhNak14TkNJc0ltVnRZV2xzSWpvaWMyaHBkbk5vWVc1cllYSjVZV1JoZGpVMk1rQm5iV0ZwYkM1amIyMGlMQ0p1WVcxbElqb2ljMmhwZG5Ob1lXNXJZWElnZVdGa1lYWWlMQ0owWlc1aGJuUlVlWEJsSWpvaWRYTmxjaUlzSW5SbGJtRnVkRTVoYldVaU9pSnpZV05vYVc1aFkyRmtaVzE1WDJSaUlpd2lkR1Z1WVc1MFNXUWlPaUlpTENKa2FYTndiM05oWW14bElqcG1ZV3h6WlgwLkpmYVFjUm9FWGFGNXJhLUpXNENIRWdnRnk4WEJwYmtQNmdKdGJIcXE2b0EifQ.P1ziwRM5dveL-juW_qRSZNrzq5UThKa-r9hLU5edgIA", "batch_id": "179", "batch_name": "BPSC TRE 4.0 (6th TO 8th) COMPLETE BATCH (LANGUAGE + G.S + ENGLISH)✅", "batch_image": "https://appx-content-v2.classx.co.in/paid_course3/2025-12-21-0.6872761799484489.png" },
        { "userId": "512314", "token": "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpZCI6IjUxMjMxNCIsInRpbWVzdGFtcCI6MTc4MDI3ODgxMiwiaXZfdmVyIjoxOSwic2Vzc2lvbiI6ImV5SjBlWEFpT2lKS1YxUWlMQ0poYkdjaU9pSklVekkxTmlKOS5leUpwWkNJNklqVXhNak14TkNJc0ltVnRZV2xzSWpvaWMyaHBkbk5vWVc1cllYSjVZV1JoZGpVMk1rQm5iV0ZwYkM1amIyMGlMQ0p1WVcxbElqb2ljMmhwZG5Ob1lXNXJZWElnZVdGa1lYWWlMQ0owWlc1aGJuUlVlWEJsSWpvaWRYTmxjaUlzSW5SbGJtRnVkRTVoYldVaU9pSnpZV05vYVc1aFkyRmtaVzE1WDJSaUlpd2lkR1Z1WVc1MFNXUWlPaUlpTENKa2FYTndiM05oWW14bElqcG1ZV3h6WlgwLkpmYVFjUm9FWGFGNXJhLUpXNENIRWdnRnk4WEJwYmtQNmdKdGJIcXE2b0EifQ.P1ziwRM5dveL-juW_qRSZNrzq5UThKa-r9hLU5edgIA", "batch_id": "319", "batch_name": "BIHAR TRE 4.0 (6th TO 8th) COMPLETE BATCH (LANGUAGE + G.S + ENGLISH)", "batch_image": "https://appx-content-v2.classx.co.in/paid_course3/2026-09-07-0.8661632685465565.png" },
        { "userId": "512314", "token": "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpZCI6IjUxMjMxNCIsInRpbWVzdGFtcCI6MTc4MDI3ODgxMiwiaXZfdmVyIjoxOSwic2Vzc2lvbiI6ImV5SjBlWEFpT2lKS1YxUWlMQ0poYkdjaU9pSklVekkxTmlKOS5leUpwWkNJNklqVXhNak14TkNJc0ltVnRZV2xzSWpvaWMyaHBkbk5vWVc1cllYSjVZV1JoZGpVMk1rQm5iV0ZwYkM1amIyMGlMQ0p1WVcxbElqb2ljMmhwZG5Ob1lXNXJZWElnZVdGa1lYWWlMQ0owWlc1aGJuUlVlWEJsSWpvaWRYTmxjaUlzSW5SbGJtRnVkRTVoYldVaU9pSnpZV05vYVc1aFkyRmtaVzE1WDJSaUlpd2lkR1Z1WVc1MFNXUWlPaUlpTENKa2FYTndiM05oWW14bElqcG1ZV3h6WlgwLkpmYVFjUm9FWGFGNXJhLUpXNENIRWdnRnk4WEJwYmtQNmdKdGJIcXE2b0EifQ.P1ziwRM5dveL-juW_qRSZNrzq5UThKa-r9hLU5edgIA", "batch_id": "361", "batch_name": "JHARKHAND TET PAPER - 2 COURSE", "batch_image": "https://appx-content-v2.classx.co.in/paid_course3/2026-09-07-0.18984778730489593.png" }
    ]
};

// ============================================================================
// FETCH WITH RETRY
// ============================================================================

async function fetchWithRetry(url, options = {}, timeout = PAGE_TIMEOUT, retries = UPSTREAM_RETRIES) {
    const host = new URL(url).host;
    const isMedia = /\.(ts|m4s|mp4|aac|m3u8|mpd|key)(\?|$)/i.test(url);

    if (!isMedia) {
        const cd = hostCooldownRemaining(host);
        if (cd > 0) await sleep(Math.min(cd, 5000));
    }

    const run = async () => {
        let attempt = 0;
        let lastError = null;
        while (attempt <= retries) {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeout);
            try {
                if (attempt > 0) await sleep(jitter());
                const response = await fetch(url, { ...options, signal: controller.signal });
                clearTimeout(timer);
                if (response.ok || response.status === 206 || response.status === 304) return response;
                if (response.status === 429 || response.status >= 500) {
                    if (response.status === 429 && !isMedia) setHostCooldown(host);
                    lastError = new Error(`Upstream ${response.status} on ${host}`);
                    const delay = Math.min(UPSTREAM_BASE_DELAY * Math.pow(2, attempt) + jitter(400), UPSTREAM_MAX_DELAY);
                    await sleep(delay);
                    attempt++;
                    continue;
                }
                return response;
            } catch (err) {
                clearTimeout(timer);
                lastError = err;
                if (attempt >= retries) break;
                const delay = Math.min(UPSTREAM_BASE_DELAY * Math.pow(2, attempt) + jitter(400), UPSTREAM_MAX_DELAY);
                await sleep(delay);
                attempt++;
            }
        }
        throw lastError || new Error("Upstream failed");
    };

    if (isMedia) return run();
    return upstreamLimiter.run(run);
}

async function coalescedFetch(key, fetcher) {
    const cached = cacheGet(key);
    if (cached) return cached;
    if (inflightRequests.has(key)) return inflightRequests.get(key);
    const p = (async () => {
        try {
            const data = await fetcher();
            cacheSet(key, data);
            return data;
        } finally { inflightRequests.delete(key); }
    })();
    inflightRequests.set(key, p);
    return p;
}

// ============================================================================
// HELPERS
// ============================================================================

function findMatchingBatch(list, courseId) {
    const wanted = String(courseId).trim();
    for (const item of list) {
        if (!item || typeof item !== "object") continue;
        const rawId = item.batch_id ?? item.batchId ?? item.id;
        if (rawId === undefined || rawId === null) continue;
        if (String(rawId).trim() !== wanted) continue;
        const rawU = item.userId ?? item.user_id;
        const rawT = item.token ?? item.authorization;
        if (rawU == null || rawT == null) return null;
        const userId = String(rawU).trim();
        const token = String(rawT).trim();
        if (!userId || !token) return null;
        return { userId, token, batchId: wanted };
    }
    return null;
}

async function upstreamFetchJson(apiUrl, account, extra = {}) {
    return coalescedFetch(`json:${apiUrl}`, async () => {
        const r = await fetchWithRetry(apiUrl, {
            method: "GET",
            headers: {
                "Accept": "*/*",
                "Auth-Key": "appxapi",
                "Authorization": account.token,
                "Client-Service": "Appx",
                "Device-Type": "",
                "Is-Safari": "0",
                "Source": "website",
                "User-Id": account.userId,
                ...extra
            }
        }, PAGE_TIMEOUT);
        if (!r.ok) throw new Error(`Upstream HTTP ${r.status}`);
        return await r.json();
    });
}

// ============================================================================
// ROOT ROUTES
// ============================================================================

app.get("/", (req, res) => {
    res.json({ status: 200, message: "StudyBee API running", time: new Date().toISOString() });
});

app.get("/health", (req, res) => {
    res.json({
        status: 200,
        uptime: process.uptime(),
        cacheSize: responseCache.size,
        inflight: inflightRequests.size,
        activeUpstream: upstreamLimiter.active,
        queued: upstreamLimiter.queue.length,
        cooldowns: Array.from(hostCooldowns.entries()).map(([h, u]) => ({ host: h, remainingMs: Math.max(0, u - Date.now()) }))
    });
});

// ============================================================================
// API ROUTES
// ============================================================================

app.get(["/api/subjects", "/sex/api/subjects"], async (req, res) => {
    try {
        const courseId = getParam(req, "id");
        if (!courseId) return jsonResponse(res, { status: 400, error: "Missing course ID.", data: [] }, 400);
        const account = findMatchingBatch(TOKEN_STORE.data, courseId);
        if (!account) return jsonResponse(res, { status: 404, error: "No matching batch found.", courseId, data: [] }, 404);
        const url = new URL(SUBJECT_API);
        url.searchParams.set("courseid", courseId);
        url.searchParams.set("start", "-1");
        const json = await upstreamFetchJson(url.toString(), account);
        return jsonResponse(res, { status: 200, courseId, data: Array.isArray(json.data) ? json.data : (json.data ?? []) });
    } catch (e) {
        return jsonResponse(res, { status: 500, error: e?.message || "Server Error", data: [] }, 500);
    }
});

app.get(["/api/topics", "/sex/api/topics"], async (req, res) => {
    try {
        const courseId = getParam(req, "id");
        const subjectId = getParam(req, "subjectid");
        if (!courseId) return jsonResponse(res, { status: 400, error: "Missing course ID.", data: [] }, 400);
        if (!subjectId) return jsonResponse(res, { status: 400, error: "Missing subject ID.", courseId, data: [] }, 400);
        const account = findMatchingBatch(TOKEN_STORE.data, courseId);
        if (!account) return jsonResponse(res, { status: 404, error: "No matching batch found.", courseId, subjectId, data: [] }, 404);
        const url = new URL(TOPICS_API);
        url.searchParams.set("courseid", courseId);
        url.searchParams.set("subjectid", subjectId);
        url.searchParams.set("start", "-1");
        const json = await upstreamFetchJson(url.toString(), account);
        return jsonResponse(res, { status: 200, courseId, subjectId, data: Array.isArray(json.data) ? json.data : (json.data ?? []) });
    } catch (e) {
        return jsonResponse(res, { status: 500, error: e?.message || "Server Error", data: [] }, 500);
    }
});

app.get(["/api/classes", "/sex/api/classes"], async (req, res) => {
    try {
        const courseId = getParam(req, "id");
        const subjectId = getParam(req, "subjectid");
        const conceptId = getParam(req, "conceptid");
        const topicId = getParam(req, "topicid", DEFAULT_TOPIC_ID) || DEFAULT_TOPIC_ID;
        if (!courseId) return jsonResponse(res, { status: 400, error: "Missing course ID.", data: [] }, 400);
        if (!subjectId) return jsonResponse(res, { status: 400, error: "Missing subject ID.", courseId, data: [] }, 400);
        const account = findMatchingBatch(TOKEN_STORE.data, courseId);
        if (!account) return jsonResponse(res, { status: 404, error: "No matching batch found.", courseId, subjectId, data: [] }, 404);
        const url = new URL(CLASSES_API);
        url.searchParams.set("courseid", courseId);
        url.searchParams.set("subjectid", subjectId);
        url.searchParams.set("topicid", topicId);
        url.searchParams.set("conceptid", conceptId);
        url.searchParams.set("windowsapp", "false");
        url.searchParams.set("start", "0");
        const json = await upstreamFetchJson(url.toString(), account);
        const dec = await decryptObject(json);
        return jsonResponse(res, { status: 200, courseId, subjectId, topicId, conceptId, data: Array.isArray(dec.data) ? dec.data : (dec.data ?? []) });
    } catch (e) {
        return jsonResponse(res, { status: 500, error: e?.message || "Server Error", data: [] }, 500);
    }
});

app.get(["/api/video", "/sex/api/video"], async (req, res) => {
    try {
        const courseId = getParam(req, "id");
        const videoId = getParam(req, "videoid");
        const ytFlag = getParam(req, "ytflag", "0");
        if (!courseId) return jsonResponse(res, { status: 400, error: "Missing course ID.", data: [] }, 400);
        if (!videoId) return jsonResponse(res, { status: 400, error: "Missing video ID.", courseId, data: [] }, 400);
        const account = findMatchingBatch(TOKEN_STORE.data, courseId);
        if (!account) return jsonResponse(res, { status: 404, error: "No matching batch found.", courseId, videoId, data: [] }, 404);
        const url = new URL(VIDEO_API);
        url.searchParams.set("course_id", courseId);
        url.searchParams.set("video_id", videoId);
        url.searchParams.set("ytflag", ytFlag);
        url.searchParams.set("folder_wise_course", "0");
        url.searchParams.set("lc_app_api_url", "");
        const json = await upstreamFetchJson(url.toString(), account);
        const dec = await decryptObject(json);
        return jsonResponse(res, { status: 200, courseId, videoId, ytflag: ytFlag, data: Array.isArray(dec.data) ? dec.data : (dec.data ?? []) });
    } catch (e) {
        return jsonResponse(res, { status: 500, error: e?.message || "Server Error", data: [] }, 500);
    }
});

app.get(["/api/live", "/sex/api/live"], async (req, res) => {
    try {
        const courseId = getParam(req, "id");
        if (!courseId) return jsonResponse(res, { status: 400, error: "Missing course ID.", data: [] }, 400);
        const account = findMatchingBatch(TOKEN_STORE.data, courseId);
        if (!account) return jsonResponse(res, { status: 404, error: "No matching batch found.", courseId, data: [] }, 404);
        const url = new URL(LIVE_API);
        url.searchParams.set("courseid", courseId);
        url.searchParams.set("start", "-1");
        const json = await upstreamFetchJson(url.toString(), account);
        const dec = await decryptObject(json);
        return jsonResponse(res, { status: 200, courseId, data: Array.isArray(dec.data) ? dec.data : (dec.data ?? []) });
    } catch (e) {
        return jsonResponse(res, { status: 500, error: e?.message || "Server Error", data: [] }, 500);
    }
});

app.get(["/api/previous_live", "/sex/api/previous_live"], async (req, res) => {
    try {
        const courseId = getParam(req, "id") || getParam(req, "course_id");
        if (!courseId) return jsonResponse(res, { status: 400, error: "Missing course ID.", data: [] }, 400);
        const account = findMatchingBatch(TOKEN_STORE.data, courseId);
        if (!account) return jsonResponse(res, { status: 404, error: "No matching batch found.", courseId, data: [] }, 404);
        const url = new URL(PREVIOUS_LIVE_API);
        url.searchParams.set("course_id", courseId);
        url.searchParams.set("start", "0");
        url.searchParams.set("folder_wise_course", "0");
        url.searchParams.set("userid", account.userId);
        const json = await upstreamFetchJson(url.toString(), account);
        const dec = await decryptObject(json);
        return jsonResponse(res, dec);
    } catch (e) {
        return jsonResponse(res, { status: 500, error: e?.message || "Server Error", data: [] }, 500);
    }
});

app.get(["/api/fetch_active", "/sex/api/fetch_active"], async (req, res) => {
    const requestUrl = new URL(req.url, `http://${req.headers.host}`);
    let page = Number(req.query.page || "1");
    if (!Number.isFinite(page) || page < 1) page = 1;
    page = Math.floor(page);

    try {
        const list = Array.isArray(TOKEN_STORE.data) ? TOKEN_STORE.data : [];
        const accounts = [];
        const seen = new Set();
        for (const item of list) {
            if (!item || typeof item !== "object") continue;
            const u = item.userId ?? item.user_id;
            const t = item.token ?? item.authorization;
            if (u == null || t == null) continue;
            const userId = String(u).trim();
            const token = String(t).trim();
            if (!userId || !token) continue;
            const key = `${userId}\u0000${token}`;
            if (seen.has(key)) continue;
            seen.add(key);
            accounts.push({ userId, token });
        }

        const totalAccounts = accounts.length;
        const totalPages = Math.ceil(totalAccounts / PAGE_SIZE);
        if (page > totalPages) {
            return jsonResponse(res, { status: 200, message: "No more pages.", page, pageSize: PAGE_SIZE, totalPages, hasNextPage: false, nextUrl: null, data: [] });
        }

        const start = (page - 1) * PAGE_SIZE;
        const end = Math.min(start + PAGE_SIZE, totalAccounts);
        const pageAccounts = accounts.slice(start, end);

        const results = [];
        for (const account of pageAccounts) {
            const apiUrl = `${COURSE_API}?userid=${encodeURIComponent(account.userId)}`;
            try {
                const json = await upstreamFetchJson(apiUrl, account, {
                    "origin": "https://sachinacademy.classx.co.in",
                    "referer": "https://sachinacademy.classx.co.in/",
                    "user-agent": "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36",
                    "device-type": "is-safari 0"
                });
                if (json && Array.isArray(json.data)) results.push({ success: true, userId: account.userId, token: account.token, courses: json.data });
                else results.push({ success: false, userId: account.userId, token: account.token, courses: [], error: "Invalid data[]" });
            } catch (err) {
                results.push({ success: false, userId: account.userId, token: account.token, courses: [], error: err.message });
            }
        }

        const courseMap = new Map();
        let activeAccounts = 0, failedAccounts = 0, totalBefore = 0;
        for (const r of results) {
            if (!r.success) { failedAccounts++; continue; }
            activeAccounts++;
            if (!Array.isArray(r.courses)) continue;
            totalBefore += r.courses.length;
            for (const c of r.courses) {
                if (!c || c.id == null) continue;
                const cid = String(c.id);
                if (!courseMap.has(cid)) {
                    courseMap.set(cid, {
                        id: cid,
                        course_name: c.course_name || c.title || c.name || "Course Batch",
                        course_thumbnail: c.course_thumbnail || c.thumbnail || c.cover || "",
                        account: { userId: r.userId, token: r.token }
                    });
                }
            }
        }

        const built = { courses: Array.from(courseMap.values()), activeAccounts, failedAccounts, totalCoursesBeforeDedup: totalBefore };
        const hasNextPage = page < totalPages;
        const nextUrl = hasNextPage ? `${requestUrl.origin}/api/fetch_active?page=${page + 1}` : null;

        return jsonResponse(res, {
            status: 200, page, pageSize: PAGE_SIZE, totalPages, hasNextPage, nextUrl,
            pagination: { page, pageSize: PAGE_SIZE, totalPages, hasNextPage, nextUrl },
            stats: {
                rawEntries: list.length, validEntries: accounts.length,
                duplicatesRemoved: list.length - accounts.length,
                activeAccounts: built.activeAccounts, failedAccounts: built.failedAccounts,
                totalCoursesBeforeDedup: built.totalCoursesBeforeDedup,
                uniqueCourses: built.courses.length
            },
            data: built.courses
        });
    } catch (e) {
        return jsonResponse(res, { status: 500, error: e?.message || "Server Error", data: [] }, 500);
    }
});

app.get(["/api/active", "/sex/api/active"], async (req, res) => {
    const key = req.query.key;
    if (!key || !ADMIN_KEYS.has(key)) return jsonResponse(res, { status: 401, error: "Unauthorized Access" }, 401);

    try {
        const batchMap = new Map();
        const visited = new Set();
        const pages = [];
        const errors = [];
        let totalPages = 0, totalReceived = 0, dupes = 0;
        let nextUrl = `http://${req.headers.host}/api/fetch_active?page=1`;

        while (nextUrl && totalPages < MAX_PAGES) {
            if (visited.has(nextUrl)) { errors.push({ url: nextUrl, error: "Loop detected." }); break; }
            visited.add(nextUrl);
            let json;
            try {
                const r = await fetchWithRetry(nextUrl, { method: "GET", headers: { "Accept": "application/json" } }, PAGE_TIMEOUT);
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                json = await r.json();
            } catch (e) {
                errors.push({ url: nextUrl, error: e?.message || "Failed" });
                break;
            }
            totalPages++;
            const courses = Array.isArray(json.data) ? json.data : [];
            totalReceived += courses.length;
            let pageDupes = 0;
            for (const c of courses) {
                if (!c || typeof c !== "object") continue;
                const acc = c.account;
                if (!acc || typeof acc !== "object") continue;
                const u = acc.userId ?? acc.user_id;
                if (u == null) continue;
                const userId = String(u).trim();
                if (!userId) continue;
                const token = acc.token ?? acc.authorization ?? "";
                if (c.id == null) continue;
                const id = String(c.id).trim();
                if (!id) continue;
                const name = c.batch_name ?? c.course_name ?? c.title ?? c.name ?? "Course Batch";
                const img = c.batch_image ?? c.course_thumbnail ?? c.thumbnail ?? c.cover ?? c.image ?? c.banner ?? "";
                if (batchMap.has(id)) { pageDupes++; continue; }
                batchMap.set(id, { userId, token, batch_id: id, batch_name: String(name), batch_image: String(img || "") });
            }
            dupes += pageDupes;
            pages.push({ page: json.pagination?.page ?? totalPages, batchesReceived: courses.length, uniqueBatchesAfterPage: batchMap.size, duplicatesFound: pageDupes });
            const cand = json.pagination?.nextUrl || json.nextUrl || null;
            if (cand) {
                try { nextUrl = new URL(cand, `http://${req.headers.host}`).toString(); }
                catch { errors.push({ url: cand, error: "Invalid nextUrl" }); break; }
            } else nextUrl = null;
        }

        const data = Array.from(batchMap.values());
        return jsonResponse(res, {
            status: 200,
            message: `Fetched ${data.length} unique batches from ${totalPages} pages.`,
            pagination: { pagesFetched: totalPages, maxPages: MAX_PAGES, complete: !nextUrl, stoppedByMaxPages: Boolean(nextUrl && totalPages >= MAX_PAGES), remainingNextUrl: nextUrl || null },
            stats: { batchesReceivedAcrossPages: totalReceived, uniqueBatches: data.length, duplicateBatchesRemoved: dupes },
            pages, errors, data
        });
    } catch (e) {
        return jsonResponse(res, { status: 500, error: e?.message || "Server Error", data: [] }, 500);
    }
});

app.get(["/api/batches", "/sex/api/batches"], async (req, res) => {
    try {
        const url = `http://${req.headers.host}/api/active?key=${ACTIVE_KEY}`;
        const r = await fetchWithRetry(url, { method: "GET", headers: { "Accept": "application/json" } }, PAGE_TIMEOUT);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const json = await r.json();
        const src = Array.isArray(json.data) ? json.data : [];
        const map = new Map();
        for (const item of src) {
            if (!item || typeof item !== "object") continue;
            const rawId = item.batch_id ?? item.id;
            if (rawId == null) continue;
            const id = String(rawId).trim();
            if (!id || map.has(id)) continue;
            const name = item.batch_name ?? item.course_name ?? item.title ?? item.name ?? "Course Batch";
            const img = item.batch_image ?? item.course_thumbnail ?? item.thumbnail ?? item.cover ?? item.image ?? item.banner ?? "";
            map.set(id, { id, batch_name: String(name), batch_image: String(img || "") });
        }
        const data = Array.from(map.values());
        return jsonResponse(res, { status: 200, message: `Fetched ${data.length} batches.`, count: data.length, data });
    } catch (e) {
        return jsonResponse(res, { status: 500, error: e?.message || "Server Error", data: [] }, 500);
    }
});

// ============================================================================
// /api/player — FINAL WORKING STREAM PROXY
// ============================================================================

app.all(["/api/player", "/sex/api/player"], async (req, res) => {
    if (req.method === "OPTIONS") return res.status(204).set(STREAM_HEADERS).end();

    // ── Step 1: Recover the FULL target URL from raw query string ──
    const targetUrl = recoverTargetUrl(req);

    // ── Step 2: If no target → proxy Akamai portal asset ──
    if (!targetUrl) {
        return proxyPortalAsset(req, res);
    }

    // ── Step 3: Build upstream request headers ──
    const upstreamHeaders = {
        "Host": targetUrl.host,
        "Origin": TARGET_ORIGIN,
        "Referer": TARGET_ORIGIN + "/",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
        "Accept": "*/*",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "identity"
    };
    if (req.headers.range) upstreamHeaders["Range"] = req.headers.range;
    if (req.headers["if-range"]) upstreamHeaders["If-Range"] = req.headers["if-range"];
    if (req.headers["if-none-match"]) upstreamHeaders["If-None-Match"] = req.headers["if-none-match"];
    if (req.headers["if-modified-since"]) upstreamHeaders["If-Modified-Since"] = req.headers["if-modified-since"];

    let upstream;
    try {
        upstream = await fetchWithRetry(targetUrl.href, {
            method: req.method === "HEAD" ? "HEAD" : "GET",
            headers: upstreamHeaders,
            redirect: "follow"
        }, 30000, 4);
    } catch (e) {
        console.error("[player] upstream fetch failed:", e.message);
        return res.status(502).set(STREAM_HEADERS).send(`Upstream fetch failed: ${e.message}`);
    }

    // ── Step 4: If upstream returned 4xx/5xx, pass through + log ──
    if (upstream.status >= 400) {
        console.error(`[player] upstream ${upstream.status} for ${targetUrl.host}${targetUrl.pathname}`);
        const body = await upstream.text().catch(() => "");
        const headers = {};
        upstream.headers.forEach((v, k) => { headers[k] = v; });
        headers["Access-Control-Allow-Origin"] = "*";
        return res.status(upstream.status).set(headers).send(body);
    }

    // ── Step 5: Pass through response headers ──
    const passthrough = ["content-type", "content-length", "content-encoding", "cache-control", "etag", "last-modified", "accept-ranges", "content-range", "vary", "expires"];
    for (const h of passthrough) {
        const v = upstream.headers.get(h);
        if (v) res.setHeader(h, v);
    }
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges, Content-Type");
    if (!upstream.headers.get("accept-ranges")) res.setHeader("Accept-Ranges", "bytes");

    const contentType = (upstream.headers.get("content-type") || "").toLowerCase();
    const isM3U8 = contentType.includes("mpegurl")
        || contentType.includes("application/x-mpegurl")
        || contentType.includes("vnd.apple.mpegurl")
        || targetUrl.pathname.toLowerCase().endsWith(".m3u8")
        || targetUrl.pathname.toLowerCase().endsWith(".m3u");

    // ── Step 6: HLS manifest rewriting ──
    if (isM3U8) {
        let manifest;
        try {
            manifest = await upstream.text();
        } catch (e) {
            return res.status(502).send(`Manifest read error: ${e.message}`);
        }

        // Sanity check — must start with #EXTM3U (allow BOM)
        if (!manifest || !manifest.replace(/^\uFEFF/, "").trimStart().startsWith("#EXTM3U")) {
            console.warn("[player] Not a valid M3U8. First 200 chars:", manifest.slice(0, 200));
            // Still return it raw if short — might be an error page
            res.removeHeader("content-length");
            res.setHeader("Content-Type", "text/plain");
            return res.status(upstream.status).send(manifest);
        }

        const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
        const host = req.headers["x-forwarded-host"] || req.headers.host;
        const basePath = "/api/player";
        const baseForRelative = targetUrl.href.substring(0, targetUrl.href.lastIndexOf("/") + 1);

        const rewritten = manifest.split("\n").map((line) => {
            const raw = line;
            const trimmed = line.trim();
            if (!trimmed) return raw;

            // Rewrite URI="..." attributes inside tags
            if (trimmed.startsWith("#")) {
                return raw.replace(/URI="([^"]+)"/g, (_, uri) => {
                    let abs;
                    try { abs = new URL(uri, baseForRelative).href; }
                    catch { return `URI="${uri}"`; }
                    return `URI="${proto}://${host}${basePath}?url=${encodeURIComponent(abs)}"`;
                });
            }

            // Segment / sub-playlist URL
            let abs;
            try { abs = new URL(trimmed, baseForRelative).href; }
            catch { return raw; }
            return `${proto}://${host}${basePath}?url=${encodeURIComponent(abs)}`;
        });

        res.removeHeader("content-length");
        res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
        res.setHeader("Cache-Control", "no-cache");
        return res.status(upstream.status).send(rewritten.join("\n"));
    }

    // ── Step 7: Binary passthrough ──
    res.status(upstream.status);

    if (req.method === "HEAD" || !upstream.body) return res.end();

    const nodeStream = Readable.fromWeb(upstream.body);
    nodeStream.on("error", (err) => {
        console.error("[player] stream error:", err.message);
        if (!res.headersSent) res.status(502).end();
        else res.destroy();
    });
    req.on("close", () => {
        if (!nodeStream.destroyed) nodeStream.destroy();
    });
    nodeStream.pipe(res);
});

// ----------------------------------------------------------------------------
// Recover full URL from raw query string (handles & inside the target URL)
// ----------------------------------------------------------------------------
function recoverTargetUrl(req) {
    // req.originalUrl looks like: /api/player?url=https%3A%2F%2F...%3Fedge-cache-token%3D...%26bitrate%3D720&title=...
    const originalUrl = req.originalUrl || req.url || "";
    const qIndex = originalUrl.indexOf("?");
    const rawQuery = qIndex >= 0 ? originalUrl.slice(qIndex + 1) : "";

    let candidate = null;

    if (rawQuery) {
        // Find url= in raw query
        const parts = rawQuery.split("&");
        let collecting = false;
        const buffer = [];
        for (const part of parts) {
            if (!collecting) {
                if (part.startsWith("url=")) {
                    collecting = true;
                    buffer.push(part.slice(4));
                }
            } else {
                // Heuristic: known own params that terminate the url value
                if (/^(title|t|_t|_|v|ts)=/.test(part)) break;
                buffer.push(part);
            }
        }
        if (buffer.length) {
            // Rejoin with & (they were separated by raw & but belong to the target)
            let joined = buffer.join("&");
            // Now decode progressively to unwrap nested encodings
            candidate = joined;
        }
    }

    if (!candidate && req.query.url) candidate = String(req.query.url).trim();
    if (!candidate) return null;

    // Progressive decode + unwrap
    for (let i = 0; i < 6; i++) {
        const before = candidate;
        try {
            const dec = decodeURIComponent(candidate);
            if (dec !== candidate) candidate = dec;
        } catch { /* ignore */ }

        // If candidate is a URL pointing to our own /api/player, unwrap
        try {
            const parsed = new URL(candidate, `http://${req.headers.host}`);
            if ((parsed.pathname.endsWith("/api/player") || parsed.pathname.endsWith("/sex/api/player"))) {
                const inner = parsed.searchParams.get("url");
                if (inner && inner !== candidate) {
                    candidate = inner;
                    continue;
                }
            }
            if ((parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.host !== req.headers.host) {
                return parsed;
            }
        } catch { /* fall through */ }

        // Direct parse
        try {
            const direct = new URL(candidate);
            if (direct.protocol === "http:" || direct.protocol === "https:") return direct;
        } catch { /* keep looping */ }

        if (candidate.startsWith("//")) {
            try { return new URL("https:" + candidate); } catch { /* keep looping */ }
        }

        if (before === candidate) break; // no progress → stop
    }

    return null;
}

// ----------------------------------------------------------------------------
// Proxy Akamai portal asset (when no ?url= target is provided)
// ----------------------------------------------------------------------------
async function proxyPortalAsset(req, res) {
    const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
    const host = req.headers["x-forwarded-host"] || req.headers.host;
    const incoming = new URL(req.originalUrl, `${proto}://${host}`);
    const targetPath = incoming.pathname === "/" ? "/combined-img-player" : incoming.pathname;
    const destinationUrl = new URL(targetPath + incoming.search, TARGET_ORIGIN).href;

    try {
        const r = await fetchWithRetry(destinationUrl, {
            method: req.method,
            headers: {
                "Host": new URL(TARGET_ORIGIN).host,
                "Origin": TARGET_ORIGIN,
                "Referer": TARGET_ORIGIN + "/",
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
            },
            redirect: "follow"
        }, 30000, 3);

        const ct = r.headers.get("content-type") || "";

        if (ct.includes("text/html") || ct.includes("javascript")) {
            let text = await r.text();
            text = text.split(TARGET_ORIGIN).join(`${proto}://${host}`);
            res.setHeader("Content-Type", ct);
            res.setHeader("Access-Control-Allow-Origin", "*");
            return res.status(r.status).send(text);
        }

        for (const h of ["content-type", "content-length", "content-encoding", "cache-control", "etag", "last-modified"]) {
            const v = r.headers.get(h);
            if (v) res.setHeader(h, v);
        }
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.status(r.status);
        if (req.method === "HEAD" || !r.body) return res.end();
        const stream = Readable.fromWeb(r.body);
        stream.on("error", () => res.destroy());
        stream.pipe(res);
    } catch (e) {
        res.status(500).set(STREAM_HEADERS).send(`Portal proxy error: ${e.message}`);
    }
}

// ============================================================================
// STATIC / MISC
// ============================================================================

app.get(["/private.json", "/sex/private.json"], (req, res) => {
    res.set({
        "Content-Type": "application/json; charset=UTF-8",
        "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
        "Pragma": "no-cache",
        "Access-Control-Allow-Origin": "*"
    }).send(JSON.stringify(TOKEN_STORE));
});

app.get(["/tokens.json", "/sex/tokens.json"], (req, res) => {
    jsonResponse(res, { status: 404, message: "Not found", data: [] }, 404);
});

app.all(["/_private/*", "/_lib/*", "/sex/_private/*", "/sex/_lib/*"], (req, res) => {
    jsonResponse(res, { status: 404, message: "Not found", data: [] }, 404);
});

app.use((req, res) => {
    jsonResponse(res, { status: 404, message: "Not found", data: [] }, 404);
});

// ============================================================================
// START
// ============================================================================

app.listen(PORT, () => {
    console.log(`✅ StudyBee API running on port ${PORT}`);
    console.log(`   Concurrency: ${UPSTREAM_CONCURRENCY}`);
    console.log(`   Cache TTL: ${CACHE_TTL_MS}ms`);
    console.log(`   Retries: ${UPSTREAM_RETRIES}`);
});
