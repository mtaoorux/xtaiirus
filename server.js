// ============================================================================
// STUDYBEE API SERVER — RENDER DEPLOYMENT (WORKING STREAM PROXY)
// ============================================================================

import express from "express";
import cors from "cors";
import { Readable } from "node:stream";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: "*" }));
app.use(express.json());

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
const UPSTREAM_CONCURRENCY = 3;
const UPSTREAM_RETRIES = 5;
const UPSTREAM_BASE_DELAY = 800;
const UPSTREAM_MAX_DELAY = 15000;
const CACHE_TTL_MS = 60_000;
const RATE_LIMIT_COOLDOWN_MS = 30_000;
const REQUEST_JITTER_MS = 150;

const ADMIN_KEYS = new Set(["shivuu", "adii"]);
const ACTIVE_KEY = "shivuu";

const HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
    "Access-Control-Allow-Headers": "*",
    "Content-Type": "application/json; charset=UTF-8",
    "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
    "Pragma": "no-cache"
};

const PLAYER_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges, Content-Type",
    "Access-Control-Max-Age": "86400"
};

// ============================================================================
// IN-MEMORY CACHE
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
// HOST COOLDOWN
// ============================================================================

const hostCooldowns = new Map();

function hostIsCoolingDown(host) {
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
        if (this.active >= this.max) await new Promise(resolve => this.queue.push(resolve));
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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function jitter(ms = REQUEST_JITTER_MS) { return Math.floor(Math.random() * ms); }

function jsonResponse(res, payload, status = 200) {
    res.status(status).set(HEADERS).send(JSON.stringify(payload, null, 4));
}

function getParam(req, name, defaultValue = "") {
    const value = req.query[name];
    if (value === null || value === undefined) return defaultValue;
    return String(value).trim();
}

function base64ToUint8Array(base64) {
    try {
        if (typeof base64 !== "string") return null;
        let normalized = base64.replace(/-/g, "+").replace(/_/g, "/");
        while (normalized.length % 4 !== 0) normalized += "=";
        const binary = Buffer.from(normalized, "base64").toString("binary");
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return bytes;
    } catch { return null; }
}

async function decrypt(enc) {
    try {
        if (typeof enc !== "string") return null;
        const parts = enc.split(":");
        if (parts.length !== 2) return null;
        const [cipher, iv] = parts;
        if (!cipher || !iv) return null;
        const cipherBytes = base64ToUint8Array(cipher);
        const ivBytes = base64ToUint8Array(iv);
        if (!cipherBytes || !ivBytes || ivBytes.length !== 16) return null;
        const keyBytes = new TextEncoder().encode(DECRYPTION_KEY);
        if (keyBytes.length !== 16) return null;
        const cryptoKey = await globalThis.crypto.subtle.importKey("raw", keyBytes, { name: "AES-CBC" }, false, ["decrypt"]);
        const decrypted = await globalThis.crypto.subtle.decrypt({ name: "AES-CBC", iv: ivBytes }, cryptoKey, cipherBytes);
        return new TextDecoder("utf-8", { fatal: true }).decode(decrypted);
    } catch { return null; }
}

function isEncryptedString(value) {
    if (typeof value !== "string") return false;
    const parts = value.split(":");
    if (parts.length !== 2) return false;
    const [cipher, iv] = parts;
    if (!cipher || !iv) return false;
    const ivBytes = base64ToUint8Array(iv);
    return !!(ivBytes && ivBytes.length === 16);
}

async function decryptObject(value) {
    if (typeof value === "string") {
        if (!isEncryptedString(value)) return value;
        const decrypted = await decrypt(value);
        return decrypted === null ? value : decrypted;
    }
    if (Array.isArray(value)) {
        const output = [];
        for (const item of value) output.push(await decryptObject(item));
        return output;
    }
    if (value !== null && typeof value === "object") {
        const output = {};
        for (const [key, item] of Object.entries(value)) output[key] = await decryptObject(item);
        return output;
    }
    return value;
}

// ============================================================================
// TOKEN STORE (Embedded)
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
        { "userId": "512314", "token": "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpZCI6IjUxMjMxNCIsInRpbWVzdGFtcCI6MTc4MDI3ODgxMiwiaXZfdmVyIjoxOSwic2Vzc2lvbiI6ImV5SjBlWEFpT2lKS1YxUWlMQ0poYkdjaU9pSklVekkxTmlKOS5leUpwWkNJNklqVXhNak14TkNJc0ltVnRZV2xzSWpvaWMyaHBkbk5vWVc1cllYSjVZV1JoZGpVMk1rQm5iV0ZwYkM1amIyMGlMQ0p1WVcxbElqb2ljMmhwZG5Ob1lXNXJZWElnZVdGa1lYWWlMQ0owWlc1aGJuUlVlWEJsSWpvaWRYTmxjaUlzSW5SbGJtRnVkRTVoYldVaU9pSnpZV05vYVc1aFkyRmtaVzE1WDJSaUlpd2lkR1Z1WVc1MFNXUWlPaUlpTENKa2FYTndiM05oWW14bElqcG1ZV3h6WlgwLkpmYVFjUm9FWGFGNXJhLUpXNENIRWdnRnk4WEJwYmtQNmdKdGJIcXE2b0EifQ.P1ziwRM5dveL-juW_qRSZNrzq5UThKa-r9hLU5edgIA", "batch_id": "361", "batch_name": "JHARKHAND TET PAPER - 2 COURSE", "batch_image": "https://appx-content-v2.classx.co.in/paid_course3/2026-09-07-0.18984778730489593.jpg" }
    ]
};

