# Brainbox Institute API v2

## Deployed on Render

### API Endpoints

Base URL: `https://your-service-name.onrender.com`

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/` | API Documentation |
| GET | `/health` | Health Check |
| GET | `/api/batches` | Get all batches |
| GET | `/api/batches/:id` | Get specific batch |
| GET | `/api/batches/:batchId/contents` | Get contents for a batch |
| GET | `/api/batches/:batchId/live` | Get live session for a batch |
| GET | `/api/courses` | Get all courses |
| GET | `/api/courses/:id` | Get specific course |
| GET | `/api/courses/:courseId/batches` | Get batches for a course |
| GET | `/api/contents` | Get all contents |
| GET | `/api/contents/:id` | Get specific content |
| GET | `/api/media` | Get all media |
| GET | `/api/media/:id` | Get specific media |
| GET | `/api/live` | Get all live sessions |
| GET | `/api/live/:id` | Get specific live session |
| GET | `/api/live-token/:batchId` | Get live token for batch |
| GET | `/api/search?q=query` | Search across all content |
| GET | `/api/stats` | Get system statistics |
| GET | `/api/export/:type` | Export data by type |

### Environment Variables

Set these in Render dashboard:

- `TOKEN` - Your Brainbox API token (required)
- `BASE_URL` - Brainbox API base URL (default: https://nt.brainboxinstitute.in)
- `CORS_ORIGIN` - CORS allowed origins (default: *)
- `RATE_LIMIT_WINDOW` - Rate limit window in minutes (default: 15)
- `RATE_LIMIT_MAX` - Max requests per window (default: 100)

### Deployment Steps

1. Fork this repository
2. Create a new Web Service on Render
3. Connect your GitHub repository
4. Set environment variables (especially TOKEN)
5. Deploy!

The build process will automatically extract and process data from Brainbox API.

### Local Development

```bash
# Install dependencies
npm install

# Set up environment variables
cp .env.example .env
# Edit .env with your TOKEN

# Extract data
npm run extract

# Process data
npm run process

# Start server
npm start

# Test API
npm test
