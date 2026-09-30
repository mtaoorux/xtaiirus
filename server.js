// ============================================================================
// STUDYBEE — SINGLE FILE SERVER
// FILE: functions/[[path]].js
//
// Routes:
//   GET  /api/subjects?id=
//   GET  /api/topics?id=&subjectid=
//   GET  /api/classes?id=&subjectid=&topicid=
//   GET  /api/video?id=&videoid=
//   GET  /api/live?id=
//   GET  /api/previous_live?id=
//   GET  /api/fetch_active?page=
//   GET  /api/active?key=shivuu
//   GET  /api/batches
//   GET  /api/player?url=          ← stream proxy
//   GET  /private.json
//   GET  /tokens.json              ← blocked
// ============================================================================

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
const PAGE_SIZE = 40;
const PROXY_PATH = "/api/player";

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
// MAIN ROUTER
// ============================================================================

export async function onRequest(context) {
    const { request } = context;
    const url = new URL(request.url);
    const pathname = url.pathname;

    if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: STREAM_HEADERS });
    }

    if (pathname.includes("/_private") || pathname.includes("/_lib")) {
        return jsonResponse({ status: 404, message: "Not found", data: [] }, 404);
    }

    if (pathname === "/api/player" || pathname === "/sex/api/player") return handlePlayer(request, url);
    if (pathname === "/api/subjects" || pathname === "/sex/api/subjects") return handleSubjects(request);
    if (pathname === "/api/topics" || pathname === "/sex/api/topics") return handleTopics(request);
    if (pathname === "/api/classes" || pathname === "/sex/api/classes") return handleClasses(request);
    if (pathname === "/api/video" || pathname === "/sex/api/video") return handleVideo(request);
    if (pathname === "/api/live" || pathname === "/sex/api/live") return handleLive(request);
    if (pathname === "/api/previous_live" || pathname === "/sex/api/previous_live") return handlePreviousLive(request);
    if (pathname === "/api/fetch_active" || pathname === "/sex/api/fetch_active") return handleFetchActive(request);
    if (pathname === "/api/active" || pathname === "/sex/api/active") return handleActive(request);
    if (pathname === "/api/batches" || pathname === "/sex/api/batches") return handleBatches(request);

    if (pathname === "/private.json" || pathname === "/sex/private.json") {
        return new Response(JSON.stringify(TOKEN_STORE), {
            status: 200,
            headers: {
                "Content-Type": "application/json; charset=UTF-8",
                "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
                "Pragma": "no-cache",
                "Access-Control-Allow-Origin": "*"
            }
        });
    }

    if (pathname === "/tokens.json" || pathname === "/sex/tokens.json") {
        return jsonResponse({ status: 404, message: "Not found", data: [] }, 404);
    }

    return jsonResponse({ status: 404, message: "Not found", data: [] }, 404);
}

// ============================================================================
// HELPERS
// ============================================================================

function jsonResponse(payload, status = 200) {
    return new Response(JSON.stringify(payload, null, 4), { status, headers: JSON_HEADERS });
}

function getParam(request, name, defaultValue = "") {
    const url = new URL(request.url);
    const value = url.searchParams.get(name);
    if (value === null || value === undefined) return defaultValue;
    return String(value).trim();
}

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