// ============================================================================
// ANTI-429 FETCH
// ============================================================================

async function fetchWithRetry(url, options = {}, timeout = PAGE_TIMEOUT, retries = UPSTREAM_RETRIES) {
    const host = new URL(url).host;
    const isMedia = /\.(ts|m4s|mp4|aac|m3u8|mpd|key)(\?|$)/i.test(url);

    if (!isMedia) {
        const cooldown = hostIsCoolingDown(host);
        if (cooldown > 0) await sleep(Math.min(cooldown, 5000));
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
                    if (response.status === 429 && !isMedia) setHostCooldown(host, RATE_LIMIT_COOLDOWN_MS);
                    lastError = new Error(`Upstream ${response.status} on ${host}`);
                    const delay = Math.min(UPSTREAM_BASE_DELAY * Math.pow(2, attempt) + jitter(400), UPSTREAM_MAX_DELAY);
                    console.warn(`[retry] ${response.status} ${host} attempt ${attempt + 1}/${retries + 1} in ${delay}ms`);
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
        throw lastError || new Error("Upstream failed after retries");
    };

    if (isMedia) return run();
    return upstreamLimiter.run(run);
}

async function coalescedFetch(cacheKey, fetcher) {
    const cached = cacheGet(cacheKey);
    if (cached) return cached;
    if (inflightRequests.has(cacheKey)) return inflightRequests.get(cacheKey);

    const promise = (async () => {
        try {
            const data = await fetcher();
            cacheSet(cacheKey, data);
            return data;
        } finally {
            inflightRequests.delete(cacheKey);
        }
    })();

    inflightRequests.set(cacheKey, promise);
    return promise;
}

// ============================================================================
// HELPERS
// ============================================================================

function findMatchingBatch(tokenData, courseId) {
    const wantedId = String(courseId).trim();
    for (const item of tokenData) {
        if (!item || typeof item !== "object") continue;
        const rawBatchId = item.batch_id ?? item.batchId ?? item.id;
        if (rawBatchId === undefined || rawBatchId === null) continue;
        const batchId = String(rawBatchId).trim();
        if (batchId !== wantedId) continue;
        const rawUserId = item.userId ?? item.user_id;
        const rawToken = item.token ?? item.authorization;
        if (rawUserId === undefined || rawUserId === null || rawToken === undefined || rawToken === null) return null;
        const userId = String(rawUserId).trim();
        const token = String(rawToken).trim();
        if (!userId || !token) return null;
        return { userId, token, batchId };
    }
    return null;
}

async function fetchTokens() { return TOKEN_STORE; }

async function upstreamFetchJson(apiUrl, account, extraHeaders = {}) {
    const cacheKey = `json:${apiUrl}`;
    return coalescedFetch(cacheKey, async () => {
        const response = await fetchWithRetry(apiUrl, {
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
                ...extraHeaders
            }
        }, PAGE_TIMEOUT);
        if (!response.ok) throw new Error(`Upstream HTTP ${response.status}`);
        return await response.json();
    });
}

// ============================================================================
// ROUTES
// ============================================================================

