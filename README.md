# MixVibe Mirror API Server

A zero‑dependency Node.js backend that extracts course data from MixVibe and serves it as a drop‑in replacement API.

## Live Deployment

The server is running at **[https://xtaiirus.onrender.com](https://xtaiirus.onrender.com)**.

- Admin page: [https://xtaiirus.onrender.com/admin](https://xtaiirus.onrender.com/admin)
- API: `https://xtaiirus.onrender.com/api/batches` etc.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/batches` | All batches |
| GET | `/api/batchdetails?batchId=` | Subjects for a batch |
| GET | `/api/live?batchId=` | Live classes |
| GET | `/api/topics?batchId=&subjectId=` | Topics |
| GET | `/api/content?batchId=&subjectId=&topicId=&contentType=` | Videos/notes/DPP |
| GET | `/api/stats` | Extraction progress |
| POST | `/api/extract` | Start incremental extraction |

## Running Locally

```bash
node server.js