function base64ToUint8Array(base64) {
    try {
        if (typeof base64 !== "string") return null;
        let normalized = base64.replace(/-/g, "+").replace(/_/g, "/");
        while (normalized.length % 4 !== 0) normalized += "=";
        const binary = atob(normalized);
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
        const cryptoKey = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-CBC" }, false, ["decrypt"]);
        const decrypted = await crypto.subtle.decrypt({ name: "AES-CBC", iv: ivBytes }, cryptoKey, cipherBytes);
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

function buildUpstreamHeaders(account) {
    return {
        "Accept": "*/*",
        "Auth-Key": "appxapi",
        "Authorization": account.token,
        "Client-Service": "Appx",
        "Device-Type": "",
        "Is-Safari": "0",
        "Source": "website",
        "User-Id": account.userId
    };
}

// ============================================================================
// ROUTE HANDLERS
// ============================================================================

async function handleSubjects(request) {
    try {
        const courseId = getParam(request, "id");
        if (!courseId) return jsonResponse({ status: 400, error: "Missing course ID.", data: [] }, 400);
        const account = findMatchingBatch(TOKEN_STORE.data, courseId);
        if (!account) return jsonResponse({ status: 404, error: "No matching batch found.", courseId, data: [] }, 404);
        const url = new URL(SUBJECT_API);
        url.searchParams.set("courseid", courseId);
        url.searchParams.set("start", "-1");
        const response = await fetch(url.toString(), { method: "GET", headers: buildUpstreamHeaders(account), cache: "no-store" });
        if (!response.ok) throw new Error(`Subject API returned HTTP ${response.status}`);
        const json = await response.json();
        return jsonResponse({ status: 200, courseId, data: Array.isArray(json.data) ? json.data : (json.data ?? []) });
    } catch (error) {
        return jsonResponse({ status: 500, error: error?.message || "Internal Server Error.", data: [] }, 500);
    }
}

async function handleTopics(request) {
    try {
        const courseId = getParam(request, "id");
        const subjectId = getParam(request, "subjectid");
        if (!courseId) return jsonResponse({ status: 400, error: "Missing course ID.", data: [] }, 400);
        if (!subjectId) return jsonResponse({ status: 400, error: "Missing subject ID.", courseId, data: [] }, 400);
        const account = findMatchingBatch(TOKEN_STORE.data, courseId);
        if (!account) return jsonResponse({ status: 404, error: "No matching batch found.", courseId, subjectId, data: [] }, 404);
        const url = new URL(TOPICS_API);
        url.searchParams.set("courseid", courseId);
        url.searchParams.set("subjectid", subjectId);
        url.searchParams.set("start", "-1");
        const response = await fetch(url.toString(), { method: "GET", headers: buildUpstreamHeaders(account), cache: "no-store" });
        if (!response.ok) throw new Error(`Topics API returned HTTP ${response.status}`);
        const json = await response.json();
        return jsonResponse({ status: 200, courseId, subjectId, data: Array.isArray(json.data) ? json.data : (json.data ?? []) });
    } catch (error) {
        return jsonResponse({ status: 500, error: error?.message || "Internal Server Error.", data: [] }, 500);
    }
}

async function handleClasses(request) {
    try {
        const courseId = getParam(request, "id");
        const subjectId = getParam(request, "subjectid");
        const conceptId = getParam(request, "conceptid");
        const topicId = getParam(request, "topicid", DEFAULT_TOPIC_ID) || DEFAULT_TOPIC_ID;
        if (!courseId) return jsonResponse({ status: 400, error: "Missing course ID.", data: [] }, 400);
        if (!subjectId) return jsonResponse({ status: 400, error: "Missing subject ID.", courseId, data: [] }, 400);
        const account = findMatchingBatch(TOKEN_STORE.data, courseId);
        if (!account) return jsonResponse({ status: 404, error: "No matching batch found.", courseId, subjectId, data: [] }, 404);
        const url = new URL(CLASSES_API);
        url.searchParams.set("courseid", courseId);
        url.searchParams.set("subjectid", subjectId);
        url.searchParams.set("topicid", topicId);
        url.searchParams.set("conceptid", conceptId);
        url.searchParams.set("windowsapp", "false");
        url.searchParams.set("start", "0");
        const response = await fetch(url.toString(), { method: "GET", headers: buildUpstreamHeaders(account), cache: "no-store" });
        if (!response.ok) throw new Error(`Classes API returned HTTP ${response.status}`);
        const json = await response.json();
        const decoded = await decryptObject(json);
        return jsonResponse({ status: 200, courseId, subjectId, topicId, conceptId, data: Array.isArray(decoded.data) ? decoded.data : (decoded.data ?? []) });
    } catch (error) {
        return jsonResponse({ status: 500, error: error?.message || "Internal Server Error.", data: [] }, 500);
    }
}

async function handleVideo(request) {
    try {
        const courseId = getParam(request, "id");
        const videoId = getParam(request, "videoid");
        const ytFlag = getParam(request, "ytflag", "0");
        if (!courseId) return jsonResponse({ status: 400, error: "Missing course ID.", data: [] }, 400);
        if (!videoId) return jsonResponse({ status: 400, error: "Missing video ID.", courseId, data: [] }, 400);
        const account = findMatchingBatch(TOKEN_STORE.data, courseId);
        if (!account) return jsonResponse({ status: 404, error: "No matching batch found.", courseId, videoId, data: [] }, 404);
        const url = new URL(VIDEO_API);
        url.searchParams.set("course_id", courseId);
        url.searchParams.set("video_id", videoId);
        url.searchParams.set("ytflag", ytFlag);
        url.searchParams.set("folder_wise_course", "0");
        url.searchParams.set("lc_app_api_url", "");
        const response = await fetch(url.toString(), { method: "GET", headers: buildUpstreamHeaders(account), cache: "no-store" });
        if (!response.ok) throw new Error(`Video API returned HTTP ${response.status}`);
        const json = await response.json();
        const decoded = await decryptObject(json);
        return jsonResponse({ status: 200, courseId, videoId, ytflag: ytFlag, data: Array.isArray(decoded.data) ? decoded.data : (decoded.data ?? []) });
    } catch (error) {
        return jsonResponse({ status: 500, error: error?.message || "Internal Server Error.", data: [] }, 500);
    }
}

async function handleLive(request) {
    try {
        const courseId = getParam(request, "id");
        if (!courseId) return jsonResponse({ status: 400, error: "Missing course ID.", data: [] }, 400);
        const account = findMatchingBatch(TOKEN_STORE.data, courseId);
        if (!account) return jsonResponse({ status: 404, error: "No matching batch found.", courseId, data: [] }, 404);
        const url = new URL(LIVE_API);
        url.searchParams.set("courseid", courseId);
        url.searchParams.set("start", "-1");
        const response = await fetch(url.toString(), { method: "GET", headers: buildUpstreamHeaders(account), cache: "no-store" });
        if (!response.ok) throw new Error(`Live API returned HTTP ${response.status}`);
        const json = await response.json();
        const decoded = await decryptObject(json);
        return jsonResponse({ status: 200, courseId, data: Array.isArray(decoded.data) ? decoded.data : (decoded.data ?? []) });
    } catch (error) {
        return jsonResponse({ status: 500, error: error?.message || "Internal Server Error.", data: [] }, 500);
    }
}

async function handlePreviousLive(request) {
    try {
        const courseId = getParam(request, "id") || getParam(request, "course_id");
        if (!courseId) return jsonResponse({ status: 400, error: "Missing course ID.", data: [] }, 400);
        const account = findMatchingBatch(TOKEN_STORE.data, courseId);
        if (!account) return jsonResponse({ status: 404, error: "No matching batch found.", courseId, data: [] }, 404);
        const url = new URL(PREVIOUS_LIVE_API);
        url.searchParams.set("course_id", courseId);
        url.searchParams.set("start", "0");
        url.searchParams.set("folder_wise_course", "0");
        url.searchParams.set("userid", account.userId);
        const response = await fetch(url.toString(), { method: "GET", headers: buildUpstreamHeaders(account), cache: "no-store" });
        if (!response.ok) throw new Error(`Previous Live API returned HTTP ${response.status}`);
        const json = await response.json();
        const decoded = await decryptObject(json);
        return jsonResponse(decoded);
    } catch (error) {
        return jsonResponse({ status: 500, error: error?.message || "Internal Server Error.", data: [] }, 500);
    }
}

async function handleFetchActive(request) {
    const url = new URL(request.url);
    let page = Number(url.searchParams.get("page") || "1");
    if (!Number.isFinite(page) || page < 1) page = 1;
    page = Math.floor(page);

    try {
        const list = Array.isArray(TOKEN_STORE.data) ? TOKEN_STORE.data : [];
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
            return jsonResponse({ status: 200, message: "No more pages.", page, pageSize: PAGE_SIZE, totalPages, hasNextPage: false, nextUrl: null, data: [] });
        }

        const startIndex = (page - 1) * PAGE_SIZE;
        const endIndex = Math.min(startIndex + PAGE_SIZE, totalAccounts);
        const pageAccounts = accounts.slice(startIndex, endIndex);

        const results = [];
        for (const account of pageAccounts) {
            const apiUrl = `${COURSE_API}?userid=${encodeURIComponent(account.userId)}`;
            try {
                const response = await fetch(apiUrl, {
                    method: "GET",
                    headers: {
                        "accept": "*/*",
                        "auth-key": "appxapi",
                        "authorization": account.token,
                        "client-service": "Appx",
                        "device-type": "is-safari 0",
                        "origin": "https://sachinacademy.classx.co.in",
                        "referer": "https://sachinacademy.classx.co.in/",
                        "source": "website",
                        "user-agent": "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36",
                        "user-id": String(account.userId)
                    },
                    cache: "no-store"
                });
                if (!response.ok) {
                    results.push({ success: false, userId: account.userId, token: account.token, courses: [], error: `HTTP ${response.status}` });
                    continue;
                }
                const json = await response.json();
                if (json && Array.isArray(json.data)) {
                    results.push({ success: true, userId: account.userId, token: account.token, courses: json.data });
                } else {
                    results.push({ success: false, userId: account.userId, token: account.token, courses: [], error: "No data[]" });
                }
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
        const nextUrl = hasNextPage ? `${url.origin}/api/fetch_active?page=${page + 1}` : null;

        return jsonResponse({
            status: 200, page, pageSize: PAGE_SIZE, totalPages, hasNextPage, nextUrl,
            pagination: { page, pageSize: PAGE_SIZE, totalPages, hasNextPage, nextUrl },
            stats: {
                rawEntries: list.length,
                validEntries: accounts.length,
                duplicatesRemoved: list.length - accounts.length,
                activeAccounts: built.activeAccounts,
                failedAccounts: built.failedAccounts,
                totalCoursesBeforeDedup: built.totalCoursesBeforeDedup,
                uniqueCourses: built.courses.length
            },
            data: built.courses
        });
    } catch (error) {
        return jsonResponse({ status: 500, error: error?.message || "Internal Server Error", data: [] }, 500);
    }
}

async function handleActive(request) {
    const url = new URL(request.url);
    const suppliedKey = url.searchParams.get("key");
    if (!suppliedKey || !ADMIN_KEYS.has(suppliedKey)) {
        return jsonResponse({ status: 401, error: "Unauthorized Access" }, 401);
    }

    try {
        const batchMap = new Map();
        const visitedUrls = new Set();
        const pages = [];
        const errors = [];
        let totalPagesFetched = 0, totalBatchesReceived = 0, duplicateBatchesRemoved = 0;
        let nextUrl = `${url.origin}/api/fetch_active?page=1`;

        while (nextUrl && totalPagesFetched < MAX_PAGES) {
            if (visitedUrls.has(nextUrl)) {
                errors.push({ url: nextUrl, error: "Pagination loop detected." });
                break;
            }
            visitedUrls.add(nextUrl);

            let json;
            try {
                const response = await fetch(nextUrl, { method: "GET", headers: { "Accept": "application/json" }, cache: "no-store" });
                if (!response.ok) throw new Error(`fetch_active HTTP ${response.status}`);
                json = await response.json();
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
                try { nextUrl = new URL(candidateNextUrl, url.origin).toString(); }
                catch { errors.push({ url: candidateNextUrl, error: "Invalid nextUrl." }); break; }
            } else nextUrl = null;
        }

        const data = Array.from(batchMap.values());
        return jsonResponse({
            status: 200,
            message: `Fetched ${data.length} unique batches from ${totalPagesFetched} pages.`,
            pagination: {
                pagesFetched: totalPagesFetched,
                maxPages: MAX_PAGES,
                complete: !nextUrl,
                stoppedByMaxPages: Boolean(nextUrl && totalPagesFetched >= MAX_PAGES),
                remainingNextUrl: nextUrl || null
            },
            stats: { batchesReceivedAcrossPages: totalBatchesReceived, uniqueBatches: data.length, duplicateBatchesRemoved },
            pages, errors, data
        });
    } catch (error) {
        return jsonResponse({ status: 500, error: error?.message || "Internal Server Error", data: [] }, 500);
    }
}

async function handleBatches(request) {
    try {
        const url = new URL(request.url);
        const activeUrl = `${url.origin}/api/active?key=${ACTIVE_KEY}`;
        const response = await fetch(activeUrl, { method: "GET", headers: { "Accept": "application/json" }, cache: "no-store" });
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
        return jsonResponse({ status: 200, message: `Fetched ${data.length} unique batches.`, count: data.length, data });
    } catch (error) {
        return jsonResponse({ status: 500, error: error?.message || "Internal Server Error.", data: [] }, 500);
    }
}

// ============================================================================
// PLAYER — STREAM PROXY
// ============================================================================

async function handlePlayer(request, url) {
    const targetUrl = extractTargetUrl(request, url);

    if (!targetUrl) {
        return jsonResponse({
            status: 400,
            error: "Invalid URL",
            message: "Could not parse the 'url' query parameter.",
            received: url.searchParams.get("url") || "(missing)",
            hint: "Use /api/player?url=" + encodeURIComponent("https://example.com/video.mp4")
        }, 400);
    }

    const proxyHeaders = new Headers();
    proxyHeaders.set("Origin", TARGET_ORIGIN);
    proxyHeaders.set("Referer", TARGET_ORIGIN + "/");
    proxyHeaders.set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36");
    proxyHeaders.set("Accept", "*/*");
    proxyHeaders.set("Accept-Language", "en-US,en;q=0.9");

    const range = request.headers.get("range");
    const ifRange = request.headers.get("if-range");
    const ifNoneMatch = request.headers.get("if-none-match");
    const ifModifiedSince = request.headers.get("if-modified-since");
    if (range) proxyHeaders.set("Range", range);
    if (ifRange) proxyHeaders.set("If-Range", ifRange);
    if (ifNoneMatch) proxyHeaders.set("If-None-Match", ifNoneMatch);
    if (ifModifiedSince) proxyHeaders.set("If-Modified-Since", ifModifiedSince);

    let response;
    try {
        response = await fetch(targetUrl, {
            method: request.method === "HEAD" ? "HEAD" : "GET",
            headers: proxyHeaders,
            redirect: "follow"
        });
    } catch (err) {
        return jsonResponse({ status: 502, error: `Upstream fetch failed: ${err.message}`, data: [] }, 502);
    }

    const responseHeaders = new Headers();
    const passthrough = ["content-type", "content-length", "content-encoding", "cache-control", "etag", "last-modified", "accept-ranges", "content-range", "vary", "expires"];
    for (const h of passthrough) {
        const v = response.headers.get(h);
        if (v) responseHeaders.set(h, v);
    }
    responseHeaders.set("Access-Control-Allow-Origin", "*");
    responseHeaders.set("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges, Content-Type");
    if (!responseHeaders.has("accept-ranges")) responseHeaders.set("Accept-Ranges", "bytes");

    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    const lowerTarget = targetUrl.toLowerCase();
    const isM3U8 = contentType.includes("mpegurl")
        || contentType.includes("application/x-mpegurl")
        || contentType.includes("vnd.apple.mpegurl")
        || lowerTarget.includes(".m3u8")
        || lowerTarget.includes(".m3u");

    if (isM3U8) {
        let manifest;
        try {
            manifest = await response.text();
        } catch (err) {
            return jsonResponse({ status: 502, error: `Manifest read error: ${err.message}`, data: [] }, 502);
        }

        const clean = manifest.replace(/^\uFEFF/, "").trimStart();
        if (!clean.startsWith("#EXTM3U")) {
            responseHeaders.delete("content-length");
            responseHeaders.set("Content-Type", "text/plain; charset=UTF-8");
            return new Response(manifest, { status: response.status, headers: responseHeaders });
        }

        const rewritten = rewriteM3U8(manifest, targetUrl, url.origin);
        responseHeaders.delete("content-length");
        responseHeaders.set("Content-Type", "application/vnd.apple.mpegurl");
        responseHeaders.set("Cache-Control", "no-cache");
        return new Response(rewritten, { status: response.status, headers: responseHeaders });
    }

    if (request.method === "HEAD" || !response.body) {
        return new Response(null, { status: response.status, headers: responseHeaders });
    }

    return new Response(response.body, { status: response.status, headers: responseHeaders });
}

function rewriteM3U8(manifest, baseUrl, proxyOrigin) {
    const proxyBase = `${proxyOrigin}${PROXY_PATH}`;

    return manifest.split("\n").map((line) => {
        const raw = line;
        const trimmed = line.trim();
        if (!trimmed) return raw;

        if (trimmed.startsWith("#")) {
            return raw.replace(/URI="([^"]+)"/g, (_, uri) => {
                let absolute;
                try { absolute = new URL(uri, baseUrl).href; }
                catch { return `URI="${uri}"`; }
                return `URI="${proxyBase}?url=${encodeURIComponent(absolute)}"`;
            });
        }

        let absolute;
        try { absolute = new URL(trimmed, baseUrl).href; }
        catch { return raw; }

        if (absolute.startsWith(proxyBase)) return raw;
        return `${proxyBase}?url=${encodeURIComponent(absolute)}`;
    }).join("\n");
}

