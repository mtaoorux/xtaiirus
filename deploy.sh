#!/bin/bash
# deploy.sh - One-click deployment

echo "🚀 Deploying Brainbox API..."

# Install dependencies
npm install

# Start the server (auto-setup will run automatically)
npm start
