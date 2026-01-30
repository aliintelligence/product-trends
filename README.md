# Product Trends Dashboard

A simple web app to research trending products across TikTok and Instagram for dropshipping.

## Quick Start

```bash
npm install
npm start
```

Open http://localhost:3000

## Setup

1. Get an API key from [scrapecreators.com](https://scrapecreators.com) ($10 for 5,000 credits)
2. Click ⚙️ Settings in the app
3. Paste your API key and click Save

## Features

- **TikTok Search** - Search videos by keyword
- **TikTok Shop** - Find products with prices and sales data
- **Instagram Reels** - Search trending reels

## Deploy to Railway

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new)

1. Push to GitHub
2. Connect Railway to your repo
3. Deploy!

## Deploy to Render

1. Push to GitHub
2. Create new Web Service on [render.com](https://render.com)
3. Connect your repo
4. Set build command: `npm install`
5. Set start command: `npm start`

## Project Structure

```
product-trends/
├── server.js        # Express API server
├── public/
│   └── index.html   # Frontend (single file)
├── config.json      # API key storage (gitignored)
└── package.json
```

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| GET /api/tiktok/search?q=keyword | Search TikTok videos |
| GET /api/tiktok/shop?q=keyword | Search TikTok Shop products |
| GET /api/instagram/reels?q=keyword | Search Instagram reels |
| GET /api/config | Get config |
| POST /api/config | Save API key |
