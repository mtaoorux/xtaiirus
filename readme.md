# Sachin Academy Video API Server

A Node.js/Express server that fetches video details from Sachin Academy API (`https://sachinacademyapi.classx.co.in/`) using bearer tokens from `mtaiirus.vercel.app`.

## Features

- ✅ Fetches bearer tokens from `mtaiirus.vercel.app/apv/tokenbyxyro-mtaiirus.json`
- ✅ Uses tokens to authenticate with Sachin Academy API
- ✅ Saves all API responses as JSON files with course/video IDs in filename
- ✅ RESTful API endpoints for fetching video details
- ✅ Token status checking
- ✅ Response management (list, view saved responses)
- ✅ Course-specific response grouping

## Installation

```bash
npm install