app.get("/", (req, res) => {
    res.json({ status: 200, message: "StudyBee API Server is running.", time: new Date().toISOString() });
});

app.get("/health", (req, res) => {
    res.json({
        status: 200,
        uptime: process.uptime(),
        cacheSize: responseCache.size,
        inflight: inflightRequests.size,
        activeUpstream: upstreamLimiter.active,
        queued: upstreamLimiter.queue.length,
        cooldowns: Array.from(hostCooldowns.entries()).map(([host, until]) => ({
            host, remainingMs: Math.max(0, until - Date.now())
        }))
    });
});

// ---------- /api/subjects ----------
app.get(["/api/subjects", "/sex/api/subjects"], async (req, res) => {
    try {
        const courseId = getParam(req, "id");
        if (!courseId) return jsonResponse(res, { status: 400, error: "Missing course ID.", data: [] }, 400);
        const tokenResponse = await fetchTokens();
        const account = findMatchingBatch(tokenResponse.data, courseId);
        if (!account) return jsonResponse(res, { status: 404, error: "No matching batch found.", courseId, data: [] }, 404);
        const url = new URL(SUBJECT_API);
        url.searchParams.set("courseid", courseId);
        url.searchParams.set("start", "-1");
        const json = await upstreamFetchJson(url.toString(), account);
        return jsonResponse(res, { status: 200, courseId, data: Array.isArray(json.data) ? json.data : (json.data ?? []) });
    } catch (error) {
        return jsonResponse(res, { status: 500, error: error?.message || "Internal Server Error.", data: [] }, 500);
    }
});

// ---------- /api/topics ----------
app.get(["/api/topics", "/sex/api/topics"], async (req, res) => {
    try {
        const courseId = getParam(req, "id");
        const subjectId = getParam(req, "subjectid");
        if (!courseId) return jsonResponse(res, { status: 400, error: "Missing course ID.", data: [] }, 400);
        if (!subjectId) return jsonResponse(res, { status: 400, error: "Missing subject ID.", courseId, data: [] }, 400);
        const tokenResponse = await fetchTokens();
        const account = findMatchingBatch(tokenResponse.data, courseId);
        if (!account) return jsonResponse(res, { status: 404, error: "No matching batch found.", courseId, subjectId, data: [] }, 404);
        const url = new URL(TOPICS_API);
        url.searchParams.set("courseid", courseId);
        url.searchParams.set("subjectid", subjectId);
        url.searchParams.set("start", "-1");
        const json = await upstreamFetchJson(url.toString(), account);
        return jsonResponse(res, { status: 200, courseId, subjectId, data: Array.isArray(json.data) ? json.data : (json.data ?? []) });
    } catch (error) {
        return jsonResponse(res, { status: 500, error: error?.message || "Internal Server Error.", data: [] }, 500);
    }
});

// ---------- /api/classes ----------
app.get(["/api/classes", "/sex/api/classes"], async (req, res) => {
    try {
        const courseId = getParam(req, "id");
        const subjectId = getParam(req, "subjectid");
        const conceptId = getParam(req, "conceptid");
        const topicId = getParam(req, "topicid", DEFAULT_TOPIC_ID) || DEFAULT_TOPIC_ID;
        if (!courseId) return jsonResponse(res, { status: 400, error: "Missing course ID.", data: [] }, 400);
        if (!subjectId) return jsonResponse(res, { status: 400, error: "Missing subject ID.", courseId, data: [] }, 400);
        const tokenResponse = await fetchTokens();
        const account = findMatchingBatch(tokenResponse.data, courseId);
        if (!account) return jsonResponse(res, { status: 404, error: "No matching batch found.", courseId, subjectId, data: [] }, 404);
        const url = new URL(CLASSES_API);
        url.searchParams.set("courseid", courseId);
        url.searchParams.set("subjectid", subjectId);
        url.searchParams.set("topicid", topicId);
        url.searchParams.set("conceptid", conceptId);
        url.searchParams.set("windowsapp", "false");
        url.searchParams.set("start", "0");
        const json = await upstreamFetchJson(url.toString(), account);
        const decoded = await decryptObject(json);
        return jsonResponse(res, { status: 200, courseId, subjectId, topicId, conceptId, data: Array.isArray(decoded.data) ? decoded.data : (decoded.data ?? []) });
    } catch (error) {
        return jsonResponse(res, { status: 500, error: error?.message || "Internal Server Error.", data: [] }, 500);
    }
});

