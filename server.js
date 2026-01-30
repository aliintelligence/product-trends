const express = require('express');
const axios = require('axios');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public'));

// Config file path
const CONFIG_PATH = path.join(__dirname, 'config.json');

// Load/Save config
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    }
  } catch (e) {
    console.error('Config load error:', e.message);
  }
  return {};
}

function saveConfig(data) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2));
}

// Logging middleware
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} | ${req.method} ${req.path}`);
  next();
});

// ================== API ROUTES ==================

// Get/Save config
app.get('/api/config', (req, res) => {
  const config = loadConfig();
  res.json({
    hasKey: !!config.apiKey,
    apiKey: config.apiKey || ''
  });
});

app.post('/api/config', (req, res) => {
  const config = loadConfig();
  config.apiKey = req.body.apiKey;
  saveConfig(config);
  console.log('✅ API key saved');
  res.json({ success: true });
});

// ScrapeCreators API helper
async function scrapecreators(endpoint, params = {}) {
  const config = loadConfig();
  if (!config.apiKey) {
    throw new Error('API key not set. Click Settings to add your key.');
  }

  console.log(`🔄 API: ${endpoint}`);

  const url = `https://api.scrapecreators.com${endpoint}`;
  const response = await axios.get(url, {
    headers: { 'x-api-key': config.apiKey },
    params,
    timeout: 30000
  });

  console.log(`✅ Got response, credits: ${response.data.credits_remaining}`);
  return response.data;
}

// TikTok Search
app.get('/api/tiktok/search', async (req, res) => {
  try {
    const { q } = req.query;
    const data = await scrapecreators('/v1/tiktok/search/keyword', { query: q });
    res.json({ success: true, data });
  } catch (e) {
    console.error('❌', e.message);
    res.json({ success: false, error: e.message });
  }
});

// TikTok Top/Trending
app.get('/api/tiktok/top', async (req, res) => {
  try {
    const q = req.query.q || 'viral';
    const data = await scrapecreators('/v1/tiktok/search/top', { query: q });
    res.json({ success: true, data });
  } catch (e) {
    console.error('❌', e.message);
    res.json({ success: false, error: e.message });
  }
});

// TikTok Shop
app.get('/api/tiktok/shop', async (req, res) => {
  try {
    const { q } = req.query;
    const data = await scrapecreators('/v1/tiktok/shop/search', { query: q });
    res.json({ success: true, data });
  } catch (e) {
    console.error('❌', e.message);
    res.json({ success: false, error: e.message });
  }
});

// Instagram Reels
app.get('/api/instagram/reels', async (req, res) => {
  try {
    const { q } = req.query;
    const data = await scrapecreators('/v1/instagram/reels/search', { query: q });
    res.json({ success: true, data });
  } catch (e) {
    console.error('❌', e.message);
    res.json({ success: false, error: e.message });
  }
});

// Test API
app.get('/api/test', async (req, res) => {
  try {
    const data = await scrapecreators('/v1/tiktok/search/top', { query: 'test' });
    res.json({ success: true, credits: data.credits_remaining });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`
┌─────────────────────────────────────────┐
│   Product Trends Dashboard              │
│   http://localhost:${PORT}                 │
└─────────────────────────────────────────┘
  `);
});
