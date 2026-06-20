
# MixVibe Mirror API

**Domain:** [xtaiirus.onrender.com](https://xtaiirus.onrender.com)

Zero-dependency Node.js mirror of MixVibe education API with persistent storage.

## Live Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/batches` | All batches |
| GET | `/api/batchdetails?batchId=` | Subjects |
| GET | `/api/live?batchId=` | Live classes |
| GET | `/api/topics?batchId=&subjectId=` | Topics |
| GET | `/api/content?batchId=&subjectId=&topicId=&contentType=` | Content |
| GET | `/api/stats` | Statistics |
| POST | `/api/extract` | Trigger extraction |
| GET | `/api/health` | Health check |

## Quick Start

```bash
# Trigger extraction
curl -X POST https://xtaiirus.onrender.com/api/extract

# Get data
curl https://xtaiirus.onrender.com/api/batches