// ---------- /api/video ----------
app.get(["/api/video", "/sex/api/video"], async (req, res) => {
    try {
        const courseId = getParam(req, "id");
        const videoId = getParam(req, "videoid");
        const ytFlag = getParam(req, "ytflag", "0");
        if (!courseId) return jsonResponse(res, { status: 400, error: "Missing course ID.", data: [] }, 400);
        if (!videoId) return jsonResponse(res, { status: 400, error: "Missing video ID.", courseId, data: [] }, 400);
        const tokenResponse = await fetchTokens();
        const account = findMatchingBatch(tokenResponse.data, courseId);
        if (!account) return jsonResponse(res, { status: 404, error: "No matching batch found.", courseId, videoId, data: [] }, 404);
        const url = new URL(VIDEO_API);
        url.searchParams.set("course_id", courseId);
        url.searchParams.set("video_id", videoId);
        url.searchParams.set("ytflag", ytFlag);
        url.searchParams.set("folder_wise_course", "0");
        url.searchParams.set("lc_app_api_url", "");
        const json = await upstreamFetchJson(url.toString(), account);
        const decoded = await decryptObject(json);
        return jsonResponse(res, { status: 200, courseId, videoId, ytflag: ytFlag, data: Array.isArray(decoded.data) ? decoded.data : (decoded.data ?? []) });
    } catch (error) {
        return jsonResponse(res, { status: 500, error: error?.message || "Internal Server Error.", data: [] }, 500);
    }
});

// ---------- /api/live ----------
app.get(["/api/live", "/sex/api/live"], async (req, res) => {
    try {
        const courseId = getParam(req, "id");
        if (!courseId) return jsonResponse(res, { status: 400, error: "Missing course ID.", data: [] }, 400);
        const tokenResponse = await fetchTokens();
        const account = findMatchingBatch(tokenResponse.data, courseId);
        if (!account) return jsonResponse(res, { status: 404, error: "No matching batch found.", courseId, data: [] }, 404);
        const url = new URL(LIVE_API);
        url.searchParams.set("courseid", courseId);
        url.searchParams.set("start", "-1");
        const json = await upstreamFetchJson(url.toString(), account);
        const decoded = await decryptObject(json);
        return jsonResponse(res, { status: 200, courseId, data: Array.isArray(decoded.data) ? decoded.data : (decoded.data ?? []) });
    } catch (error) {
        return jsonResponse(res, { status: 500, error: error?.message || "Internal Server Error.", data: [] }, 500);
    }
});

// ---------- /api/previous_live ----------
app.get(["/api/previous_live", "/sex/api/previous_live"], async (req, res) => {
    try {
        const courseId = getParam(req, "id") || getParam(req, "course_id");
        if (!courseId) return jsonResponse(res, { status: 400, error: "Missing course ID.", data: [] }, 400);
        const tokenResponse = await fetchTokens();
        const account = findMatchingBatch(tokenResponse.data, courseId);
        if (!account) return jsonResponse(res, { status: 404, error: "No matching batch found.", courseId, data: [] }, 404);
        const url = new URL(PREVIOUS_LIVE_API);
        url.searchParams.set("course_id", courseId);
        url.searchParams.set("start", "0");
        url.searchParams.set("folder_wise_course", "0");
        url.searchParams.set("userid", account.userId);
        const json = await upstreamFetchJson(url.toString(), account);
        const decoded = await decryptObject(json);
        return jsonResponse(res, decoded);
    } catch (error) {
        return jsonResponse(res, { status: 500, error: error?.message || "Internal Server Error.", data: [] }, 500);
    }
});