function extractTargetUrl(request, url) {
    let candidate = url.searchParams.get("url");

    if (!candidate) {
        const rawQuery = url.search.startsWith("?") ? url.search.slice(1) : url.search;
        const idx = rawQuery.indexOf("url=");
        if (idx !== -1) candidate = rawQuery.slice(idx + 4);
    }

    if (!candidate) return null;
    candidate = String(candidate).trim();

    for (let i = 0; i < 6; i++) {
        const before = candidate;

        try {
            const dec = decodeURIComponent(candidate);
            if (dec !== candidate) candidate = dec;
        } catch { /* not encoded */ }

        if (candidate.startsWith("/") || candidate.startsWith("http://") || candidate.startsWith("https://")) {
            try {
                const parsed = new URL(candidate, url.origin);
                if (parsed.pathname === PROXY_PATH) {
                    const inner = parsed.searchParams.get("url");
                    if (inner && inner !== candidate) {
                        candidate = inner;
                        continue;
                    }
                }
                if ((parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.host !== url.host) {
                    return parsed.href;
                }
            } catch { /* fall through */ }
        }

        try {
            const direct = new URL(candidate);
            if (direct.protocol === "http:" || direct.protocol === "https:") return direct.href;
        } catch { /* keep looping */ }

        if (candidate.startsWith("//")) {
            try { return new URL("https:" + candidate).href; } catch { /* keep looping */ }
        }

        if (before === candidate) break;
    }

    return null;
}