// ---------- /api/fetch_active ----------
app.get(["/api/fetch_active", "/sex/api/fetch_active"], async (req, res) => {
    const requestUrl = new URL(req.url, `http://${req.headers.host}`);
    let page = Number(req.query.page || "1");
    if (!Number.isFinite(page) || page < 1) page = 1;
    page = Math.floor(page);

    try {
        const tokenData = TOKEN_STORE;
        const list = Array.isArray(tokenData.data) ? tokenData.data : [];
        const accounts = [];
        const seenPairs = new Set();
        for (const item of list) {
            if (!item || typeof item !== "object") continue;
            const rawUserId = item.userId ?? item.user_id;
            const rawToken = item.token ?? item.authorization;
            if (rawUserId === undefined || rawToken === undefined) continue;
            const userId = String(rawUserId).trim();
            const token = String(rawToken).trim();
            if (!userId || !token) continue;
            const key = `${userId}\u0000${token}`;
            if (seenPairs.has(key)) continue;
            seenPairs.add(key);
            accounts.push({ userId, token });
        }

        const totalAccounts = accounts.length;
        const totalPages = Math.ceil(totalAccounts / PAGE_SIZE);
        if (page > totalPages) {
            return jsonResponse(res, { status: 200, message: "No more pages.", page, pageSize: PAGE_SIZE, totalPages, hasNextPage: false, nextUrl: null, data: [] });
        }

        const startIndex = (page - 1) * PAGE_SIZE;
        const endIndex = Math.min(startIndex + PAGE_SIZE, totalAccounts);
        const pageAccounts = accounts.slice(startIndex, endIndex);

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
        let activeAccounts = 0, failedAccounts = 0, totalCoursesBeforeDedup = 0;

        for (const result of results) {
            if (!result.success) { failedAccounts++; continue; }
            activeAccounts++;
            if (!Array.isArray(result.courses)) continue;
            totalCoursesBeforeDedup += result.courses.length;
            for (const course of result.courses) {
                if (!course || course.id === undefined || course.id === null) continue;
                const courseId = String(course.id);
                if (!courseMap.has(courseId)) {
                    courseMap.set(courseId, {
                        id: courseId,
                        course_name: course.course_name || course.title || course.name || "Course Batch",
                        course_thumbnail: course.course_thumbnail || course.thumbnail || course.cover || "",
                        account: { userId: result.userId, token: result.token }
                    });
                }
            }
        }

        const built = { courses: Array.from(courseMap.values()), activeAccounts, failedAccounts, totalCoursesBeforeDedup };
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
    } catch (error) {
        return jsonResponse(res, { status: 500, error: error?.message || "Internal Server Error", data: [] }, 500);
    }
});

// ---------- /api/active ----------
app.get(["/api/active", "/sex/api/active"], async (req, res) => {
    const suppliedKey = req.query.key;
    if (!suppliedKey || !ADMIN_KEYS.has(suppliedKey)) {
        return jsonResponse(res, { status: 401, error: "Unauthorized Access" }, 401);
    }

    try {
        const batchMap = new Map();
        const visitedUrls = new Set();
        const pages = [];
        const errors = [];
        let totalPagesFetched = 0, totalBatchesReceived = 0, duplicateBatchesRemoved = 0;
        let nextUrl = `http://${req.headers.host}/api/fetch_active?page=1`;

        while (nextUrl && totalPagesFetched < MAX_PAGES) {
            if (visitedUrls.has(nextUrl)) { errors.push({ url: nextUrl, error: "Pagination loop detected." }); break; }
            visitedUrls.add(nextUrl);

            let json;
            try {
                const response = await fetchWithRetry(nextUrl, { method: "GET", headers: { "Accept": "application/json" } }, PAGE_TIMEOUT);
                if (!response.ok) throw new Error(`fetch_active HTTP ${response.status}`);
                json = await response.json();
                if (!json || typeof json !== "object") throw new Error("Invalid fetch_active response.");
            } catch (error) {
                errors.push({ url: nextUrl, error: error?.message || "Failed to fetch page." });
                break;
            }

            totalPagesFetched++;
            const courses = Array.isArray(json.data) ? json.data : [];
            totalBatchesReceived += courses.length;

            let pageDuplicates = 0;
            for (const course of courses) {
                if (!course || typeof course !== "object") continue;
                const account = course.account;
                if (!account || typeof account !== "object") continue;
                const rawUserId = account.userId ?? account.user_id;
                if (rawUserId === undefined || rawUserId === null) continue;
                const userId = String(rawUserId).trim();
                if (!userId) continue;
                const token = account.token ?? account.authorization ?? "";
                if (course.id === undefined || course.id === null) continue;
                const id = String(course.id).trim();
                if (!id) continue;
                const batchName = course.batch_name ?? course.course_name ?? course.title ?? course.name ?? "Course Batch";
                const batchImage = course.batch_image ?? course.course_thumbnail ?? course.thumbnail ?? course.cover ?? course.image ?? course.banner ?? course.batch_thumbnail ?? "";
                if (batchMap.has(id)) { pageDuplicates++; continue; }
                batchMap.set(id, { userId, token, batch_id: id, batch_name: String(batchName || "Course Batch"), batch_image: String(batchImage || "") });
            }

            duplicateBatchesRemoved += pageDuplicates;
            pages.push({ page: json.pagination?.page ?? totalPagesFetched, batchesReceived: courses.length, uniqueBatchesAfterPage: batchMap.size, duplicatesFound: pageDuplicates });

            const candidateNextUrl = json.pagination?.nextUrl || json.nextUrl || null;
            if (candidateNextUrl) {
                try { nextUrl = new URL(candidateNextUrl, `http://${req.headers.host}`).toString(); }
                catch { errors.push({ url: candidateNextUrl, error: "Invalid nextUrl." }); break; }
            } else nextUrl = null;
        }

        const data = Array.from(batchMap.values());
        return jsonResponse(res, {
            status: 200,
            message: `Fetched ${data.length} unique batches from ${totalPagesFetched} pages.`,
            pagination: { pagesFetched: totalPagesFetched, maxPages: MAX_PAGES, complete: !nextUrl, stoppedByMaxPages: Boolean(nextUrl && totalPagesFetched >= MAX_PAGES), remainingNextUrl: nextUrl || null },
            stats: { batchesReceivedAcrossPages: totalBatchesReceived, uniqueBatches: data.length, duplicateBatchesRemoved },
            pages, errors, data
        });
    } catch (error) {
        return jsonResponse(res, { status: 500, error: error?.message || "Internal Server Error", data: [] }, 500);
    }
});

// ---------- /api/batches ----------
app.get(["/api/batches", "/sex/api/batches"], async (req, res) => {
    try {
        const activeUrl = `http://${req.headers.host}/api/active?key=${ACTIVE_KEY}`;
        const response = await fetchWithRetry(activeUrl, { method: "GET", headers: { "Accept": "application/json" } }, PAGE_TIMEOUT);
        if (!response.ok) throw new Error(`active HTTP ${response.status}`);
        const json = await response.json();
        const sourceData = Array.isArray(json.data) ? json.data : [];

        const batchMap = new Map();
        for (const item of sourceData) {
            if (!item || typeof item !== "object") continue;
            const rawId = item.batch_id ?? item.id;
            if (rawId === null || rawId === undefined) continue;
            const id = String(rawId).trim();
            if (!id || batchMap.has(id)) continue;
            const rawName = item.batch_name ?? item.course_name ?? item.title ?? item.name ?? "Course Batch";
            const rawImage = item.batch_image ?? item.course_thumbnail ?? item.thumbnail ?? item.cover ?? item.image ?? item.banner ?? item.batch_thumbnail ?? "";
            batchMap.set(id, { id, batch_name: String(rawName || "Course Batch"), batch_image: String(rawImage || "") });
        }

        const data = Array.from(batchMap.values());
        return jsonResponse(res, { status: 200, message: `Fetched ${data.length} unique batches.`, count: data.length, data });
    } catch (error) {
        return jsonResponse(res, { status: 500, error: error?.message || "Internal Server Error.", data: [] }, 500);
    }
});

// ============================================================================
// /api/player — STREAM PROXY (FIXED)
// ============================================================================

app.all(["/api/player", "/sex/api/player"], async (req, res) => {
    if (req.method === "OPTIONS") {
        return res.status(204).set(PLAYER_HEADERS).end();
    }

    // ---------- Extract + unwrap the target URL ----------
    const targetUrl = extractTargetUrl(req);

    // ---------- If no valid URL → reverse proxy the Akamai portal ----------
    if (!targetUrl) {
        const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
        const host = req.headers["x-forwarded-host"] || req.headers.host;
        const incoming = new URL(req.originalUrl, `${proto}://${host}`);
        const targetPath = incoming.pathname === "/" ? "/combined-img-player" : incoming.pathname;
        const destinationUrl = new URL(targetPath + incoming.search, TARGET_ORIGIN).href;

        try {
            const upstream = await fetchWithRetry(destinationUrl, {
                method: req.method,
                headers: {
                    "Host": new URL(TARGET_ORIGIN).host,
                    "Origin": TARGET_ORIGIN,
                    "Referer": TARGET_ORIGIN + "/",
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
                },
                redirect: "follow"
            }, 30000, 3);

            const contentType = upstream.headers.get("content-type") || "";
            if (contentType.includes("text/html") || contentType.includes("javascript")) {
                let text = await upstream.text();
                text = text.split(TARGET_ORIGIN).join(`${proto}://${host}`);
                res.setHeader("Content-Type", contentType);
                res.setHeader("Access-Control-Allow-Origin", "*");
                return res.status(upstream.status).send(text);
            }

            if (upstream.headers.get("content-type")) res.setHeader("Content-Type", upstream.headers.get("content-type"));
            if (upstream.headers.get("content-length")) res.setHeader("Content-Length", upstream.headers.get("content-length"));
            res.setHeader("Access-Control-Allow-Origin", "*");
            res.status(upstream.status);
            if (req.method === "HEAD" || !upstream.body) return res.end();
            const stream = Readable.fromWeb(upstream.body);
            stream.on("error", () => res.destroy());
            return stream.pipe(res);
        } catch (err) {
            return res.status(500).set(PLAYER_HEADERS).send(`Portal Proxy Failure: ${err.message}`);
        }
    }

    // ---------- STREAM MODE ----------
    try {
        const upstreamHeaders = {
            "Host": targetUrl.host,
            "Origin": TARGET_ORIGIN,
            "Referer": TARGET_ORIGIN + "/",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
            "Accept": "*/*",
            "Accept-Language": "en-US,en;q=0.9"
        };

        // Forward Range header for MP4 seeking
        if (req.headers.range) upstreamHeaders["Range"] = req.headers.range;
        if (req.headers["if-range"]) upstreamHeaders["If-Range"] = req.headers["if-range"];
        if (req.headers["if-none-match"]) upstreamHeaders["If-None-Match"] = req.headers["if-none-match"];
        if (req.headers["if-modified-since"]) upstreamHeaders["If-Modified-Since"] = req.headers["if-modified-since"];

        const upstream = await fetchWithRetry(targetUrl.href, {
            method: req.method === "HEAD" ? "HEAD" : "GET",
            headers: upstreamHeaders,
            redirect: "follow"
        }, 30000, 4);

        // Pass through headers (case-insensitive)
        const passHeaders = ["content-type", "content-length", "content-encoding", "cache-control", "etag", "last-modified", "accept-ranges", "content-range", "vary", "expires"];
        for (const key of passHeaders) {
            const v = upstream.headers.get(key);
            if (v) res.setHeader(key, v);
        }
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges, Content-Type");
        if (!upstream.headers.get("accept-ranges")) res.setHeader("Accept-Ranges", "bytes");

        const contentType = (upstream.headers.get("content-type") || "").toLowerCase();

        // ---------- HLS manifest rewriting ----------
        if (contentType.includes("mpegurl") || contentType.includes("application/x-mpegurl") || contentType.includes("vnd.apple.mpegurl") || targetUrl.pathname.toLowerCase().endsWith(".m3u8")) {
            const manifest = await upstream.text();
            const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
            const host = req.headers["x-forwarded-host"] || req.headers.host;
            const basePath = "/api/player";

            const rewritten = manifest.split("\n").map((line) => {
                const trimmed = line.trim();
                if (!trimmed) return line;

                if (trimmed.startsWith("#")) {
                    return line.replace(/URI="([^"]+)"/g, (_, p1) => {
                        let abs;
                        try { abs = new URL(p1, targetUrl.href).href; }
                        catch { return `URI="${p1}"`; }
                        return `URI="${proto}://${host}${basePath}?url=${encodeURIComponent(abs)}"`;
                    });
                }

                let abs;
                try { abs = new URL(trimmed, targetUrl.href).href; }
                catch { return line; }
                return `${proto}://${host}${basePath}?url=${encodeURIComponent(abs)}`;
            });

            res.removeHeader("content-length");
            res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
            res.setHeader("Cache-Control", "no-cache");
            return res.status(upstream.status).send(rewritten.join("\n"));
        }

        // ---------- Binary passthrough (MP4, TS, etc.) ----------
        res.status(upstream.status);
        if (req.method === "HEAD" || !upstream.body) return res.end();

        const nodeStream = Readable.fromWeb(upstream.body);
        nodeStream.on("error", (err) => {
            console.error("[stream] body error:", err.message);
            if (!res.headersSent) res.status(502).end();
            else res.destroy();
        });
        req.on("close", () => {
            if (!nodeStream.destroyed) nodeStream.destroy();
        });
        nodeStream.pipe(res);
    } catch (err) {
        console.error("[stream] error:", err.message);
        if (!res.headersSent) return res.status(502).set(PLAYER_HEADERS).send(`Stream Engine Error: ${err.message}`);
        return res.end();
    }
});

// ----------------------------------------------------------------------------
// URL EXTRACTOR — handles nested / double-encoded cases
// ----------------------------------------------------------------------------
function extractTargetUrl(req) {
    let candidate = req.query.url;
    if (!candidate) return null;
    candidate = String(candidate).trim();

    for (let i = 0; i < 6; i++) {
        // Try decoding once more (handles double-encoding)
        try {
            const decoded = decodeURIComponent(candidate);
            if (decoded !== candidate) candidate = decoded;
        } catch { /* not encoded */ }

        // If candidate is our own URL with a nested ?url=, unwrap
        if (candidate.startsWith("http://") || candidate.startsWith("https://") || candidate.startsWith("/")) {
            try {
                const parsed = new URL(candidate, `http://${req.headers.host}`);
                // Only unwrap if it points to our own /api/player endpoint
                if (parsed.pathname.endsWith("/api/player") || parsed.pathname.endsWith("/sex/api/player")) {
                    const inner = parsed.searchParams.get("url");
                    if (inner && inner !== candidate) {
                        candidate = inner;
                        continue;
                    }
                }
                // Otherwise if it's a valid external URL, return it
                if (parsed.protocol === "http:" || parsed.protocol === "https:") {
                    // Only return if host is not our own
                    if (parsed.host !== req.headers.host) return parsed;
                }
            } catch { /* fall through */ }
        }

        // Direct parse attempt
        try {
            const direct = new URL(candidate);
            if (direct.protocol === "http:" || direct.protocol === "https:") return direct;
        } catch { /* keep looping */ }

        // Try protocol-relative
        if (candidate.startsWith("//")) {
            try { return new URL("https:" + candidate); } catch { /* keep looping */ }
        }
    }
    return null;
}

// ---------- /private.json ----------
app.get(["/private.json", "/sex/private.json"], (req, res) => {
    res.set({
        "Content-Type": "application/json; charset=UTF-8",
        "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
        "Pragma": "no-cache",
        "Access-Control-Allow-Origin": "*"
    }).send(JSON.stringify(TOKEN_STORE));
});

// ---------- /tokens.json (blocked) ----------
app.get(["/tokens.json", "/sex/tokens.json"], (req, res) => {
    jsonResponse(res, { status: 404, message: "Not found", data: [] }, 404);
});

// ---------- Block internal paths ----------
app.all(["/_private/*", "/_lib/*", "/sex/_private/*", "/sex/_lib/*"], (req, res) => {
    jsonResponse(res, { status: 404, message: "Not found", data: [] }, 404);
});

// ---------- 404 fallback ----------
app.use((req, res) => {
    jsonResponse(res, { status: 404, message: "Not found", data: [] }, 404);
});

// ---------- Global error handler ----------
app.use((err, req, res, next) => {
    console.error("Unhandled error:", err);
    if (res.headersSent) return next(err);
    jsonResponse(res, { status: 500, error: err.message || "Internal Server Error", data: [] }, 500);
});

// ---------- Cache cleanup ----------
setInterval(() => {
    const now = Date.now();
    let removed = 0;
    for (const [key, entry] of responseCache.entries()) {
        if (now > entry.expiry) { responseCache.delete(key); removed++; }
    }
    if (removed > 0) console.log(`[cache] Cleaned ${removed} expired entries.`);
}, 60_000);

// ---------- Start ----------
app.listen(PORT, () => {
    console.log(`✅ StudyBee API Server listening on port ${PORT}`);
    console.log(`   Upstream concurrency: ${UPSTREAM_CONCURRENCY}`);
    console.log(`   Retries per request: ${UPSTREAM_RETRIES}`);
    console.log(`   Cache TTL: ${CACHE_TTL_MS}ms`);
});

process.on("SIGTERM", () => { console.log("SIGTERM received"); process.exit(0); });
process.on("SIGINT", () => { console.log("SIGINT received"); process.exit(0); });
