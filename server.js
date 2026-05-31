const express = require('express');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const OpenAI = require('openai');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const googleTrends = require('google-trends-api');
const { ApifyClient } = require('apify-client');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;

// Persistent state directory. Locally = repo dir; in production set DATA_DIR to a
// mounted volume (e.g. Railway /data) so JSON state survives redeploys.
const DATA_DIR = process.env.DATA_DIR || __dirname;
try { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { /* fs not ready */ }

// ================== AUTOPILOT SYSTEM ==================

const AUTOPILOT_PATH = path.join(DATA_DIR, 'autopilot_state.json');
const AUTOPILOT_LOGS_PATH = path.join(DATA_DIR, 'autopilot_logs.json');

// Autopilot default settings
const DEFAULT_AUTOPILOT_SETTINGS = {
  enabled: false,
  minAiScore: 75,
  maxDailyProducts: 5,
  autoGenerateImages: false,
  autoGenerateVideos: false,
  autoPost: false,
  autoPushToShopify: true,
  autoFindSupplier: true,
  scheduleInterval: '0 */6 * * *', // Every 6 hours
  notifyEmail: '',
  niches: ['tech gadgets', 'skincare', 'home', 'pets', 'cute'],
  lastRun: null,
  todayProductCount: 0,
  lastResetDate: null
};

function loadAutopilotState() {
  try {
    if (fs.existsSync(AUTOPILOT_PATH)) {
      return { ...DEFAULT_AUTOPILOT_SETTINGS, ...JSON.parse(fs.readFileSync(AUTOPILOT_PATH, 'utf8')) };
    }
  } catch (e) {
    console.error('Autopilot state load error:', e.message);
  }
  return { ...DEFAULT_AUTOPILOT_SETTINGS };
}

function saveAutopilotState(state) {
  fs.writeFileSync(AUTOPILOT_PATH, JSON.stringify(state, null, 2));
}

function loadAutopilotLogs() {
  try {
    if (fs.existsSync(AUTOPILOT_LOGS_PATH)) {
      return JSON.parse(fs.readFileSync(AUTOPILOT_LOGS_PATH, 'utf8'));
    }
  } catch (e) {
    console.error('Autopilot logs load error:', e.message);
  }
  return { runs: [], totalProductsProcessed: 0, totalPushed: 0 };
}

function saveAutopilotLogs(logs) {
  fs.writeFileSync(AUTOPILOT_LOGS_PATH, JSON.stringify(logs, null, 2));
}

function logAutopilotRun(runData) {
  const logs = loadAutopilotLogs();
  logs.runs.unshift({
    timestamp: new Date().toISOString(),
    ...runData
  });
  // Keep last 100 runs
  logs.runs = logs.runs.slice(0, 100);
  logs.totalProductsProcessed += runData.productsFound || 0;
  logs.totalPushed += runData.productsPushed || 0;
  saveAutopilotLogs(logs);
}

// Cron job reference
let autopilotCronJob = null;

// ================== MACHINE LEARNING & MEMORY SYSTEM ==================

const HISTORY_PATH = path.join(DATA_DIR, 'product_history.json');
const MEMORY_PATH = path.join(DATA_DIR, 'product_memory.json');

// Initialize or load product history
function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_PATH)) {
      return JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
    }
  } catch (e) {
    console.error('History load error:', e.message);
  }
  return {
    sessions: [],
    totalRecommendations: 0,
    firstSession: null,
    lastSession: null
  };
}

function saveHistory(history) {
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2));
}

// Initialize or load product memory (learned preferences)
function loadMemory() {
  try {
    if (fs.existsSync(MEMORY_PATH)) {
      return JSON.parse(fs.readFileSync(MEMORY_PATH, 'utf8'));
    }
  } catch (e) {
    console.error('Memory load error:', e.message);
  }
  return {
    // Product tracking - how often each product appears
    productFrequency: {},      // { productHash: { count, lastSeen, firstSeen, avgScore } }

    // Category preferences learned from user interactions
    categoryScores: {},        // { category: { views, deepAnalyzes, score } }

    // Price range preferences
    pricePreferences: {
      min: 10,
      max: 50,
      sweetSpot: 25,
      interactions: []
    },

    // Products user showed interest in (deep analyzed)
    interestedProducts: [],    // [{ title, category, price, analyzedAt }]

    // Trending patterns over time
    trendingPatterns: {},      // { keyword: [{ date, score }] }

    // Price history tracking - NEW
    priceHistory: {},          // { productHash: [{ date, price, source, change }] }

    // Supplier price cache - NEW
    supplierPriceCache: {},    // { productHash: { prices: [], lastUpdated, source } }

    // Competitor analysis cache - NEW
    competitorCache: {},       // { productHash: { amazonPresent, sellerCount, lastChecked } }

    // Learning stats
    learningStats: {
      totalInteractions: 0,
      lastUpdated: null,
      modelVersion: '2.0'
    }
  };
}

function saveMemory(memory) {
  memory.learningStats.lastUpdated = new Date().toISOString();
  fs.writeFileSync(MEMORY_PATH, JSON.stringify(memory, null, 2));
}

// Generate a hash for product identification
function hashProduct(product) {
  const str = (product.title || '').toLowerCase().replace(/[^a-z0-9]/g, '').substring(0, 50);
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return 'p_' + Math.abs(hash).toString(16);
}

// Record a recommendation session
function recordSession(products, niches) {
  const history = loadHistory();
  const memory = loadMemory();
  const sessionId = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
  const timestamp = new Date().toISOString();

  // Create session record
  const session = {
    id: sessionId,
    timestamp,
    date: timestamp.split('T')[0],
    productCount: products.length,
    niches: niches.map(n => n.category),
    topProducts: products.slice(0, 5).map(p => ({
      title: p.title,
      price: p.price,
      score: p.aiScore,
      category: p.category,
      hash: hashProduct(p)
    })),
    avgScore: products.length > 0
      ? Math.round(products.reduce((sum, p) => sum + (p.aiScore || 0), 0) / products.length)
      : 0
  };

  // Update history
  history.sessions.unshift(session);
  if (history.sessions.length > 100) history.sessions.pop(); // Keep last 100 sessions
  history.totalRecommendations += products.length;
  if (!history.firstSession) history.firstSession = timestamp;
  history.lastSession = timestamp;

  // Update memory with product frequency
  products.forEach(p => {
    const hash = hashProduct(p);
    if (!memory.productFrequency[hash]) {
      memory.productFrequency[hash] = {
        title: p.title,
        count: 0,
        scores: [],
        firstSeen: timestamp,
        lastSeen: timestamp,
        category: p.category
      };
    }
    const pf = memory.productFrequency[hash];
    pf.count++;
    pf.scores.push(p.aiScore || 0);
    pf.lastSeen = timestamp;
    pf.avgScore = Math.round(pf.scores.reduce((a, b) => a + b, 0) / pf.scores.length);

    // Update category scores
    const cat = p.category || 'unknown';
    if (!memory.categoryScores[cat]) {
      memory.categoryScores[cat] = { views: 0, deepAnalyzes: 0, score: 50 };
    }
    memory.categoryScores[cat].views++;
  });

  saveHistory(history);
  saveMemory(memory);

  return { sessionId, timestamp };
}

// Record when user shows interest (deep analyze)
function recordInterest(product) {
  const memory = loadMemory();
  const timestamp = new Date().toISOString();

  // Add to interested products
  memory.interestedProducts.unshift({
    title: product.title,
    category: product.category,
    price: product.price,
    hash: hashProduct(product),
    analyzedAt: timestamp
  });
  if (memory.interestedProducts.length > 50) memory.interestedProducts.pop();

  // Boost category score
  const cat = product.category || 'unknown';
  if (!memory.categoryScores[cat]) {
    memory.categoryScores[cat] = { views: 0, deepAnalyzes: 0, score: 50 };
  }
  memory.categoryScores[cat].deepAnalyzes++;
  memory.categoryScores[cat].score = Math.min(100, memory.categoryScores[cat].score + 5);

  // Update price preferences
  if (product.price) {
    memory.pricePreferences.interactions.push(product.price);
    if (memory.pricePreferences.interactions.length > 20) {
      memory.pricePreferences.interactions.shift();
    }
    // Calculate new sweet spot
    const prices = memory.pricePreferences.interactions;
    memory.pricePreferences.sweetSpot = Math.round(
      prices.reduce((a, b) => a + b, 0) / prices.length
    );
    memory.pricePreferences.min = Math.min(...prices) * 0.8;
    memory.pricePreferences.max = Math.max(...prices) * 1.2;
  }

  memory.learningStats.totalInteractions++;
  saveMemory(memory);
}

// Get learning-enhanced scores for products
function applyLearnedScores(products) {
  const memory = loadMemory();
  const history = loadHistory();

  return products.map(p => {
    let learningBonus = 0;
    const insights = [];
    const hash = hashProduct(p);

    // 1. Check if product appeared before (returning product)
    const productHistory = memory.productFrequency[hash];
    if (productHistory) {
      if (productHistory.count >= 3) {
        learningBonus += 10;
        insights.push(`🔄 Seen ${productHistory.count}x (consistently trending)`);
      }
      if (productHistory.avgScore >= 75) {
        learningBonus += 5;
        insights.push(`📈 Historically high-scoring (avg: ${productHistory.avgScore})`);
      }
      p.returningProduct = true;
      p.timesAppeared = productHistory.count;
      p.historicalAvgScore = productHistory.avgScore;
    } else {
      p.returningProduct = false;
      p.isNew = true;
      insights.push('✨ New product (first time seen)');
    }

    // 2. Category preference bonus
    const catScore = memory.categoryScores[p.category];
    if (catScore && catScore.deepAnalyzes > 0) {
      learningBonus += Math.min(15, catScore.deepAnalyzes * 3);
      insights.push(`💡 Category you've shown interest in`);
    }

    // 3. Price sweet spot bonus
    const priceDiff = Math.abs(p.price - memory.pricePreferences.sweetSpot);
    if (priceDiff < 10) {
      learningBonus += 5;
      insights.push(`💰 In your preferred price range`);
    }

    // 4. Compare to previous sessions
    if (history.sessions.length > 1) {
      const prevSession = history.sessions[1];
      const wasInPrevious = prevSession.topProducts.some(tp => tp.hash === hash);
      if (wasInPrevious) {
        learningBonus += 5;
        insights.push(`📊 Also recommended in previous session`);
        p.consistentRecommendation = true;
      }
    }

    return {
      ...p,
      learningBonus,
      learningInsights: insights,
      adjustedScore: Math.min(100, (p.aiScore || 0) + learningBonus)
    };
  });
}

// ================== PRICE HISTORY TRACKING ==================

// Record price for a product
function recordPrice(product) {
  const memory = loadMemory();
  const hash = hashProduct(product);

  if (!memory.priceHistory) memory.priceHistory = {};
  if (!memory.priceHistory[hash]) memory.priceHistory[hash] = [];

  const history = memory.priceHistory[hash];
  const lastPrice = history[0]?.price;
  const now = new Date().toISOString();

  // Only record if price changed or it's been more than 1 hour since last record
  const lastRecordTime = history[0]?.date ? new Date(history[0].date).getTime() : 0;
  const hoursSinceLastRecord = (Date.now() - lastRecordTime) / (1000 * 60 * 60);

  if (hoursSinceLastRecord >= 1 || lastPrice !== product.price) {
    history.unshift({
      date: now,
      price: product.price,
      source: 'tiktok-shop',
      change: lastPrice ? parseFloat(((product.price - lastPrice) / lastPrice * 100).toFixed(1)) : 0
    });

    // Keep last 30 price points per product
    if (history.length > 30) history.pop();

    saveMemory(memory);
  }
}

// Get price history for a product
function getPriceHistory(productHash) {
  const memory = loadMemory();
  return memory.priceHistory?.[productHash] || [];
}

// Get price trend analysis
function getPriceTrend(productHash) {
  const history = getPriceHistory(productHash);

  if (history.length < 2) {
    return { trend: 'unknown', change: 0, dataPoints: history.length };
  }

  const recent = history[0].price;
  const oldest = history[history.length - 1].price;
  const change = parseFloat(((recent - oldest) / oldest * 100).toFixed(1));

  const prices = history.map(h => h.price);
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  const avgPrice = parseFloat((prices.reduce((sum, p) => sum + p, 0) / prices.length).toFixed(2));

  // Calculate volatility (standard deviation)
  const variance = prices.reduce((sum, p) => sum + Math.pow(p - avgPrice, 2), 0) / prices.length;
  const volatility = parseFloat(Math.sqrt(variance).toFixed(2));

  return {
    trend: change > 5 ? 'increasing' : change < -5 ? 'decreasing' : 'stable',
    change: change,
    dataPoints: history.length,
    minPrice: minPrice,
    maxPrice: maxPrice,
    avgPrice: avgPrice,
    volatility: volatility,
    priceRange: parseFloat((maxPrice - minPrice).toFixed(2)),
    firstSeen: history[history.length - 1]?.date,
    lastSeen: history[0]?.date,
    // Price alerts
    isAtLowest: recent === minPrice,
    isAtHighest: recent === maxPrice,
    percentFromLowest: parseFloat(((recent - minPrice) / minPrice * 100).toFixed(1)),
    percentFromHighest: parseFloat(((maxPrice - recent) / maxPrice * 100).toFixed(1))
  };
}

// Batch record prices for multiple products
function recordPrices(products) {
  products.forEach(product => {
    if (product.price > 0) {
      recordPrice(product);
    }
  });
}

// Get comparison with previous recommendations
function getHistoricalComparison(currentProducts) {
  const history = loadHistory();
  const memory = loadMemory();

  if (history.sessions.length === 0) {
    return {
      isFirstSession: true,
      comparison: null
    };
  }

  const currentHashes = new Set(currentProducts.map(p => hashProduct(p)));
  const previousSessions = history.sessions.slice(0, 5);

  // Find returning products
  const returningProducts = [];
  const newProducts = [];

  currentProducts.forEach(p => {
    const hash = hashProduct(p);
    const pf = memory.productFrequency[hash];
    if (pf && pf.count > 1) {
      returningProducts.push({
        title: p.title,
        timesAppeared: pf.count,
        avgScore: pf.avgScore,
        trend: p.aiScore > pf.avgScore ? 'improving' : p.aiScore < pf.avgScore ? 'declining' : 'stable'
      });
    } else {
      newProducts.push({ title: p.title, score: p.aiScore });
    }
  });

  // Calculate session comparison
  const prevSession = history.sessions[0];
  const prevAvgScore = prevSession?.avgScore || 0;
  const currentAvgScore = currentProducts.length > 0
    ? Math.round(currentProducts.reduce((sum, p) => sum + (p.aiScore || 0), 0) / currentProducts.length)
    : 0;

  return {
    isFirstSession: false,
    totalSessions: history.sessions.length,
    comparison: {
      previousSession: {
        date: prevSession?.date,
        avgScore: prevAvgScore,
        productCount: prevSession?.productCount
      },
      currentSession: {
        avgScore: currentAvgScore,
        productCount: currentProducts.length
      },
      scoreDelta: currentAvgScore - prevAvgScore,
      trend: currentAvgScore > prevAvgScore ? 'improving' : currentAvgScore < prevAvgScore ? 'declining' : 'stable'
    },
    returningProducts,
    newProducts,
    learningStats: {
      totalProductsTracked: Object.keys(memory.productFrequency).length,
      totalInteractions: memory.learningStats.totalInteractions,
      topCategories: Object.entries(memory.categoryScores)
        .sort((a, b) => b[1].score - a[1].score)
        .slice(0, 3)
        .map(([cat, data]) => ({ category: cat, score: data.score }))
    }
  };
}

// ================== GOOGLE TRENDS VALIDATION ==================

// Cache for Google Trends data (avoid rate limiting)
const trendsCache = new Map();
const TRENDS_CACHE_TTL = 1000 * 60 * 30; // 30 minutes

// Check if a keyword is trending on Google
async function checkGoogleTrend(keyword) {
  // Check cache first
  const cacheKey = keyword.toLowerCase().trim();
  const cached = trendsCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < TRENDS_CACHE_TTL) {
    return cached.data;
  }

  try {
    // Get interest over time for the past 3 months
    const results = await googleTrends.interestOverTime({
      keyword: keyword,
      startTime: new Date(Date.now() - (90 * 24 * 60 * 60 * 1000)), // 90 days ago
      geo: 'US'
    });

    // Check if response is valid JSON
    if (!results || results.startsWith('<') || results.startsWith('L')) {
      throw new Error('Google returned HTML instead of JSON (rate limited)');
    }

    const data = JSON.parse(results);
    const timeline = data.default?.timelineData || [];

    if (timeline.length < 2) {
      return { trending: false, direction: 'unknown', score: 50, data: [], source: 'google-trends' };
    }

    // Calculate trend direction
    const values = timeline.map(t => t.value[0]);
    const recentAvg = values.slice(-4).reduce((a, b) => a + b, 0) / 4; // Last 4 weeks
    const olderAvg = values.slice(0, 4).reduce((a, b) => a + b, 0) / 4; // First 4 weeks

    let direction = 'stable';
    let trendScore = 50;

    if (recentAvg > olderAvg * 1.2) {
      direction = 'rising';
      trendScore = Math.min(100, 60 + (recentAvg - olderAvg));
    } else if (recentAvg < olderAvg * 0.8) {
      direction = 'declining';
      trendScore = Math.max(0, 40 - (olderAvg - recentAvg));
    }

    const result = {
      trending: direction === 'rising',
      direction: direction,
      score: Math.round(trendScore),
      currentInterest: Math.round(recentAvg),
      previousInterest: Math.round(olderAvg),
      percentChange: Math.round(((recentAvg - olderAvg) / (olderAvg || 1)) * 100),
      data: values.slice(-12), // Last 12 data points
      source: 'google-trends'
    };

    // Cache the result
    trendsCache.set(cacheKey, { data: result, timestamp: Date.now() });

    return result;
  } catch (error) {
    console.error(`   ⚠️ Google Trends error for "${keyword}": ${error.message}`);

    // Use fallback trend estimation based on known winning niches
    const fallbackResult = estimateTrendFromNiche(keyword);
    trendsCache.set(cacheKey, { data: fallbackResult, timestamp: Date.now() });
    return fallbackResult;
  }
}

// Fallback trend estimation when Google Trends is rate-limited
function estimateTrendFromNiche(keyword) {
  const kw = keyword.toLowerCase();

  // Known trending categories based on industry data
  const trendingKeywords = [
    'led', 'light', 'rgb', 'glow',
    'wireless', 'bluetooth', 'smart',
    'portable', 'mini', 'compact',
    'skincare', 'beauty', 'makeup',
    'fitness', 'workout', 'gym',
    'organizer', 'storage'
  ];

  const decliningKeywords = [
    'fidget', 'spinner', 'slime'
  ];

  const hasTrending = trendingKeywords.some(t => kw.includes(t));
  const hasDeclining = decliningKeywords.some(d => kw.includes(d));

  if (hasDeclining) {
    return { trending: false, direction: 'declining', score: 30, source: 'fallback-estimate' };
  } else if (hasTrending) {
    return { trending: true, direction: 'rising', score: 70, source: 'fallback-estimate' };
  } else {
    return { trending: false, direction: 'stable', score: 50, source: 'fallback-estimate' };
  }
}

// Batch check trends for multiple keywords (with rate limiting)
async function batchCheckTrends(keywords) {
  const results = {};
  const uniqueKeywords = [...new Set(keywords.map(k => k.toLowerCase().trim()))];

  console.log(`\n📈 Checking Google Trends for ${uniqueKeywords.length} keywords...`);

  for (const keyword of uniqueKeywords.slice(0, 5)) { // Limit to 5 to avoid rate limiting
    try {
      results[keyword] = await checkGoogleTrend(keyword);
      console.log(`   ${results[keyword].direction === 'rising' ? '🔥' : results[keyword].direction === 'declining' ? '📉' : '➡️'} "${keyword}": ${results[keyword].direction} (${results[keyword].percentChange || 0}%)`);

      // Small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 500));
    } catch (e) {
      results[keyword] = { trending: false, direction: 'unknown', score: 50 };
    }
  }

  return results;
}

app.use(express.json({ limit: '5mb' }));
app.use(express.static('public'));

// Config file path
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

// Map config keys to env var names. In production these come from Railway env vars
// (env wins over file) and are never written back to disk.
const ENV_CONFIG_MAP = {
  openaiKey: 'OPENAI_KEY',
  geminiKey: 'GEMINI_KEY',
  apifyKey: 'APIFY_KEY',
  shopifyClientId: 'SHOPIFY_CLIENT_ID',
  shopifyClientSecret: 'SHOPIFY_CLIENT_SECRET',
  cjApiKey: 'CJ_API_KEY',
  shopifyWebhookSecret: 'SHOPIFY_WEBHOOK_SECRET',
  encryptionKey: 'ENCRYPTION_KEY',
  alertWebhookUrl: 'ALERT_WEBHOOK_URL',
  metaAdsToken: 'META_ADS_TOKEN',
  metaAdAccountId: 'META_AD_ACCOUNT_ID'
};

// Load/Save config
function loadConfig() {
  let fileConfig = {};
  try {
    if (fs.existsSync(CONFIG_PATH)) fileConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    console.error('Config load error:', e.message);
  }
  // Env vars override file values (production secrets live in env, not on disk)
  for (const [key, envName] of Object.entries(ENV_CONFIG_MAP)) {
    if (process.env[envName]) fileConfig[key] = process.env[envName];
  }
  return fileConfig;
}

function saveConfig(data) {
  // Never persist secrets that are supplied via env — keep them out of the file
  const toSave = { ...data };
  for (const [key, envName] of Object.entries(ENV_CONFIG_MAP)) {
    if (process.env[envName]) delete toSave[key];
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(toSave, null, 2));
}

// ================== STORE MANAGEMENT SYSTEM ==================

const STORES_PATH = path.join(DATA_DIR, 'stores.json');

// Load stores data
function loadStores() {
  try {
    if (fs.existsSync(STORES_PATH)) {
      return JSON.parse(fs.readFileSync(STORES_PATH, 'utf8'));
    }
  } catch (e) {
    console.error('Stores load error:', e.message);
  }
  return {
    stores: {},
    meta: {
      version: '1.0',
      createdAt: new Date().toISOString(),
      lastUpdated: new Date().toISOString()
    }
  };
}

// Save stores data
function saveStores(stores) {
  stores.meta.lastUpdated = new Date().toISOString();
  fs.writeFileSync(STORES_PATH, JSON.stringify(stores, null, 2));
}

// Generate unique store ID
function generateStoreId(nicheId) {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substr(2, 5);
  return `store_${nicheId}_${timestamp}${random}`;
}

// Create a new store
function createStore(nicheId, name, nicheData = {}) {
  const stores = loadStores();
  const storeId = generateStoreId(nicheId);

  stores.stores[storeId] = {
    id: storeId,
    name: name,
    nicheId: nicheId,
    nicheIcon: nicheData.icon || '📦',
    nicheName: nicheData.name || nicheId,
    storeIdea: nicheData.storeIdea || 'General Store',
    status: 'draft', // draft | connected | active
    shopify: null,   // Will hold Shopify connection data
    collections: {
      main: {
        id: 'main',
        name: 'All Products',
        products: []
      }
    },
    products: {},    // { productHash: { addedAt, customPrice, status, shopifyId } }
    productCount: 0,
    settings: {
      defaultMarkup: 200,  // 200% = 2x price
      currency: 'USD',
      autoPublish: false
    },
    stats: {
      totalViews: 0,
      totalAnalyses: 0,
      lastActivity: new Date().toISOString()
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  saveStores(stores);
  return stores.stores[storeId];
}

// Get a store by ID
function getStore(storeId) {
  const stores = loadStores();
  return stores.stores[storeId] || null;
}

// Update a store
function updateStore(storeId, updates) {
  const stores = loadStores();
  if (!stores.stores[storeId]) return null;

  stores.stores[storeId] = {
    ...stores.stores[storeId],
    ...updates,
    updatedAt: new Date().toISOString()
  };

  saveStores(stores);
  return stores.stores[storeId];
}

// Delete a store
function deleteStore(storeId) {
  const stores = loadStores();
  if (!stores.stores[storeId]) return false;

  delete stores.stores[storeId];
  saveStores(stores);
  return true;
}

// Add product to store
function addProductToStore(storeId, product, collectionId = 'main') {
  const stores = loadStores();
  const store = stores.stores[storeId];
  if (!store) return null;

  const productHash = hashProduct(product);

  // Add to products map if not exists
  if (!store.products[productHash]) {
    store.products[productHash] = {
      hash: productHash,
      title: product.title,
      image: product.image,
      originalPrice: product.price,
      customPrice: null,
      category: product.category,
      aiScore: product.aiScore,
      status: 'curated', // curated | published | archived
      shopifyProductId: null,
      addedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
  }

  // Add to collection if not already there
  if (!store.collections[collectionId]) {
    store.collections[collectionId] = {
      id: collectionId,
      name: collectionId,
      products: []
    };
  }

  if (!store.collections[collectionId].products.includes(productHash)) {
    store.collections[collectionId].products.push(productHash);
  }

  // Update product count
  store.productCount = Object.keys(store.products).length;
  store.updatedAt = new Date().toISOString();
  store.stats.lastActivity = new Date().toISOString();

  saveStores(stores);
  return store.products[productHash];
}

// Remove product from store
function removeProductFromStore(storeId, productHash) {
  const stores = loadStores();
  const store = stores.stores[storeId];
  if (!store) return false;

  // Remove from products map
  delete store.products[productHash];

  // Remove from all collections
  Object.keys(store.collections).forEach(colId => {
    store.collections[colId].products = store.collections[colId].products.filter(h => h !== productHash);
  });

  // Update product count
  store.productCount = Object.keys(store.products).length;
  store.updatedAt = new Date().toISOString();

  saveStores(stores);
  return true;
}

// Get all products in a store with full details
function getStoreProducts(storeId) {
  const store = getStore(storeId);
  if (!store) return [];

  const memory = loadMemory();

  return Object.values(store.products).map(p => {
    // Enrich with memory data if available
    const memoryData = memory.productFrequency[p.hash] || {};
    return {
      ...p,
      timesAppeared: memoryData.count || 0,
      avgScore: memoryData.avgScore || p.aiScore
    };
  });
}

// Get stores by niche
function getStoresByNiche(nicheId) {
  const stores = loadStores();
  return Object.values(stores.stores).filter(s => s.nicheId === nicheId);
}

// ================== SHOPIFY OAUTH SYSTEM ==================

// Encryption key management - uses config or generates one
function getEncryptionKey() {
  const config = loadConfig();
  if (!config.encryptionKey) {
    // Generate a new 32-byte key on first use
    config.encryptionKey = crypto.randomBytes(32).toString('hex');
    saveConfig(config);
  }
  return Buffer.from(config.encryptionKey, 'hex');
}

// AES-256-GCM encryption for Shopify tokens
function encryptToken(token) {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  let encrypted = cipher.update(token, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');

  return {
    encrypted,
    iv: iv.toString('hex'),
    authTag
  };
}

function decryptToken(encryptedData) {
  try {
    const key = getEncryptionKey();
    const iv = Buffer.from(encryptedData.iv, 'hex');
    const authTag = Buffer.from(encryptedData.authTag, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encryptedData.encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (e) {
    console.error('Token decryption failed:', e.message);
    return null;
  }
}

// Shopify OAuth configuration
function getShopifyConfig() {
  const config = loadConfig();
  return {
    apiKey: config.shopifyApiKey || '',
    apiSecret: config.shopifyApiSecret || '',
    clientId: config.shopifyClientId || '',
    clientSecret: config.shopifyClientSecret || '',
    scopes: 'write_products,read_products,write_inventory,read_inventory,read_themes,write_themes,read_orders,write_orders',
    hostName: config.shopifyHostName || 'localhost:3000',
    isConfigured: !!(config.shopifyClientId && config.shopifyClientSecret)
  };
}

// ================== CLIENT CREDENTIALS GRANT (New Shopify 2026 Method) ==================

// Token cache - stores access tokens per shop (valid for 24 hours)
const shopifyTokenCache = {};

// Get access token - supports per-store Client ID/Secret or global config
async function getShopifyAccessToken(shop, storeCredentials = null) {
  const cacheKey = shop;
  const cached = shopifyTokenCache[cacheKey];

  // Return cached token if still valid (with 5 min buffer)
  if (cached && cached.expiresAt > Date.now() + 300000) {
    console.log(`🔑 Using cached Shopify token for ${shop}`);
    return cached.accessToken;
  }

  // Get Client ID/Secret - prefer per-store credentials, fall back to global config
  let clientId, clientSecret;

  if (storeCredentials?.clientId && storeCredentials?.clientSecret) {
    // Per-store Client Credentials (for stores with their own Custom App)
    clientId = storeCredentials.clientId;
    clientSecret = storeCredentials.clientSecret;
    console.log(`🔄 Using per-store credentials for ${shop}...`);
  } else {
    // Global config (for stores in same Partners org)
    const config = loadConfig();
    clientId = config.shopifyClientId;
    clientSecret = config.shopifyClientSecret;
    console.log(`🔄 Using global credentials for ${shop}...`);
  }

  if (!clientId || !clientSecret) {
    throw new Error('Shopify Client ID and Secret not configured.');
  }

  console.log(`🔄 Requesting new Shopify access token for ${shop}...`);

  try {
    const response = await axios.post(
      `https://${shop}/admin/oauth/access_token`,
      new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret
      }).toString(),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      }
    );

    // Cache the new token
    shopifyTokenCache[cacheKey] = {
      accessToken: response.data.access_token,
      expiresAt: Date.now() + (response.data.expires_in * 1000),
      scope: response.data.scope
    };

    console.log(`✅ Got new Shopify token for ${shop} (expires in ${response.data.expires_in}s)`);
    return response.data.access_token;
  } catch (e) {
    console.error(`❌ Failed to get Shopify token for ${shop}:`, e.response?.data || e.message);
    throw new Error(e.response?.data?.error_description || 'Failed to authenticate with Shopify');
  }
}

// Helper to get store credentials for API calls
function getStoreCredentials(store) {
  if (store.shopify?.clientId && store.shopify?.clientSecret) {
    return {
      clientId: store.shopify.clientId,
      clientSecret: store.shopify.clientSecret
    };
  }
  return null;
}

// Clear token cache for a shop (used on disconnect)
function clearShopifyTokenCache(shop) {
  delete shopifyTokenCache[shop];
}

// Generate OAuth authorization URL
function generateShopifyAuthUrl(shop, storeId) {
  const shopifyConfig = getShopifyConfig();
  const redirectUri = `http://${shopifyConfig.hostName}/api/shopify/callback`;
  const state = Buffer.from(JSON.stringify({ storeId, timestamp: Date.now() })).toString('base64');

  // Build the OAuth URL
  const authUrl = `https://${shop}/admin/oauth/authorize?` +
    `client_id=${shopifyConfig.apiKey}&` +
    `scope=${shopifyConfig.scopes}&` +
    `redirect_uri=${encodeURIComponent(redirectUri)}&` +
    `state=${state}`;

  return { authUrl, state };
}

// Exchange authorization code for access token
async function exchangeCodeForToken(shop, code) {
  const shopifyConfig = getShopifyConfig();

  try {
    const response = await axios.post(`https://${shop}/admin/oauth/access_token`, {
      client_id: shopifyConfig.apiKey,
      client_secret: shopifyConfig.apiSecret,
      code: code
    });

    return {
      accessToken: response.data.access_token,
      scope: response.data.scope
    };
  } catch (e) {
    console.error('Shopify token exchange failed:', e.response?.data || e.message);
    throw new Error('Failed to exchange authorization code');
  }
}

// Save Shopify credentials to store
function saveShopifyCredentials(storeId, shop, accessToken, scope) {
  const stores = loadStores();
  if (!stores.stores[storeId]) {
    throw new Error('Store not found');
  }

  // Encrypt the access token
  const encryptedToken = encryptToken(accessToken);

  stores.stores[storeId].shopify = {
    shop: shop,
    accessToken: encryptedToken,
    scope: scope,
    connectedAt: new Date().toISOString(),
    status: 'connected'
  };
  stores.stores[storeId].status = 'connected';
  stores.stores[storeId].updatedAt = new Date().toISOString();

  saveStores(stores);
  return stores.stores[storeId];
}

// Get decrypted Shopify credentials for a store
function getShopifyCredentials(storeId) {
  const stores = loadStores();
  const store = stores.stores[storeId];

  if (!store || !store.shopify || !store.shopify.accessToken) {
    return null;
  }

  const accessToken = decryptToken(store.shopify.accessToken);
  if (!accessToken) {
    return null;
  }

  return {
    shop: store.shopify.shop,
    accessToken: accessToken,
    scope: store.shopify.scope,
    connectedAt: store.shopify.connectedAt
  };
}

// Disconnect Shopify from store
function disconnectShopify(storeId) {
  const stores = loadStores();
  if (!stores.stores[storeId]) {
    throw new Error('Store not found');
  }

  stores.stores[storeId].shopify = null;
  stores.stores[storeId].status = 'draft';
  stores.stores[storeId].updatedAt = new Date().toISOString();

  saveStores(stores);
  return stores.stores[storeId];
}

// Validate Shopify connection by making a test API call
async function validateShopifyConnection(storeId) {
  const creds = getShopifyCredentials(storeId);
  if (!creds) {
    return { valid: false, error: 'No credentials found' };
  }

  try {
    const response = await axios.get(`https://${creds.shop}/admin/api/2024-01/shop.json`, {
      headers: {
        'X-Shopify-Access-Token': creds.accessToken
      }
    });

    return {
      valid: true,
      shopName: response.data.shop.name,
      shopDomain: response.data.shop.domain,
      shopEmail: response.data.shop.email
    };
  } catch (e) {
    console.error('Shopify validation failed:', e.response?.data || e.message);
    return { valid: false, error: e.response?.data?.errors || e.message };
  }
}

// Logging middleware
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} | ${req.method} ${req.path}`);
  next();
});

// ================== AI PRODUCT ANALYSIS ==================

// Initialize OpenAI
let openai = null;

function getOpenAI() {
  if (!openai) {
    const config = loadConfig();
    if (config.openaiKey) {
      openai = new OpenAI({ apiKey: config.openaiKey });
    }
  }
  return openai;
}

// Initialize Google Gemini
let genAI = null;

function getGemini() {
  if (!genAI) {
    const config = loadConfig();
    if (config.geminiKey) {
      genAI = new GoogleGenerativeAI(config.geminiKey);
    }
  }
  return genAI;
}

// Initialize Apify Client
let apifyClient = null;

function getApify() {
  if (!apifyClient) {
    const config = loadConfig();
    if (config.apifyKey) {
      apifyClient = new ApifyClient({ token: config.apifyKey });
    }
  }
  return apifyClient;
}

// Reset Apify client (called when key changes)
function resetApify() {
  apifyClient = null;
}

// ================== WINNING PRODUCT CRITERIA ==================
// Based on research: Products that sell well have these characteristics:
// - Price: $15-50 (impulse buy sweet spot)
// - Visual: Can be demonstrated in 15-30 sec video
// - Problem-solving: Clear benefit or "wow" factor
// - Lightweight: Easy/cheap to ship
// - Not oversaturated: Still has room for new sellers

// HIGH-CONVERTING NICHES - Proven winners for dropshipping
// Prioritized by: visual appeal, demonstrability, impulse buy potential
const WINNING_NICHES = [
  // Tier 1: Highest conversion (visual + problem-solving)
  { query: 'LED strip lights room', weight: 10, tags: ['visual', 'home', 'impulse'] },
  { query: 'posture corrector', weight: 10, tags: ['health', 'problem-solving'] },
  { query: 'portable blender', weight: 9, tags: ['kitchen', 'convenience'] },
  { query: 'phone camera lens', weight: 9, tags: ['tech', 'creative'] },
  { query: 'car phone holder magnetic', weight: 9, tags: ['car', 'convenience'] },

  // Tier 2: Strong performers
  { query: 'massage gun mini', weight: 8, tags: ['health', 'recovery'] },
  { query: 'ring light selfie', weight: 8, tags: ['beauty', 'content-creator'] },
  { query: 'wireless earbuds', weight: 8, tags: ['tech', 'audio'] },
  { query: 'pet grooming glove', weight: 8, tags: ['pet', 'convenience'] },
  { query: 'makeup organizer', weight: 7, tags: ['beauty', 'organization'] },

  // Tier 3: Trending categories
  { query: 'smart watch fitness', weight: 7, tags: ['tech', 'fitness'] },
  { query: 'hair styling tools', weight: 7, tags: ['beauty', 'styling'] },
  { query: 'desk organizer', weight: 6, tags: ['office', 'organization'] },
  { query: 'cleaning gadgets', weight: 6, tags: ['home', 'convenience'] },
  { query: 'travel accessories', weight: 6, tags: ['travel', 'convenience'] },

  // Tier 4: Seasonal/evergreen
  { query: 'kitchen gadgets', weight: 5, tags: ['kitchen', 'convenience'] },
  { query: 'workout bands resistance', weight: 5, tags: ['fitness', 'home'] },
  { query: 'skincare tools', weight: 5, tags: ['beauty', 'skincare'] },
  { query: 'gaming accessories', weight: 4, tags: ['gaming', 'tech'] },
  { query: 'garden tools', weight: 4, tags: ['outdoor', 'seasonal'] }
];

// Legacy categories for backward compatibility
const TRENDING_CATEGORIES = WINNING_NICHES.map(n => n.query);

// Check if text is primarily English
function isEnglish(text) {
  if (!text) return false;
  // Count English characters vs total characters
  const englishChars = text.match(/[a-zA-Z]/g) || [];
  const totalChars = text.replace(/\s/g, '').length;
  // Require at least 50% English characters
  return totalChars > 0 && (englishChars.length / totalChars) >= 0.5;
}

// ================== PRODUCT SCORING ALGORITHM ==================
// Score products based on dropshipping success criteria

function calculateProductScore(product) {
  let score = 0;
  const breakdown = {};

  // 1. PRICE SCORE (0-25 points)
  // Sweet spot: $15-40 for impulse buys
  const price = product.price || 0;
  if (price >= 15 && price <= 35) {
    breakdown.price = 25;
  } else if (price >= 10 && price <= 50) {
    breakdown.price = 20;
  } else if (price >= 5 && price <= 75) {
    breakdown.price = 12;
  } else if (price > 75 && price <= 100) {
    breakdown.price = 8;
  } else {
    breakdown.price = 3;
  }
  score += breakdown.price;

  // 2. ENGAGEMENT SCORE (0-25 points)
  // Based on customer engagement: reviews + rating quality
  const reviewCount = product.reviewCount || product.likes || 0;
  const rating = product.rating || 0;
  const engagementScore = parseFloat(product.engagement) || 0;

  // Use the pre-calculated engagement score from processShopItem
  if (engagementScore >= 80) {
    breakdown.engagement = 25;
  } else if (engagementScore >= 60) {
    breakdown.engagement = 20;
  } else if (engagementScore >= 40) {
    breakdown.engagement = 15;
  } else if (engagementScore >= 20) {
    breakdown.engagement = 10;
  } else {
    breakdown.engagement = 5;
  }
  score += breakdown.engagement;

  // 3. SALES VELOCITY (0-25 points)
  // Proven demand indicator
  const sold = product.sold || 0;
  if (sold >= 10000) {
    breakdown.sales = 25;
  } else if (sold >= 5000) {
    breakdown.sales = 22;
  } else if (sold >= 1000) {
    breakdown.sales = 18;
  } else if (sold >= 500) {
    breakdown.sales = 14;
  } else if (sold >= 100) {
    breakdown.sales = 10;
  } else if (sold >= 10) {
    breakdown.sales = 6;
  } else {
    breakdown.sales = 3;
  }
  score += breakdown.sales;

  // 4. CATEGORY BONUS (0-15 points)
  // High-visual categories perform better on social media
  const title = (product.title || '').toLowerCase();
  const category = (product.category || '').toLowerCase();
  const combined = title + ' ' + category;

  const highVisualKeywords = [
    'led', 'light', 'glow', 'rgb',           // Visual products
    'beauty', 'makeup', 'skincare', 'hair',   // Beauty (high engagement)
    'gadget', 'tool', 'device',               // Demonstrable products
    'organizer', 'storage', 'holder',         // Problem-solving
    'wireless', 'bluetooth', 'smart',         // Tech appeal
    'mini', 'portable', 'compact'             // Convenience
  ];

  const matchedKeywords = highVisualKeywords.filter(kw => combined.includes(kw));
  breakdown.category = Math.min(15, matchedKeywords.length * 5);
  score += breakdown.category;

  // 5. PROFIT MARGIN POTENTIAL (0-10 points)
  // Products with good margin potential
  const margins = calculateMargins(price);
  const marginPercent = parseFloat(margins.profitMargin);
  if (marginPercent >= 40) {
    breakdown.margin = 10;
  } else if (marginPercent >= 30) {
    breakdown.margin = 7;
  } else if (marginPercent >= 20) {
    breakdown.margin = 4;
  } else {
    breakdown.margin = 1;
  }
  score += breakdown.margin;

  // 6. GOOGLE TRENDS BONUS (-10 to +15 points)
  // Boost products in rising trend categories, penalize declining
  const trendBonus = product.trendBonus || 0;
  breakdown.googleTrends = trendBonus;
  score += trendBonus;

  return {
    totalScore: Math.max(0, Math.min(100, score)),
    breakdown,
    grade: score >= 80 ? 'A' : score >= 65 ? 'B' : score >= 50 ? 'C' : 'D'
  };
}

// Calculate profit margins
function calculateMargins(tiktokPrice) {
  // Typical dropshipping margins
  const supplierPrice = tiktokPrice * 0.3; // Assume 70% markup on supplier price
  const shippingCost = 5; // Average shipping
  const adCost = tiktokPrice * 0.25; // 25% of selling price for ads
  const platformFees = tiktokPrice * 0.15; // 15% platform fees

  const totalCost = supplierPrice + shippingCost + adCost + platformFees;
  const profit = tiktokPrice - totalCost;
  const profitMargin = (profit / tiktokPrice) * 100;

  return {
    sellingPrice: tiktokPrice,
    supplierPrice: supplierPrice.toFixed(2),
    shippingCost: shippingCost.toFixed(2),
    adCost: adCost.toFixed(2),
    platformFees: platformFees.toFixed(2),
    totalCost: totalCost.toFixed(2),
    profit: profit.toFixed(2),
    profitMargin: profitMargin.toFixed(1)
  };
}

// Get basic sourcing recommendations (fallback)
function getSourcingRecommendations(productName) {
  return [
    {
      supplier: 'AliExpress',
      url: `https://www.aliexpress.com/wholesale?SearchText=${encodeURIComponent(productName)}`,
      avgPrice: 'Low',
      shippingTime: '15-30 days',
      reliability: 'Medium'
    },
    {
      supplier: 'CJ Dropshipping',
      url: `https://cjdropshipping.com/search?keyword=${encodeURIComponent(productName)}`,
      avgPrice: 'Medium',
      shippingTime: '7-15 days',
      reliability: 'High'
    },
    {
      supplier: 'Spocket',
      url: `https://www.spocket.co/search/${encodeURIComponent(productName)}`,
      avgPrice: 'High',
      shippingTime: '2-7 days',
      reliability: 'High'
    }
  ];
}

// ================== AI-POWERED DEEP PRODUCT ANALYSIS ==================

// Generate optimized search queries for finding the exact product
function generateSearchQueries(productTitle) {
  // Extract key product identifiers
  const cleanTitle = productTitle
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Remove common filler words
  const fillerWords = ['the', 'a', 'an', 'for', 'with', 'and', 'or', 'in', 'on', 'to', 'of', 'new', 'hot', 'sale'];
  const keywords = cleanTitle.split(' ').filter(w => !fillerWords.includes(w) && w.length > 2);

  // Generate multiple search variations
  return {
    exact: keywords.slice(0, 5).join(' '),
    broad: keywords.slice(0, 3).join(' '),
    aliexpress: `https://www.aliexpress.com/wholesale?SearchText=${encodeURIComponent(keywords.slice(0, 4).join(' '))}&SortType=total_tranpro_desc`,
    cjdropshipping: `https://cjdropshipping.com/search?keyword=${encodeURIComponent(keywords.slice(0, 4).join(' '))}`,
    alibaba: `https://www.alibaba.com/trade/search?SearchText=${encodeURIComponent(keywords.slice(0, 4).join(' '))}`
  };
}

// Deep AI analysis for a single product - comprehensive sourcing & marketing
async function deepAnalyzeProduct(product) {
  const ai = getOpenAI();

  if (!ai) {
    return {
      success: false,
      error: 'OpenAI API key required for deep analysis',
      basicSourcing: getSourcingRecommendations(product.title)
    };
  }

  try {
    const searchQueries = generateSearchQueries(product.title);

    const prompt = `You are an expert dropshipping consultant. Analyze this product and provide SPECIFIC, ACTIONABLE recommendations.

PRODUCT DETAILS:
- Title: "${product.title}"
- TikTok Shop Price: $${product.price}
- Units Sold: ${product.sold || 'Unknown'}
- Category: ${product.category || 'General'}
- Engagement: ${product.engagement || 0}%

YOUR TASK: Provide a complete dropshipping blueprint for this product.

Respond in JSON format with these EXACT fields:
{
  "productAnalysis": {
    "isWinner": true/false,
    "confidence": 0-100,
    "whyOrWhyNot": "detailed explanation"
  },
  "exactSearchTerms": {
    "aliexpress": "exact search term to find this product",
    "cjdropshipping": "exact search term",
    "alibaba": "exact search term for bulk"
  },
  "sourcingStrategy": {
    "recommendedSupplier": "AliExpress" | "CJ Dropshipping" | "Alibaba" | "Spocket",
    "whyThisSupplier": "explanation",
    "expectedCost": "$X.XX - $X.XX",
    "expectedShipping": "X-X days",
    "minimumOrderQuantity": "1 or bulk",
    "qualityTips": ["tip1", "tip2"],
    "redFlags": ["what to avoid"]
  },
  "pricingStrategy": {
    "suggestedRetailPrice": "$XX.XX",
    "minimumPrice": "$XX.XX",
    "maximumPrice": "$XX.XX",
    "profitPerUnit": "$XX.XX",
    "breakEvenROAS": "X.X",
    "pricingRationale": "explanation"
  },
  "marketingStrategy": {
    "targetAudience": {
      "demographics": "age, gender, location",
      "interests": ["interest1", "interest2"],
      "painPoints": ["pain1", "pain2"]
    },
    "adCreativeAngles": [
      {
        "hook": "first 3 seconds hook",
        "angle": "emotional/logical/social proof",
        "script": "15-second video script"
      }
    ],
    "bestPlatforms": ["TikTok", "Instagram", "Facebook"],
    "hashtagsToUse": ["#tag1", "#tag2"],
    "influencerStrategy": "micro/macro influencer recommendation"
  },
  "riskAssessment": {
    "overallRisk": "Low" | "Medium" | "High",
    "competitionLevel": "Low" | "Medium" | "High" | "Saturated",
    "shippingRisk": "Low" | "Medium" | "High",
    "returnRisk": "Low" | "Medium" | "High",
    "mitigationStrategies": ["strategy1", "strategy2"]
  },
  "actionPlan": {
    "step1": "specific action",
    "step2": "specific action",
    "step3": "specific action",
    "estimatedLaunchTime": "X days",
    "startingBudget": "$XXX"
  }
}

Be SPECIFIC. Give actual numbers, actual search terms, actual strategies. This person is ready to invest.`;

    const response = await ai.chat.completions.create({
      model: 'gpt-4o', // Use GPT-4 for best analysis
      messages: [
        {
          role: 'system',
          content: 'You are an expert dropshipping consultant with 10+ years experience. Provide specific, actionable advice. Always respond with valid JSON. Be brutally honest about product potential.'
        },
        { role: 'user', content: prompt }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.3, // Lower temp for more consistent, factual responses
      max_tokens: 2000
    });

    const analysis = JSON.parse(response.choices[0].message.content);

    return {
      success: true,
      product: {
        title: product.title,
        price: product.price,
        image: product.image
      },
      searchQueries,
      ...analysis,
      generatedAt: new Date().toISOString(),
      tokensUsed: response.usage?.total_tokens || 0
    };

  } catch (error) {
    console.error('Deep analysis error:', error.message);
    return {
      success: false,
      error: error.message,
      basicSourcing: getSourcingRecommendations(product.title)
    };
  }
}

// Analyze products with AI - Enhanced for dropshipping success
async function analyzeProductsWithAI(products) {
  const ai = getOpenAI();

  // First, apply algorithmic scoring to all products
  const scoredProducts = products.map(p => {
    const scoring = calculateProductScore(p);
    return {
      ...p,
      algorithmScore: scoring.totalScore,
      scoreBreakdown: scoring.breakdown,
      scoreGrade: scoring.grade
    };
  });

  if (!ai) {
    // Return algorithmic analysis without AI enhancement
    console.log('⚠️ No OpenAI key - using algorithmic scoring only');
    return scoredProducts.map(p => ({
      ...p,
      aiScore: p.algorithmScore,
      trend: p.algorithmScore >= 70 ? 'Rising' : 'Stable',
      competition: p.sold > 5000 ? 'High' : p.sold > 1000 ? 'Medium' : 'Low',
      recommendation: generateBasicRecommendation(p),
      analysisSource: 'algorithm'
    }));
  }

  try {
    // Only send top products to AI to save tokens
    const topProducts = scoredProducts
      .sort((a, b) => b.algorithmScore - a.algorithmScore)
      .slice(0, 15);

    const productSummaries = topProducts.map((p, i) =>
      `${i+1}. "${p.title}" | $${p.price} | ${p.sold || 0} sold | Score: ${p.algorithmScore}/100 | Category: ${p.category}`
    ).join('\n');

    const prompt = `You are a dropshipping product analyst. Evaluate these TikTok Shop products for a US/UK Shopify store.

SCORING CRITERIA (be critical, not everything is a winner):
- Viral Potential: Can this be demonstrated in a 15-30 second video? Does it have "wow" factor?
- Market Saturation: Is this product already everywhere on Amazon/AliExpress/Temu?
- Target Audience: Clear demographic? (e.g., "women 25-35 interested in skincare")
- Ad Potential: Would this perform well as a TikTok/Instagram ad?
- Shipping Risk: Is it fragile, oversized, or contains batteries (customs issues)?

PRODUCTS TO ANALYZE:
${productSummaries}

For EACH product, respond with:
{
  "products": [
    {
      "productIndex": 1,
      "viralScore": 0-100 (how likely to go viral on social media),
      "saturation": "low" | "medium" | "high" | "oversaturated",
      "targetAudience": "specific demographic description",
      "adAngle": "the hook/angle for ads",
      "concerns": ["any red flags"],
      "verdict": "STRONG BUY" | "WORTH TESTING" | "RISKY" | "SKIP",
      "whyOrWhyNot": "1-2 sentence explanation"
    }
  ]
}

Be honest and critical. Not every product is a winner. Mark oversaturated products as SKIP.`;

    const response = await ai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'You are an expert dropshipping analyst. Be critical and honest. Your job is to help identify WINNING products and filter out losers. Not everything is a winner. Always respond with valid JSON.'
        },
        { role: 'user', content: prompt }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.5 // Lower temp for more consistent analysis
    });

    const analysis = JSON.parse(response.choices[0].message.content);
    const analysisArray = analysis.products || [];

    // Merge AI analysis with algorithmic scores
    return scoredProducts.map((p, originalIndex) => {
      // Find if this product was analyzed by AI
      const topIndex = topProducts.findIndex(tp => tp.title === p.title);
      const aiData = topIndex >= 0 ? analysisArray.find(a => a.productIndex === topIndex + 1) : null;

      if (aiData) {
        // Combine algorithmic and AI scores
        const combinedScore = Math.round((p.algorithmScore * 0.4) + (aiData.viralScore * 0.6));
        return {
          ...p,
          aiScore: combinedScore,
          viralScore: aiData.viralScore,
          saturation: aiData.saturation,
          targetAudience: aiData.targetAudience,
          adAngle: aiData.adAngle,
          concerns: aiData.concerns || [],
          verdict: aiData.verdict,
          recommendation: aiData.whyOrWhyNot,
          trend: aiData.saturation === 'low' ? 'Rising' : aiData.saturation === 'medium' ? 'Stable' : 'Declining',
          competition: aiData.saturation === 'low' ? 'Low' : aiData.saturation === 'medium' ? 'Medium' : 'High',
          analysisSource: 'ai+algorithm'
        };
      } else {
        // Use algorithmic score only
        return {
          ...p,
          aiScore: p.algorithmScore,
          trend: p.algorithmScore >= 70 ? 'Rising' : 'Stable',
          competition: p.sold > 5000 ? 'High' : p.sold > 1000 ? 'Medium' : 'Low',
          recommendation: generateBasicRecommendation(p),
          verdict: p.algorithmScore >= 75 ? 'WORTH TESTING' : 'RISKY',
          analysisSource: 'algorithm'
        };
      }
    });
  } catch (error) {
    console.error('AI analysis error:', error.message);
    // Fall back to algorithmic scoring
    return scoredProducts.map(p => ({
      ...p,
      aiScore: p.algorithmScore,
      trend: 'Unknown',
      competition: 'Medium',
      recommendation: generateBasicRecommendation(p),
      analysisSource: 'algorithm-fallback',
      error: error.message
    }));
  }
}

// Generate basic recommendation without AI
function generateBasicRecommendation(product) {
  const score = product.algorithmScore || 0;
  const price = product.price || 0;
  const sold = product.sold || 0;

  if (score >= 80 && price >= 15 && price <= 40) {
    return `Strong potential - good price point ($${price}), proven demand (${sold} sold). Test with TikTok ads.`;
  } else if (score >= 65) {
    return `Worth testing - ${sold > 1000 ? 'proven sales' : 'emerging product'}. Focus on creative ad angles.`;
  } else if (price < 10) {
    return `Low price point may hurt margins. Consider bundling or finding higher-value alternatives.`;
  } else if (price > 50) {
    return `Higher price point requires stronger value proposition. May need longer sales cycle.`;
  } else {
    return `Moderate potential. Research competition before investing in ads.`;
  }
}

// ================== API ROUTES ==================

// ================== NICHE MANAGEMENT ==================

// Get all available niches for the frontend selector
const AVAILABLE_NICHES = [
  { id: 'led-lights', name: 'LED Lights & Lighting', icon: '💡', keywords: ['led strip', 'led lights', 'neon lights', 'fairy lights'], storeIdea: 'Home Ambiance Store' },
  { id: 'posture', name: 'Posture & Wellness', icon: '🧘', keywords: ['posture corrector', 'back support', 'ergonomic'], storeIdea: 'Wellness & Health Store' },
  { id: 'portable-blender', name: 'Portable Kitchen', icon: '🥤', keywords: ['portable blender', 'mini blender', 'travel blender'], storeIdea: 'On-The-Go Lifestyle Store' },
  { id: 'massage', name: 'Massage & Recovery', icon: '💆', keywords: ['massage gun', 'muscle massager', 'deep tissue'], storeIdea: 'Recovery & Fitness Store' },
  { id: 'ring-light', name: 'Content Creator Gear', icon: '📸', keywords: ['ring light', 'selfie light', 'video light', 'tripod'], storeIdea: 'Creator Equipment Store' },
  { id: 'earbuds', name: 'Audio & Earbuds', icon: '🎧', keywords: ['wireless earbuds', 'bluetooth earphones', 'headphones'], storeIdea: 'Audio Accessories Store' },
  { id: 'phone-accessories', name: 'Phone Accessories', icon: '📱', keywords: ['phone holder', 'phone case', 'screen protector', 'charger'], storeIdea: 'Mobile Accessories Store' },
  { id: 'skincare', name: 'Skincare & Beauty', icon: '✨', keywords: ['face mask', 'skincare', 'beauty tool', 'facial'], storeIdea: 'Beauty & Glow Store' },
  { id: 'hair-tools', name: 'Hair Styling', icon: '💇', keywords: ['hair straightener', 'curling iron', 'hair dryer', 'hair brush'], storeIdea: 'Hair Care Store' },
  { id: 'fitness', name: 'Fitness & Workout', icon: '💪', keywords: ['resistance bands', 'workout', 'fitness', 'exercise'], storeIdea: 'Home Gym Store' },
  { id: 'pet', name: 'Pet Products', icon: '🐕', keywords: ['pet toy', 'dog toy', 'cat toy', 'pet grooming'], storeIdea: 'Pet Lovers Store' },
  { id: 'car', name: 'Car Accessories', icon: '🚗', keywords: ['car organizer', 'car phone holder', 'car gadget'], storeIdea: 'Auto Accessories Store' },
  { id: 'home-organization', name: 'Home Organization', icon: '🏠', keywords: ['organizer', 'storage', 'closet', 'drawer'], storeIdea: 'Home Organization Store' },
  { id: 'kitchen-gadgets', name: 'Kitchen Gadgets', icon: '🍳', keywords: ['kitchen tool', 'cooking gadget', 'kitchen organizer'], storeIdea: 'Smart Kitchen Store' },
  { id: 'gaming', name: 'Gaming Accessories', icon: '🎮', keywords: ['gaming', 'controller', 'gaming light', 'desk mat'], storeIdea: 'Gaming Gear Store' },
  { id: 'desk-office', name: 'Desk & Office', icon: '🖥️', keywords: ['desk organizer', 'monitor stand', 'cable management'], storeIdea: 'Productive Workspace Store' },
  { id: 'travel', name: 'Travel Essentials', icon: '✈️', keywords: ['travel bag', 'luggage', 'packing', 'travel organizer'], storeIdea: 'Travel Gear Store' },
  { id: 'baby', name: 'Baby & Kids', icon: '👶', keywords: ['baby', 'kids', 'toddler', 'children'], storeIdea: 'Baby Essentials Store' },
  { id: 'outdoor', name: 'Outdoor & Camping', icon: '⛺', keywords: ['camping', 'outdoor', 'hiking', 'flashlight'], storeIdea: 'Adventure Gear Store' },
  { id: 'smart-home', name: 'Smart Home', icon: '🏠', keywords: ['smart', 'wifi', 'bluetooth', 'remote control'], storeIdea: 'Smart Living Store' },
  { id: 'jewelry', name: 'Jewelry & Accessories', icon: '💍', keywords: ['necklace', 'bracelet', 'ring', 'jewelry'], storeIdea: 'Accessories Boutique' },
  { id: 'bags', name: 'Bags & Backpacks', icon: '🎒', keywords: ['backpack', 'bag', 'purse', 'crossbody'], storeIdea: 'Bags & Carry Store' },
];

app.get('/api/niches', (req, res) => {
  res.json({
    success: true,
    niches: AVAILABLE_NICHES,
    count: AVAILABLE_NICHES.length
  });
});

// ================== SMART AUTO-ROUTING ==================

// Match product to best store niche based on keywords
function findBestStoreMatch(product, stores) {
  const productText = `${product.title || ''} ${product.category || ''} ${product.description || ''}`.toLowerCase();

  const matches = [];

  for (const [storeId, store] of Object.entries(stores)) {
    // Skip stores without Shopify connection
    if (!store.shopify?.shop) continue;

    const nicheId = store.nicheId;

    // Find matching niche from AVAILABLE_NICHES
    const nicheConfig = AVAILABLE_NICHES.find(n => n.id === nicheId);

    // Build keyword list from niche config + store niche name
    let keywords = [];
    if (nicheConfig?.keywords) {
      keywords = [...nicheConfig.keywords];
    }
    // Add the niche name itself
    keywords.push(nicheId.replace(/-/g, ' '));
    if (store.nicheName) keywords.push(store.nicheName.toLowerCase());

    // Also add common variations based on store type
    const storeKeywordMap = {
      'gadgets': ['gadget', 'tech', 'electronic', 'device', 'smart', 'wireless', 'bluetooth', 'usb', 'charger', 'phone', 'tablet'],
      'skincare': ['skincare', 'skin care', 'beauty', 'facial', 'face', 'serum', 'moisturizer', 'cream', 'cosmetic', 'makeup', 'glow'],
      'pet-products': ['pet', 'dog', 'cat', 'puppy', 'kitten', 'animal', 'collar', 'leash', 'toy', 'treat', 'grooming'],
      'home-goods': ['home', 'house', 'kitchen', 'bathroom', 'bedroom', 'living', 'organizer', 'storage', 'decor', 'furniture'],
      'cute-stuff': ['cute', 'kawaii', 'adorable', 'plush', 'stuffed', 'cartoon', 'kids', 'fun', 'novelty', 'gift']
    };

    if (storeKeywordMap[nicheId]) {
      keywords = [...keywords, ...storeKeywordMap[nicheId]];
    }

    // Calculate match score
    let score = 0;
    let matchedKeywords = [];

    for (const keyword of keywords) {
      if (productText.includes(keyword.toLowerCase())) {
        score += keyword.length; // Longer keywords get more weight
        matchedKeywords.push(keyword);
      }
    }

    if (score > 0) {
      matches.push({
        storeId,
        storeName: store.name,
        nicheId,
        nicheName: store.nicheName,
        shopifyDomain: store.shopify.shop,
        score,
        matchedKeywords,
        confidence: Math.min(100, Math.round((score / 30) * 100)) // Normalize to 0-100
      });
    }
  }

  // Sort by score descending
  matches.sort((a, b) => b.score - a.score);

  return matches;
}

// Auto-route product to best matching store
app.post('/api/products/auto-route', async (req, res) => {
  try {
    const { product, autoAdd } = req.body;

    if (!product || !product.title) {
      return res.json({ success: false, error: 'Product with title is required' });
    }

    const storesData = loadStores();
    const matches = findBestStoreMatch(product, storesData.stores);

    if (matches.length === 0) {
      return res.json({
        success: false,
        error: 'No matching store found. Connect stores with relevant niches first.',
        suggestion: 'Consider creating a general store or connecting more niche-specific stores.'
      });
    }

    const bestMatch = matches[0];

    // If autoAdd is true, add the product to the best matching store
    if (autoAdd) {
      const store = storesData.stores[bestMatch.storeId];
      const productHash = hashProduct(product);

      // Add product to store
      store.products[productHash] = {
        hash: productHash,
        title: product.title,
        image: product.image,
        originalPrice: product.price || product.originalPrice,
        customPrice: null,
        category: product.category,
        aiScore: product.aiScore || product.score,
        status: 'curated',
        shopifyProductId: null,
        addedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        autoRouted: true,
        routedFrom: bestMatch.matchedKeywords
      };

      // Update collection
      if (!store.collections.main.products.includes(productHash)) {
        store.collections.main.products.push(productHash);
      }

      store.productCount = Object.keys(store.products).length;
      store.updatedAt = new Date().toISOString();
      saveStores(storesData);

      console.log(`🎯 Auto-routed "${product.title.substring(0, 40)}..." to ${store.name} (confidence: ${bestMatch.confidence}%)`);
    }

    res.json({
      success: true,
      bestMatch,
      allMatches: matches.slice(0, 5), // Return top 5 matches
      productAdded: autoAdd || false
    });
  } catch (e) {
    console.error('❌ Auto-route error:', e.message);
    res.json({ success: false, error: e.message });
  }
});

// Get routing suggestions for a product without adding
app.post('/api/products/suggest-store', (req, res) => {
  try {
    const { product } = req.body;

    if (!product || !product.title) {
      return res.json({ success: false, error: 'Product with title is required' });
    }

    const storesData = loadStores();
    const matches = findBestStoreMatch(product, storesData.stores);

    res.json({
      success: true,
      suggestions: matches.slice(0, 5),
      bestMatch: matches[0] || null
    });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ================== ONE-CLICK FULL PIPELINE ==================

// Full pipeline: Analyze → Auto-Route → Add to Store → Push to Shopify → Find Supplier
app.post('/api/pipeline/full', async (req, res) => {
  try {
    const { product, options = {} } = req.body;

    if (!product || !product.title) {
      return res.json({ success: false, error: 'Product with title is required' });
    }

    const results = {
      steps: [],
      success: true,
      product: { ...product }
    };

    // Step 1: Deep Analysis with GPT-4o
    console.log('🔄 Pipeline Step 1: Deep Analysis...');
    try {
      const analysisResult = await deepAnalyzeProduct(product);
      results.steps.push({ step: 'analysis', success: true, data: analysisResult });
      results.analysis = analysisResult;

      // Check if AI recommends skipping this product
      if (analysisResult.verdict === 'SKIP' && !options.forceProcess) {
        results.success = false;
        results.skipped = true;
        results.reason = `AI recommends skipping: ${analysisResult.reasoning?.substring(0, 100)}...`;
        return res.json(results);
      }
    } catch (e) {
      results.steps.push({ step: 'analysis', success: false, error: e.message });
      if (!options.continueOnError) {
        results.success = false;
        return res.json(results);
      }
    }

    // Step 2: Auto-Route to Best Store
    console.log('🔄 Pipeline Step 2: Auto-Routing...');
    const storesData = loadStores();
    const matches = findBestStoreMatch(product, storesData.stores);

    if (matches.length === 0) {
      results.steps.push({ step: 'routing', success: false, error: 'No matching store found' });
      results.success = false;
      return res.json(results);
    }

    const bestMatch = matches[0];
    results.steps.push({ step: 'routing', success: true, data: bestMatch });
    results.store = bestMatch;

    // Step 3: Add Product to Store
    console.log(`🔄 Pipeline Step 3: Adding to ${bestMatch.storeName}...`);
    const store = storesData.stores[bestMatch.storeId];
    const productHash = hashProduct(product);

    store.products[productHash] = {
      hash: productHash,
      title: product.title,
      image: product.image,
      originalPrice: product.price || product.originalPrice,
      customPrice: options.customPrice || null,
      category: product.category,
      aiScore: product.aiScore || product.score,
      status: 'curated',
      shopifyProductId: null,
      addedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      autoRouted: true,
      pipelineProcessed: true,
      analysis: results.analysis
    };

    if (!store.collections.main.products.includes(productHash)) {
      store.collections.main.products.push(productHash);
    }
    store.productCount = Object.keys(store.products).length;
    store.updatedAt = new Date().toISOString();
    saveStores(storesData);

    results.steps.push({ step: 'addToStore', success: true, productHash });
    results.productHash = productHash;

    // Step 4: Push to Shopify (if store is connected and option enabled)
    if (store.shopify?.shop && options.pushToShopify !== false) {
      console.log('🔄 Pipeline Step 4: Pushing to Shopify...');
      try {
        const accessToken = await getShopifyAccessToken(store.shopify.shop, getStoreCredentials(store));
        const price = options.customPrice || product.price || product.originalPrice;
        const compareAtPrice = (price * 1.3).toFixed(2);

        const shopifyProduct = {
          product: {
            title: product.title,
            body_html: results.analysis?.marketingAngles?.[0] || `<p>${product.title}</p><p>Trending product with high demand!</p>`,
            vendor: store.name,
            product_type: product.category || 'General',
            tags: [product.category, 'trending', 'dropship', 'auto-pipeline'].filter(Boolean).join(','),
            variants: [{
              price: price.toFixed(2),
              compare_at_price: compareAtPrice,
              inventory_management: 'shopify',
              inventory_policy: 'continue',
              requires_shipping: true
            }],
            images: product.image ? [{ src: product.image }] : [],
            status: options.publishImmediately ? 'active' : 'draft'
          }
        };

        const shopifyResponse = await axios.post(
          `https://${store.shopify.shop}/admin/api/2024-01/products.json`,
          shopifyProduct,
          { headers: { 'X-Shopify-Access-Token': accessToken, 'Content-Type': 'application/json' } }
        );

        const shopifyProductData = shopifyResponse.data.product;

        // Update local store with Shopify ID
        store.products[productHash].shopifyProductId = shopifyProductData.id;
        store.products[productHash].shopifyStatus = options.publishImmediately ? 'published' : 'draft';
        store.products[productHash].shopifyUrl = `https://${store.shopify.shop}/admin/products/${shopifyProductData.id}`;
        store.products[productHash].lastSynced = new Date().toISOString();
        saveStores(storesData);

        results.steps.push({
          step: 'pushToShopify',
          success: true,
          shopifyProductId: shopifyProductData.id,
          shopifyUrl: `https://${store.shopify.shop}/products/${shopifyProductData.handle}`
        });
        results.shopifyProduct = shopifyProductData;
      } catch (e) {
        results.steps.push({ step: 'pushToShopify', success: false, error: e.message });
        if (!options.continueOnError) {
          results.success = false;
        }
      }
    } else {
      results.steps.push({ step: 'pushToShopify', success: false, skipped: true, reason: 'Store not connected or option disabled' });
    }

    // Step 5: Find CJ Supplier
    if (options.findSupplier !== false) {
      console.log('🔄 Pipeline Step 5: Finding CJ Supplier...');
      try {
        const config = loadConfig();
        if (config.cjApiKey) {
          const cjToken = await getCJAccessToken();
          const searchKeyword = product.title.split(' ').slice(0, 3).join(' ');

          const searchResponse = await axios.get('https://developers.cjdropshipping.com/api2.0/v1/product/list', {
            params: { productNameEn: searchKeyword, pageNum: 1, pageSize: 5 },
            headers: { 'CJ-Access-Token': cjToken }
          });

          if (searchResponse.data.data?.list?.length > 0) {
            const cjProducts = searchResponse.data.data.list;
            const bestSupplier = cjProducts[0];

            results.steps.push({
              step: 'findSupplier',
              success: true,
              supplier: {
                name: bestSupplier.productNameEn,
                price: bestSupplier.sellPrice,
                cjProductId: bestSupplier.pid,
                image: bestSupplier.productImage
              },
              alternativeCount: cjProducts.length - 1
            });
            results.supplier = bestSupplier;

            // Calculate margin
            const sellPrice = product.price || product.originalPrice;
            const costPrice = bestSupplier.sellPrice;
            results.margin = {
              cost: costPrice,
              sell: sellPrice,
              profit: (sellPrice - costPrice - 5).toFixed(2), // $5 estimated shipping
              marginPercent: (((sellPrice - costPrice - 5) / sellPrice) * 100).toFixed(1)
            };
          } else {
            results.steps.push({ step: 'findSupplier', success: false, error: 'No matching CJ products found' });
          }
        } else {
          results.steps.push({ step: 'findSupplier', success: false, skipped: true, reason: 'CJ API not configured' });
        }
      } catch (e) {
        results.steps.push({ step: 'findSupplier', success: false, error: e.message });
      }
    }

    // Summary
    const successfulSteps = results.steps.filter(s => s.success).length;
    const totalSteps = results.steps.length;
    results.summary = `Pipeline completed: ${successfulSteps}/${totalSteps} steps successful`;

    console.log(`✅ Pipeline complete for "${product.title.substring(0, 40)}...": ${results.summary}`);
    res.json(results);
  } catch (e) {
    console.error('❌ Pipeline error:', e.message);
    res.json({ success: false, error: e.message });
  }
});

// Get/Save config
app.get('/api/config', (req, res) => {
  const config = loadConfig();
  res.json({
    hasKey: !!config.apiKey,
    apiKey: config.apiKey || '',
    hasOpenAIKey: !!config.openaiKey,
    openaiKey: config.openaiKey || '',
    hasGeminiKey: !!config.geminiKey,
    geminiKey: config.geminiKey || '',
    hasApifyKey: !!config.apifyKey,
    apifyKey: config.apifyKey || '',
    hasShopifyKey: !!(config.shopifyClientId && config.shopifyClientSecret),
    shopifyClientId: config.shopifyClientId || '',
    shopifyClientSecret: config.shopifyClientSecret || '',
    hasCJKey: !!config.cjApiKey,
    cjApiKey: config.cjApiKey || '',
    hasRunwayKey: !!config.runwayApiKey,
    runwayApiKey: config.runwayApiKey || '',
    hasMetaAdsKey: !!config.metaAdsToken,
    metaAdsToken: config.metaAdsToken || '',
    metaAdAccountId: config.metaAdAccountId || '',
    hasTikTokAdsKey: !!config.tiktokAdsToken,
    tiktokAdsToken: config.tiktokAdsToken || '',
    tiktokAdAccountId: config.tiktokAdAccountId || ''
  });
});

app.post('/api/config', (req, res) => {
  const config = loadConfig();
  if (req.body.apiKey !== undefined) config.apiKey = req.body.apiKey;
  if (req.body.openaiKey !== undefined) {
    config.openaiKey = req.body.openaiKey;
    openai = null; // Reset OpenAI instance
  }
  if (req.body.geminiKey !== undefined) {
    config.geminiKey = req.body.geminiKey;
    genAI = null; // Reset Gemini instance
  }
  if (req.body.apifyKey !== undefined) {
    config.apifyKey = req.body.apifyKey;
    resetApify(); // Reset Apify instance
  }
  if (req.body.shopifyClientId !== undefined) {
    config.shopifyClientId = req.body.shopifyClientId;
  }
  if (req.body.shopifyClientSecret !== undefined) {
    config.shopifyClientSecret = req.body.shopifyClientSecret;
  }
  if (req.body.cjApiKey !== undefined) {
    config.cjApiKey = req.body.cjApiKey;
  }
  if (req.body.runwayApiKey !== undefined) {
    config.runwayApiKey = req.body.runwayApiKey;
  }
  if (req.body.metaAdsToken !== undefined) {
    config.metaAdsToken = req.body.metaAdsToken;
  }
  if (req.body.metaAdAccountId !== undefined) {
    config.metaAdAccountId = req.body.metaAdAccountId;
  }
  if (req.body.tiktokAdsToken !== undefined) {
    config.tiktokAdsToken = req.body.tiktokAdsToken;
  }
  if (req.body.tiktokAdAccountId !== undefined) {
    config.tiktokAdAccountId = req.body.tiktokAdAccountId;
  }
  saveConfig(config);
  console.log('✅ Config saved');
  res.json({ success: true });
});

// ================== STORE API ENDPOINTS ==================

// Get all stores
app.get('/api/stores', (req, res) => {
  try {
    const stores = loadStores();
    const storeList = Object.values(stores.stores).map(store => ({
      id: store.id,
      name: store.name,
      nicheId: store.nicheId,
      nicheIcon: store.nicheIcon,
      nicheName: store.nicheName,
      storeIdea: store.storeIdea,
      status: store.status,
      productCount: store.productCount,
      hasShopify: !!store.shopify,
      createdAt: store.createdAt,
      updatedAt: store.updatedAt
    }));

    res.json({
      success: true,
      stores: storeList,
      count: storeList.length
    });
  } catch (e) {
    console.error('❌ Get stores error:', e.message);
    res.json({ success: false, error: e.message });
  }
});

// Create a new store
app.post('/api/stores', (req, res) => {
  try {
    const { nicheId, name, nicheData } = req.body;

    if (!nicheId || !name) {
      return res.json({ success: false, error: 'nicheId and name are required' });
    }

    const store = createStore(nicheId, name, nicheData || {});
    console.log(`✅ Created store: ${store.name} (${store.id})`);

    res.json({ success: true, store });
  } catch (e) {
    console.error('❌ Create store error:', e.message);
    res.json({ success: false, error: e.message });
  }
});

// Get single store details
app.get('/api/stores/:storeId', (req, res) => {
  try {
    const store = getStore(req.params.storeId);
    if (!store) {
      return res.json({ success: false, error: 'Store not found' });
    }

    // Get enriched product list
    const products = getStoreProducts(req.params.storeId);

    res.json({
      success: true,
      store: {
        ...store,
        productsData: products
      }
    });
  } catch (e) {
    console.error('❌ Get store error:', e.message);
    res.json({ success: false, error: e.message });
  }
});

// Update store
app.put('/api/stores/:storeId', (req, res) => {
  try {
    const { name, settings } = req.body;
    const updates = {};

    if (name) updates.name = name;
    if (settings) updates.settings = { ...getStore(req.params.storeId)?.settings, ...settings };

    const store = updateStore(req.params.storeId, updates);
    if (!store) {
      return res.json({ success: false, error: 'Store not found' });
    }

    console.log(`✅ Updated store: ${store.name}`);
    res.json({ success: true, store });
  } catch (e) {
    console.error('❌ Update store error:', e.message);
    res.json({ success: false, error: e.message });
  }
});

// Delete store
app.delete('/api/stores/:storeId', (req, res) => {
  try {
    const success = deleteStore(req.params.storeId);
    if (!success) {
      return res.json({ success: false, error: 'Store not found' });
    }

    console.log(`✅ Deleted store: ${req.params.storeId}`);
    res.json({ success: true });
  } catch (e) {
    console.error('❌ Delete store error:', e.message);
    res.json({ success: false, error: e.message });
  }
});

// Add product(s) to store
app.post('/api/stores/:storeId/products', (req, res) => {
  try {
    const { product, products, collectionId } = req.body;
    const storeId = req.params.storeId;

    // Handle single product or array
    const productsToAdd = products || (product ? [product] : []);

    if (productsToAdd.length === 0) {
      return res.json({ success: false, error: 'No products provided' });
    }

    const results = productsToAdd.map(p => {
      const added = addProductToStore(storeId, p, collectionId || 'main');
      return added ? { hash: added.hash, title: added.title, success: true } : { title: p.title, success: false };
    });

    const successCount = results.filter(r => r.success).length;
    console.log(`✅ Added ${successCount}/${productsToAdd.length} products to store ${storeId}`);

    res.json({
      success: true,
      added: successCount,
      total: productsToAdd.length,
      results
    });
  } catch (e) {
    console.error('❌ Add products error:', e.message);
    res.json({ success: false, error: e.message });
  }
});

// Remove product from store
app.delete('/api/stores/:storeId/products/:productHash', (req, res) => {
  try {
    const success = removeProductFromStore(req.params.storeId, req.params.productHash);
    if (!success) {
      return res.json({ success: false, error: 'Product or store not found' });
    }

    console.log(`✅ Removed product ${req.params.productHash} from store ${req.params.storeId}`);
    res.json({ success: true });
  } catch (e) {
    console.error('❌ Remove product error:', e.message);
    res.json({ success: false, error: e.message });
  }
});

// Get stores by niche
app.get('/api/stores/niche/:nicheId', (req, res) => {
  try {
    const stores = getStoresByNiche(req.params.nicheId);
    res.json({
      success: true,
      stores,
      count: stores.length
    });
  } catch (e) {
    console.error('❌ Get stores by niche error:', e.message);
    res.json({ success: false, error: e.message });
  }
});

// Create collection in store
app.post('/api/stores/:storeId/collections', (req, res) => {
  try {
    const { name, id } = req.body;
    const stores = loadStores();
    const store = stores.stores[req.params.storeId];

    if (!store) {
      return res.json({ success: false, error: 'Store not found' });
    }

    const collectionId = id || name.toLowerCase().replace(/[^a-z0-9]/g, '-');

    store.collections[collectionId] = {
      id: collectionId,
      name: name,
      products: [],
      createdAt: new Date().toISOString()
    };

    store.updatedAt = new Date().toISOString();
    saveStores(stores);

    console.log(`✅ Created collection: ${name} in store ${store.name}`);
    res.json({ success: true, collection: store.collections[collectionId] });
  } catch (e) {
    console.error('❌ Create collection error:', e.message);
    res.json({ success: false, error: e.message });
  }
});

// ================== SHOPIFY OAUTH ENDPOINTS ==================

// Get Shopify configuration status
app.get('/api/shopify/config', (req, res) => {
  const shopifyConfig = getShopifyConfig();
  res.json({
    success: true,
    isConfigured: shopifyConfig.isConfigured,
    scopes: shopifyConfig.scopes
  });
});

// Save Shopify API credentials
app.post('/api/shopify/config', (req, res) => {
  try {
    const { apiKey, apiSecret, clientId, clientSecret, hostName } = req.body;
    const config = loadConfig();

    // Legacy OAuth keys
    if (apiKey !== undefined) config.shopifyApiKey = apiKey;
    if (apiSecret !== undefined) config.shopifyApiSecret = apiSecret;

    // New Client Credentials keys
    if (clientId !== undefined) config.shopifyClientId = clientId;
    if (clientSecret !== undefined) config.shopifyClientSecret = clientSecret;

    if (hostName !== undefined) config.shopifyHostName = hostName;

    saveConfig(config);

    console.log('✅ Shopify credentials saved');
    res.json({ success: true, isConfigured: !!(config.shopifyClientId && config.shopifyClientSecret) });
  } catch (e) {
    console.error('❌ Shopify config error:', e.message);
    res.json({ success: false, error: e.message });
  }
});

// Start OAuth flow for a store
app.get('/api/stores/:storeId/shopify/auth', (req, res) => {
  try {
    const { shop } = req.query;

    if (!shop) {
      return res.json({ success: false, error: 'Shop domain is required (e.g., mystore.myshopify.com)' });
    }

    // Validate shop domain format
    const shopDomain = shop.includes('.myshopify.com') ? shop : `${shop}.myshopify.com`;

    // Check if Shopify is configured
    const shopifyConfig = getShopifyConfig();
    if (!shopifyConfig.isConfigured) {
      return res.json({
        success: false,
        error: 'Shopify API not configured. Add API key and secret in settings.'
      });
    }

    // Verify store exists
    const stores = loadStores();
    if (!stores.stores[req.params.storeId]) {
      return res.json({ success: false, error: 'Store not found' });
    }

    // Generate OAuth URL
    const { authUrl, state } = generateShopifyAuthUrl(shopDomain, req.params.storeId);

    console.log(`🔐 Starting Shopify OAuth for store: ${req.params.storeId}, shop: ${shopDomain}`);
    res.json({ success: true, authUrl, shop: shopDomain });
  } catch (e) {
    console.error('❌ Shopify auth start error:', e.message);
    res.json({ success: false, error: e.message });
  }
});

// OAuth callback handler
app.get('/api/shopify/callback', async (req, res) => {
  try {
    const { code, shop, state } = req.query;

    if (!code || !shop || !state) {
      return res.status(400).send('Missing required parameters');
    }

    // Decode state to get storeId
    let storeId;
    try {
      const stateData = JSON.parse(Buffer.from(state, 'base64').toString());
      storeId = stateData.storeId;
    } catch (e) {
      return res.status(400).send('Invalid state parameter');
    }

    // Exchange code for access token
    const { accessToken, scope } = await exchangeCodeForToken(shop, code);

    // Save credentials to store
    saveShopifyCredentials(storeId, shop, accessToken, scope);

    console.log(`✅ Shopify connected for store: ${storeId}, shop: ${shop}`);

    // Redirect back to the app with success
    res.redirect(`/?shopify_connected=true&store=${storeId}`);
  } catch (e) {
    console.error('❌ Shopify callback error:', e.message);
    res.redirect(`/?shopify_error=${encodeURIComponent(e.message)}`);
  }
});

// Get Shopify connection status for a store
app.get('/api/stores/:storeId/shopify/status', async (req, res) => {
  try {
    const stores = loadStores();
    const store = stores.stores[req.params.storeId];

    if (!store) {
      return res.json({ success: false, error: 'Store not found' });
    }

    if (!store.shopify || !store.shopify.accessToken) {
      return res.json({
        success: true,
        connected: false,
        shop: null
      });
    }

    // Validate the connection
    const validation = await validateShopifyConnection(req.params.storeId);

    res.json({
      success: true,
      connected: validation.valid,
      shop: store.shopify.shop,
      shopName: validation.shopName,
      shopDomain: validation.shopDomain,
      connectedAt: store.shopify.connectedAt,
      scope: store.shopify.scope,
      error: validation.error
    });
  } catch (e) {
    console.error('❌ Shopify status error:', e.message);
    res.json({ success: false, error: e.message });
  }
});

// Disconnect Shopify from a store
app.post('/api/stores/:storeId/shopify/disconnect', (req, res) => {
  try {
    const store = disconnectShopify(req.params.storeId);
    console.log(`🔌 Shopify disconnected from store: ${req.params.storeId}`);
    res.json({ success: true, store });
  } catch (e) {
    console.error('❌ Shopify disconnect error:', e.message);
    res.json({ success: false, error: e.message });
  }
});

// Connect store to Shopify - supports per-store Client ID/Secret or global config
app.post('/api/stores/:storeId/shopify/connect', async (req, res) => {
  try {
    const { shop, clientId, clientSecret } = req.body;

    if (!shop) {
      return res.json({ success: false, error: 'Shop domain is required' });
    }

    // Normalize shop domain
    const shopDomain = shop.includes('.myshopify.com') ? shop : `${shop}.myshopify.com`;

    // Verify store exists
    const stores = loadStores();
    if (!stores.stores[req.params.storeId]) {
      return res.json({ success: false, error: 'Store not found' });
    }

    let accessToken;
    let storeClientId = clientId;
    let storeClientSecret = clientSecret;

    // Option 1: Per-store Client ID/Secret provided
    if (clientId && clientSecret) {
      console.log(`🔑 Connecting ${shopDomain} with per-store Client Credentials...`);
      try {
        accessToken = await getShopifyAccessToken(shopDomain, { clientId, clientSecret });
      } catch (ccError) {
        return res.json({
          success: false,
          error: `Client Credentials failed: ${ccError.message}. Make sure the app is installed on this store.`
        });
      }
    } else {
      // Option 2: Try global Client Credentials
      const shopifyConfig = getShopifyConfig();
      if (!shopifyConfig.isConfigured) {
        return res.json({
          success: false,
          error: 'Provide Client ID and Client Secret from a Custom App.',
          requiresCredentials: true,
          instructions: {
            step1: 'Go to your Shopify store admin',
            step2: 'Settings → Apps and sales channels → Develop apps',
            step3: 'Create an app → Configure Admin API scopes',
            step4: 'Add scopes: write_products, read_products, write_inventory, read_inventory, read_themes, write_themes, read_orders',
            step5: 'Install the app',
            step6: 'Copy Client ID and Client Secret from API credentials tab'
          }
        });
      }

      try {
        accessToken = await getShopifyAccessToken(shopDomain);
        // Using global credentials - don't store per-store
        storeClientId = null;
        storeClientSecret = null;
      } catch (ccError) {
        return res.json({
          success: false,
          error: 'Global Client Credentials failed. Provide per-store Client ID and Secret.',
          requiresCredentials: true
        });
      }
    }

    // Test the connection
    try {
      const testResponse = await axios.get(`https://${shopDomain}/admin/api/2024-01/shop.json`, {
        headers: { 'X-Shopify-Access-Token': accessToken }
      });

      // Save connection with per-store credentials if provided
      stores.stores[req.params.storeId].shopify = {
        shop: shopDomain,
        connectedAt: new Date().toISOString(),
        status: 'connected',
        authMethod: 'client_credentials',
        // Store per-store credentials if provided
        ...(storeClientId && { clientId: storeClientId }),
        ...(storeClientSecret && { clientSecret: storeClientSecret })
      };
      stores.stores[req.params.storeId].status = 'connected';
      stores.stores[req.params.storeId].updatedAt = new Date().toISOString();
      saveStores(stores);

      console.log(`✅ Shopify connected for store: ${req.params.storeId}, shop: ${shopDomain}`);
      res.json({
        success: true,
        store: stores.stores[req.params.storeId],
        shopInfo: {
          name: testResponse.data.shop.name,
          domain: testResponse.data.shop.domain,
          email: testResponse.data.shop.email
        }
      });
    } catch (apiError) {
      console.error('❌ Shopify API test failed:', apiError.response?.data || apiError.message);
      res.json({
        success: false,
        error: 'Failed to connect. Make sure the credentials are valid and the app is installed with required scopes.'
      });
    }
  } catch (e) {
    console.error('❌ Shopify connect error:', e.message);
    res.json({ success: false, error: e.message });
  }
});

// ================== PUSH TO SHOPIFY ==================

// Push a single product to Shopify
app.post('/api/stores/:storeId/shopify/push', async (req, res) => {
  try {
    const { productHash, customPrice } = req.body;
    const storeId = req.params.storeId;

    // Get store
    const stores = loadStores();
    const store = stores.stores[storeId];
    if (!store) {
      return res.json({ success: false, error: 'Store not found' });
    }

    if (!store.shopify || !store.shopify.shop) {
      return res.json({ success: false, error: 'Shopify not connected' });
    }

    // Get access token (supports Custom App tokens and Client Credentials)
    const accessToken = await getShopifyAccessToken(store.shopify.shop, getStoreCredentials(store));

    // Get product from store
    const product = store.products[productHash];
    if (!product) {
      return res.json({ success: false, error: 'Product not found in store' });
    }

    // Check if already pushed
    if (product.shopifyProductId) {
      return res.json({ success: false, error: 'Product already published to Shopify', shopifyProductId: product.shopifyProductId });
    }

    // Build Shopify product
    const price = customPrice || product.customPrice || product.originalPrice;
    const compareAtPrice = (price * 1.3).toFixed(2); // 30% higher compare price

    const shopifyProduct = {
      product: {
        title: product.title,
        body_html: `<p>${product.title}</p><p>Trending product with high demand!</p>`,
        vendor: store.name,
        product_type: product.category || 'General',
        tags: [product.category, 'trending', 'dropship'].filter(Boolean).join(','),
        variants: [{
          price: price.toFixed(2),
          compare_at_price: compareAtPrice,
          inventory_management: 'shopify',
          inventory_policy: 'continue', // Allow overselling for dropship
          requires_shipping: true
        }],
        images: product.image ? [{ src: product.image }] : [],
        status: 'active'
      }
    };

    // Push to Shopify
    const response = await axios.post(
      `https://${store.shopify.shop}/admin/api/2024-01/products.json`,
      shopifyProduct,
      { headers: { 'X-Shopify-Access-Token': accessToken, 'Content-Type': 'application/json' } }
    );

    const shopifyProductData = response.data.product;

    // Update local store with Shopify ID
    store.products[productHash].shopifyProductId = shopifyProductData.id;
    store.products[productHash].shopifyStatus = 'published';
    store.products[productHash].shopifyUrl = `https://${store.shopify.shop}/admin/products/${shopifyProductData.id}`;
    store.products[productHash].lastSynced = new Date().toISOString();
    store.products[productHash].customPrice = price;
    store.updatedAt = new Date().toISOString();
    saveStores(stores);

    console.log(`✅ Product pushed to Shopify: ${product.title} → ${shopifyProductData.id}`);
    res.json({
      success: true,
      shopifyProduct: {
        id: shopifyProductData.id,
        title: shopifyProductData.title,
        handle: shopifyProductData.handle,
        url: `https://${store.shopify.shop}/products/${shopifyProductData.handle}`,
        adminUrl: `https://${store.shopify.shop}/admin/products/${shopifyProductData.id}`
      }
    });
  } catch (e) {
    console.error('❌ Push to Shopify error:', e.response?.data || e.message);
    res.json({ success: false, error: e.response?.data?.errors || e.message });
  }
});

// Push all products to Shopify
app.post('/api/stores/:storeId/shopify/push-all', async (req, res) => {
  try {
    const storeId = req.params.storeId;

    // Get store
    const stores = loadStores();
    const store = stores.stores[storeId];
    if (!store) {
      return res.json({ success: false, error: 'Store not found' });
    }

    if (!store.shopify || !store.shopify.shop) {
      return res.json({ success: false, error: 'Shopify not connected' });
    }

    // Get access token (supports Custom App tokens and Client Credentials)
    const accessToken = await getShopifyAccessToken(store.shopify.shop, getStoreCredentials(store));

    const products = Object.values(store.products);
    const unpublished = products.filter(p => !p.shopifyProductId);

    if (unpublished.length === 0) {
      return res.json({ success: true, message: 'All products already published', pushed: 0 });
    }

    const results = [];
    let successCount = 0;
    let errorCount = 0;

    for (const product of unpublished) {
      try {
        const price = product.customPrice || product.originalPrice;
        const compareAtPrice = (price * 1.3).toFixed(2);

        const shopifyProduct = {
          product: {
            title: product.title,
            body_html: `<p>${product.title}</p><p>Trending product with high demand!</p>`,
            vendor: store.name,
            product_type: product.category || 'General',
            tags: [product.category, 'trending', 'dropship'].filter(Boolean).join(','),
            variants: [{
              price: price.toFixed(2),
              compare_at_price: compareAtPrice,
              inventory_management: 'shopify',
              inventory_policy: 'continue',
              requires_shipping: true
            }],
            images: product.image ? [{ src: product.image }] : [],
            status: 'active'
          }
        };

        const response = await axios.post(
          `https://${store.shopify.shop}/admin/api/2024-01/products.json`,
          shopifyProduct,
          { headers: { 'X-Shopify-Access-Token': accessToken, 'Content-Type': 'application/json' } }
        );

        const shopifyProductData = response.data.product;

        // Update local store
        store.products[product.hash].shopifyProductId = shopifyProductData.id;
        store.products[product.hash].shopifyStatus = 'published';
        store.products[product.hash].shopifyUrl = `https://${store.shopify.shop}/admin/products/${shopifyProductData.id}`;
        store.products[product.hash].lastSynced = new Date().toISOString();

        results.push({ hash: product.hash, title: product.title, success: true, shopifyId: shopifyProductData.id });
        successCount++;

        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 500));
      } catch (pushError) {
        results.push({ hash: product.hash, title: product.title, success: false, error: pushError.response?.data?.errors || pushError.message });
        errorCount++;
      }
    }

    store.updatedAt = new Date().toISOString();
    saveStores(stores);

    console.log(`✅ Bulk push complete: ${successCount} success, ${errorCount} errors`);
    res.json({
      success: true,
      pushed: successCount,
      errors: errorCount,
      total: unpublished.length,
      results
    });
  } catch (e) {
    console.error('❌ Push all error:', e.message);
    res.json({ success: false, error: e.message });
  }
});

// ================== BULK PUSH TO MULTIPLE STORES ==================

// Push a product to multiple stores at once
app.post('/api/products/bulk-push', async (req, res) => {
  try {
    const { product, storeIds } = req.body;

    if (!product || !product.title) {
      return res.json({ success: false, error: 'Product data required' });
    }

    if (!storeIds || !Array.isArray(storeIds) || storeIds.length === 0) {
      return res.json({ success: false, error: 'Store IDs array required' });
    }

    console.log(`\n📦 Bulk pushing "${product.title.substring(0, 30)}..." to ${storeIds.length} stores`);

    const stores = loadStores();
    const results = [];

    for (const storeId of storeIds) {
      const store = stores.stores[storeId];

      if (!store) {
        results.push({ storeId, success: false, error: 'Store not found' });
        continue;
      }

      if (!store.shopifyConnected) {
        results.push({ storeId, storeName: store.name, success: false, error: 'Shopify not connected' });
        continue;
      }

      try {
        const accessToken = await getShopifyAccessToken(store.shopify.shop, getStoreCredentials(store));
        const hash = hashProduct(product);

        // Add product to store if not already there
        if (!store.products) store.products = {};
        if (!store.products[hash]) {
          store.products[hash] = {
            ...product,
            hash,
            addedAt: new Date().toISOString()
          };
        }

        // Create in Shopify
        const shopifyProduct = {
          product: {
            title: product.title,
            body_html: `<p>${product.title}</p><p>Rating: ${product.rating || 'N/A'} | Sold: ${product.sold || 'N/A'}</p>`,
            vendor: store.name,
            product_type: product.category || 'General',
            tags: [product.category, 'Dropshipping', 'TikTok Trending'].filter(Boolean).join(', '),
            variants: [{
              price: (product.price * 2.5).toFixed(2),
              compare_at_price: (product.price * 3).toFixed(2),
              inventory_policy: 'continue',
              requires_shipping: true
            }],
            images: product.image ? [{ src: product.image }] : [],
            status: 'active'
          }
        };

        const response = await axios.post(
          `https://${store.shopify.shop}/admin/api/2024-01/products.json`,
          shopifyProduct,
          { headers: { 'X-Shopify-Access-Token': accessToken, 'Content-Type': 'application/json' } }
        );

        const shopifyProductData = response.data.product;

        store.products[hash].shopifyProductId = shopifyProductData.id;
        store.products[hash].shopifyStatus = 'published';
        store.products[hash].shopifyUrl = `https://${store.shopify.shop}/admin/products/${shopifyProductData.id}`;
        store.products[hash].lastSynced = new Date().toISOString();

        results.push({
          storeId,
          storeName: store.name,
          success: true,
          shopifyId: shopifyProductData.id,
          productUrl: store.products[hash].shopifyUrl
        });

        console.log(`   ✅ ${store.name}: Product created`);

        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 500));

      } catch (pushError) {
        const errorMsg = pushError.response?.data?.errors || pushError.message;
        results.push({ storeId, storeName: store?.name, success: false, error: errorMsg });
        console.log(`   ❌ ${store?.name}: ${errorMsg}`);
      }
    }

    saveStores(stores);

    const successful = results.filter(r => r.success);
    console.log(`✅ Bulk push complete: ${successful.length}/${results.length} stores`);

    res.json({
      success: true,
      totalStores: storeIds.length,
      successful: successful.length,
      failed: results.length - successful.length,
      results
    });

  } catch (e) {
    console.error('❌ Bulk push error:', e.message);
    res.json({ success: false, error: e.message });
  }
});

// Push multiple products to multiple stores
app.post('/api/products/bulk-push-batch', async (req, res) => {
  try {
    const { products, storeIds } = req.body;

    if (!products || !Array.isArray(products) || products.length === 0) {
      return res.json({ success: false, error: 'Products array required' });
    }

    if (!storeIds || !Array.isArray(storeIds) || storeIds.length === 0) {
      return res.json({ success: false, error: 'Store IDs array required' });
    }

    console.log(`\n📦 Batch pushing ${products.length} products to ${storeIds.length} stores`);

    const stores = loadStores();
    const allResults = [];

    for (const product of products) {
      const productResults = {
        product: { title: product.title, hash: hashProduct(product) },
        stores: []
      };

      for (const storeId of storeIds) {
        const store = stores.stores[storeId];

        if (!store || !store.shopifyConnected) {
          productResults.stores.push({
            storeId,
            storeName: store?.name || 'Unknown',
            success: false,
            error: !store ? 'Store not found' : 'Shopify not connected'
          });
          continue;
        }

        try {
          const accessToken = await getShopifyAccessToken(store.shopify.shop, getStoreCredentials(store));
          const hash = hashProduct(product);

          if (!store.products) store.products = {};
          if (!store.products[hash]) {
            store.products[hash] = { ...product, hash, addedAt: new Date().toISOString() };
          }

          const shopifyProduct = {
            product: {
              title: product.title,
              body_html: `<p>${product.title}</p>`,
              vendor: store.name,
              product_type: product.category || 'General',
              variants: [{
                price: (product.price * 2.5).toFixed(2),
                compare_at_price: (product.price * 3).toFixed(2),
                inventory_policy: 'continue'
              }],
              images: product.image ? [{ src: product.image }] : [],
              status: 'active'
            }
          };

          const response = await axios.post(
            `https://${store.shopify.shop}/admin/api/2024-01/products.json`,
            shopifyProduct,
            { headers: { 'X-Shopify-Access-Token': accessToken, 'Content-Type': 'application/json' } }
          );

          const shopifyData = response.data.product;
          store.products[hash].shopifyProductId = shopifyData.id;
          store.products[hash].shopifyStatus = 'published';
          store.products[hash].lastSynced = new Date().toISOString();

          productResults.stores.push({
            storeId,
            storeName: store.name,
            success: true,
            shopifyId: shopifyData.id
          });

          await new Promise(resolve => setTimeout(resolve, 300));

        } catch (e) {
          productResults.stores.push({
            storeId,
            storeName: store?.name,
            success: false,
            error: e.response?.data?.errors || e.message
          });
        }
      }

      allResults.push(productResults);
    }

    saveStores(stores);

    const totalPushes = products.length * storeIds.length;
    const successfulPushes = allResults.reduce((sum, r) =>
      sum + r.stores.filter(s => s.success).length, 0);

    console.log(`✅ Batch complete: ${successfulPushes}/${totalPushes} successful`);

    res.json({
      success: true,
      totalProducts: products.length,
      totalStores: storeIds.length,
      totalPushes,
      successfulPushes,
      failedPushes: totalPushes - successfulPushes,
      results: allResults
    });

  } catch (e) {
    console.error('❌ Batch push error:', e.message);
    res.json({ success: false, error: e.message });
  }
});

// ================== GRAPHQL BULK OPERATIONS ==================

// Create staged upload for bulk operations
async function createStagedUpload(shop, accessToken, fileSize) {
  const mutation = `
    mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        stagedTargets {
          url
          resourceUrl
          parameters {
            name
            value
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const response = await axios.post(
    `https://${shop}/admin/api/2024-01/graphql.json`,
    {
      query: mutation,
      variables: {
        input: [{
          resource: 'BULK_MUTATION_VARIABLES',
          filename: 'bulk_products.jsonl',
          mimeType: 'text/jsonl',
          fileSize: fileSize.toString(),
          httpMethod: 'POST'
        }]
      }
    },
    { headers: { 'X-Shopify-Access-Token': accessToken, 'Content-Type': 'application/json' } }
  );

  if (response.data.errors) {
    throw new Error(response.data.errors[0].message);
  }

  return response.data.data.stagedUploadsCreate.stagedTargets[0];
}

// Run bulk mutation operation
async function runBulkMutation(shop, accessToken, stagedUploadPath, mutation) {
  const bulkMutation = `
    mutation bulkOperationRunMutation($mutation: String!, $stagedUploadPath: String!) {
      bulkOperationRunMutation(mutation: $mutation, stagedUploadPath: $stagedUploadPath) {
        bulkOperation {
          id
          status
          url
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const response = await axios.post(
    `https://${shop}/admin/api/2024-01/graphql.json`,
    {
      query: bulkMutation,
      variables: { mutation, stagedUploadPath }
    },
    { headers: { 'X-Shopify-Access-Token': accessToken, 'Content-Type': 'application/json' } }
  );

  if (response.data.errors) {
    throw new Error(response.data.errors[0].message);
  }

  return response.data.data.bulkOperationRunMutation;
}

// Check bulk operation status
async function checkBulkOperationStatus(shop, accessToken, operationId) {
  const query = `
    query {
      node(id: "${operationId}") {
        ... on BulkOperation {
          id
          status
          errorCode
          createdAt
          completedAt
          objectCount
          fileSize
          url
          partialDataUrl
        }
      }
    }
  `;

  const response = await axios.post(
    `https://${shop}/admin/api/2024-01/graphql.json`,
    { query },
    { headers: { 'X-Shopify-Access-Token': accessToken, 'Content-Type': 'application/json' } }
  );

  return response.data.data.node;
}

// GraphQL Bulk Product Creation endpoint
app.post('/api/stores/:storeId/shopify/bulk-create', async (req, res) => {
  try {
    const { storeId } = req.params;
    const { products } = req.body;

    if (!products || !Array.isArray(products) || products.length === 0) {
      return res.json({ success: false, error: 'Products array required' });
    }

    const stores = loadStores();
    const store = stores.stores[storeId];

    if (!store || !store.shopifyConnected) {
      return res.json({ success: false, error: 'Store not found or not connected' });
    }

    console.log(`\n📦 GraphQL Bulk creating ${products.length} products for ${store.name}...`);

    const accessToken = await getShopifyAccessToken(store.shopify.shop, getStoreCredentials(store));

    // Build JSONL content for bulk operation
    const jsonlLines = products.map(product => {
      const price = (product.price * 2.5).toFixed(2);
      const comparePrice = (product.price * 3).toFixed(2);

      return JSON.stringify({
        input: {
          title: product.title,
          descriptionHtml: `<p>${product.title}</p><p>Trending product with high demand!</p>`,
          vendor: store.name,
          productType: product.category || 'General',
          tags: [product.category, 'trending', 'dropship', 'bulk-import'].filter(Boolean),
          status: 'ACTIVE',
          variants: [{
            price: price,
            compareAtPrice: comparePrice,
            inventoryPolicy: 'CONTINUE',
            inventoryManagement: 'SHOPIFY'
          }]
        },
        media: product.image ? [{
          originalSource: product.image,
          mediaContentType: 'IMAGE'
        }] : []
      });
    }).join('\n');

    const jsonlBuffer = Buffer.from(jsonlLines, 'utf8');

    // Step 1: Create staged upload
    console.log('   📤 Creating staged upload...');
    const stagedTarget = await createStagedUpload(store.shopify.shop, accessToken, jsonlBuffer.length);

    // Step 2: Upload JSONL file
    console.log('   📁 Uploading JSONL file...');
    const FormData = require('form-data');
    const formData = new FormData();

    // Add parameters from staged upload
    for (const param of stagedTarget.parameters) {
      formData.append(param.name, param.value);
    }
    formData.append('file', jsonlBuffer, { filename: 'bulk_products.jsonl', contentType: 'text/jsonl' });

    await axios.post(stagedTarget.url, formData, {
      headers: formData.getHeaders(),
      maxBodyLength: Infinity
    });

    // Step 3: Run bulk mutation
    console.log('   🚀 Starting bulk operation...');
    const productCreateMutation = `
      mutation call($input: ProductInput!, $media: [CreateMediaInput!]) {
        productCreate(input: $input, media: $media) {
          product {
            id
            title
            handle
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const bulkResult = await runBulkMutation(
      store.shopify.shop,
      accessToken,
      stagedTarget.resourceUrl,
      productCreateMutation
    );

    if (bulkResult.userErrors && bulkResult.userErrors.length > 0) {
      throw new Error(bulkResult.userErrors[0].message);
    }

    const operationId = bulkResult.bulkOperation.id;
    console.log(`   ✅ Bulk operation started: ${operationId}`);

    // Store operation ID for tracking
    if (!store.bulkOperations) store.bulkOperations = [];
    store.bulkOperations.unshift({
      id: operationId,
      type: 'product_create',
      productCount: products.length,
      status: 'RUNNING',
      startedAt: new Date().toISOString()
    });
    if (store.bulkOperations.length > 20) store.bulkOperations.pop();
    saveStores(stores);

    res.json({
      success: true,
      operationId,
      status: 'RUNNING',
      productCount: products.length,
      message: 'Bulk operation started. Use /api/stores/:id/shopify/bulk-status/:operationId to check progress.'
    });

  } catch (e) {
    console.error('❌ Bulk create error:', e.message);
    res.json({ success: false, error: e.message });
  }
});

// Check bulk operation status
app.get('/api/stores/:storeId/shopify/bulk-status/:operationId', async (req, res) => {
  try {
    const { storeId, operationId } = req.params;
    const stores = loadStores();
    const store = stores.stores[storeId];

    if (!store || !store.shopifyConnected) {
      return res.json({ success: false, error: 'Store not found or not connected' });
    }

    const accessToken = await getShopifyAccessToken(store.shopify.shop, getStoreCredentials(store));
    const status = await checkBulkOperationStatus(store.shopify.shop, accessToken, operationId);

    // Update stored operation status
    if (store.bulkOperations) {
      const op = store.bulkOperations.find(o => o.id === operationId);
      if (op) {
        op.status = status.status;
        if (status.completedAt) op.completedAt = status.completedAt;
        if (status.objectCount) op.objectCount = status.objectCount;
        saveStores(stores);
      }
    }

    res.json({
      success: true,
      operation: status
    });

  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// List bulk operations for a store
app.get('/api/stores/:storeId/shopify/bulk-operations', (req, res) => {
  try {
    const { storeId } = req.params;
    const stores = loadStores();
    const store = stores.stores[storeId];

    if (!store) {
      return res.json({ success: false, error: 'Store not found' });
    }

    res.json({
      success: true,
      operations: store.bulkOperations || []
    });

  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ================== SHOPIFY CLI INTEGRATION ==================

const { exec, spawn } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

// Check if Shopify CLI is installed
app.get('/api/cli/status', async (req, res) => {
  try {
    const { stdout } = await execPromise('shopify version 2>&1 || echo "not installed"');
    const isInstalled = !stdout.includes('not installed') && !stdout.includes('command not found');

    res.json({
      success: true,
      installed: isInstalled,
      version: isInstalled ? stdout.trim() : null
    });
  } catch (e) {
    res.json({ success: true, installed: false, error: e.message });
  }
});

// Push theme via CLI
app.post('/api/cli/theme-push', async (req, res) => {
  try {
    const { storeDomain, themePath, themeId, password, unpublished, publish } = req.body;

    if (!storeDomain) {
      return res.json({ success: false, error: 'Store domain required' });
    }

    let cmd = `shopify theme push --store ${storeDomain}`;

    if (password) cmd += ` --password ${password}`;
    if (themePath) cmd += ` --path "${themePath}"`;
    if (themeId) cmd += ` --theme ${themeId}`;
    if (unpublished) cmd += ' --unpublished';
    if (publish) cmd += ' --publish';
    cmd += ' --json';

    console.log(`\n🚀 CLI Theme Push: ${storeDomain}`);

    const { stdout, stderr } = await execPromise(cmd, { timeout: 300000 }); // 5 min timeout

    let result;
    try {
      result = JSON.parse(stdout);
    } catch {
      result = { output: stdout, error: stderr };
    }

    res.json({
      success: true,
      result
    });

  } catch (e) {
    console.error('❌ CLI theme push error:', e.message);
    res.json({ success: false, error: e.message, stderr: e.stderr });
  }
});

// Deploy theme to multiple stores via CLI
app.post('/api/cli/theme-push-bulk', async (req, res) => {
  try {
    const { stores, themePath, unpublished } = req.body;

    if (!stores || !Array.isArray(stores) || stores.length === 0) {
      return res.json({ success: false, error: 'Stores array required' });
    }

    console.log(`\n🚀 CLI Bulk Theme Push to ${stores.length} stores...`);

    const results = [];

    for (const storeConfig of stores) {
      const { domain, password, themeId } = storeConfig;

      try {
        let cmd = `shopify theme push --store ${domain}`;
        if (password) cmd += ` --password ${password}`;
        if (themePath) cmd += ` --path "${themePath}"`;
        if (themeId) cmd += ` --theme ${themeId}`;
        if (unpublished) cmd += ' --unpublished';
        cmd += ' --json';

        const { stdout } = await execPromise(cmd, { timeout: 300000 });

        let result;
        try {
          result = JSON.parse(stdout);
        } catch {
          result = { output: stdout };
        }

        results.push({ domain, success: true, result });
        console.log(`   ✅ ${domain}: Theme pushed`);

      } catch (e) {
        results.push({ domain, success: false, error: e.message });
        console.log(`   ❌ ${domain}: ${e.message}`);
      }

      // Small delay between stores
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    const successful = results.filter(r => r.success);
    console.log(`✅ Bulk push complete: ${successful.length}/${results.length} stores`);

    res.json({
      success: true,
      totalStores: stores.length,
      successful: successful.length,
      failed: results.length - successful.length,
      results
    });

  } catch (e) {
    console.error('❌ CLI bulk push error:', e.message);
    res.json({ success: false, error: e.message });
  }
});

// Generate Theme Access password instructions
app.get('/api/cli/theme-access-setup', (req, res) => {
  res.json({
    success: true,
    instructions: [
      '1. Install Theme Access app: https://apps.shopify.com/theme-access',
      '2. Go to Apps → Theme Access in your Shopify Admin',
      '3. Click "Create password"',
      '4. Copy the generated password',
      '5. Use this password with the --password flag or SHOPIFY_CLI_THEME_TOKEN env var'
    ],
    envVarName: 'SHOPIFY_CLI_THEME_TOKEN',
    docsUrl: 'https://shopify.dev/docs/storefronts/themes/tools/cli'
  });
});

// List themes for a store via CLI
app.get('/api/cli/themes/:storeDomain', async (req, res) => {
  try {
    const { storeDomain } = req.params;
    const { password } = req.query;

    let cmd = `shopify theme list --store ${storeDomain}`;
    if (password) cmd += ` --password ${password}`;
    cmd += ' --json';

    const { stdout } = await execPromise(cmd, { timeout: 60000 });

    let themes;
    try {
      themes = JSON.parse(stdout);
    } catch {
      themes = { raw: stdout };
    }

    res.json({ success: true, themes });

  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Pull theme from store via CLI
app.post('/api/cli/theme-pull', async (req, res) => {
  try {
    const { storeDomain, themeId, password, outputPath } = req.body;

    if (!storeDomain) {
      return res.json({ success: false, error: 'Store domain required' });
    }

    const themesDir = path.join(__dirname, 'themes');
    if (!fs.existsSync(themesDir)) fs.mkdirSync(themesDir);

    const targetPath = outputPath || path.join(themesDir, storeDomain.replace('.myshopify.com', ''));

    let cmd = `shopify theme pull --store ${storeDomain} --path "${targetPath}"`;
    if (password) cmd += ` --password ${password}`;
    if (themeId) cmd += ` --theme ${themeId}`;

    console.log(`\n📥 CLI Theme Pull from ${storeDomain}...`);

    const { stdout, stderr } = await execPromise(cmd, { timeout: 300000 });

    res.json({
      success: true,
      path: targetPath,
      output: stdout,
      message: `Theme pulled to ${targetPath}`
    });

  } catch (e) {
    console.error('❌ CLI theme pull error:', e.message);
    res.json({ success: false, error: e.message });
  }
});

// Get Shopify sync status for a store
app.get('/api/stores/:storeId/shopify/products', async (req, res) => {
  try {
    const storeId = req.params.storeId;
    const stores = loadStores();
    const store = stores.stores[storeId];

    if (!store) {
      return res.json({ success: false, error: 'Store not found' });
    }

    const products = Object.values(store.products);
    const published = products.filter(p => p.shopifyProductId);
    const unpublished = products.filter(p => !p.shopifyProductId);

    res.json({
      success: true,
      total: products.length,
      published: published.length,
      unpublished: unpublished.length,
      products: products.map(p => ({
        hash: p.hash,
        title: p.title,
        status: p.shopifyProductId ? 'published' : 'pending',
        shopifyProductId: p.shopifyProductId || null,
        shopifyUrl: p.shopifyUrl || null,
        lastSynced: p.lastSynced || null
      }))
    });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ================== SHOPIFY INVENTORY SYNC ==================

// Sync inventory from Shopify to local store
app.post('/api/stores/:storeId/sync-inventory', async (req, res) => {
  try {
    const { storeId } = req.params;
    const stores = loadStores();
    const store = stores.stores[storeId];

    if (!store) {
      return res.json({ success: false, error: 'Store not found' });
    }

    if (!store.shopifyConnected) {
      return res.json({ success: false, error: 'Shopify not connected' });
    }

    console.log(`\n🔄 Syncing inventory for ${store.name}...`);

    const accessToken = await getShopifyAccessToken(store.shopify.shop, getStoreCredentials(store));

    // Fetch all products from Shopify
    let allShopifyProducts = [];
    let pageInfo = null;
    let hasNextPage = true;

    while (hasNextPage) {
      const url = pageInfo
        ? `https://${store.shopify.shop}/admin/api/2024-01/products.json?limit=250&page_info=${pageInfo}`
        : `https://${store.shopify.shop}/admin/api/2024-01/products.json?limit=250`;

      const response = await axios.get(url, {
        headers: { 'X-Shopify-Access-Token': accessToken }
      });

      allShopifyProducts = allShopifyProducts.concat(response.data.products);

      // Check for pagination
      const linkHeader = response.headers.link;
      if (linkHeader && linkHeader.includes('rel="next"')) {
        const match = linkHeader.match(/<[^>]*page_info=([^>&]+)[^>]*>; rel="next"/);
        pageInfo = match ? match[1] : null;
        hasNextPage = !!pageInfo;
      } else {
        hasNextPage = false;
      }
    }

    console.log(`   📦 Found ${allShopifyProducts.length} products in Shopify`);

    // Update local store with Shopify data
    const syncResults = {
      synced: 0,
      added: 0,
      updated: 0,
      errors: []
    };

    if (!store.products) store.products = {};
    if (!store.inventory) store.inventory = {};

    for (const shopifyProduct of allShopifyProducts) {
      try {
        // Try to match with existing local product
        const existingHash = Object.keys(store.products).find(hash =>
          store.products[hash].shopifyProductId === shopifyProduct.id
        );

        // Get inventory levels
        let totalInventory = 0;
        for (const variant of shopifyProduct.variants || []) {
          totalInventory += variant.inventory_quantity || 0;
        }

        if (existingHash) {
          // Update existing product
          store.products[existingHash].shopifyTitle = shopifyProduct.title;
          store.products[existingHash].shopifyStatus = shopifyProduct.status;
          store.products[existingHash].shopifyInventory = totalInventory;
          store.products[existingHash].lastSynced = new Date().toISOString();
          store.products[existingHash].variants = shopifyProduct.variants?.length || 1;
          syncResults.updated++;
        } else {
          // Add new product from Shopify (not originally from our system)
          const newHash = `shopify_${shopifyProduct.id}`;
          store.products[newHash] = {
            hash: newHash,
            title: shopifyProduct.title,
            shopifyProductId: shopifyProduct.id,
            shopifyStatus: shopifyProduct.status,
            shopifyInventory: totalInventory,
            price: parseFloat(shopifyProduct.variants?.[0]?.price || 0),
            image: shopifyProduct.images?.[0]?.src || null,
            category: shopifyProduct.product_type || 'Unknown',
            addedAt: shopifyProduct.created_at,
            lastSynced: new Date().toISOString(),
            source: 'shopify'
          };
          syncResults.added++;
        }

        // Store inventory tracking
        store.inventory[shopifyProduct.id] = {
          productId: shopifyProduct.id,
          title: shopifyProduct.title,
          totalQuantity: totalInventory,
          variants: shopifyProduct.variants?.map(v => ({
            id: v.id,
            title: v.title,
            sku: v.sku,
            quantity: v.inventory_quantity,
            price: v.price
          })) || [],
          lastSynced: new Date().toISOString()
        };

        syncResults.synced++;
      } catch (productError) {
        syncResults.errors.push({
          productId: shopifyProduct.id,
          title: shopifyProduct.title,
          error: productError.message
        });
      }
    }

    store.lastInventorySync = new Date().toISOString();
    store.shopifyProductCount = allShopifyProducts.length;
    saveStores(stores);

    console.log(`   ✅ Sync complete: ${syncResults.synced} synced, ${syncResults.added} added, ${syncResults.updated} updated`);

    res.json({
      success: true,
      ...syncResults,
      totalShopifyProducts: allShopifyProducts.length,
      lastSync: store.lastInventorySync
    });

  } catch (e) {
    console.error('❌ Inventory sync error:', e.message);
    res.json({ success: false, error: e.message });
  }
});

// Get inventory for a store
app.get('/api/stores/:storeId/inventory', (req, res) => {
  try {
    const { storeId } = req.params;
    const { lowStock = 10 } = req.query;
    const stores = loadStores();
    const store = stores.stores[storeId];

    if (!store) {
      return res.json({ success: false, error: 'Store not found' });
    }

    const inventory = Object.values(store.inventory || {});
    const lowStockItems = inventory.filter(item => item.totalQuantity <= parseInt(lowStock));
    const outOfStock = inventory.filter(item => item.totalQuantity === 0);

    res.json({
      success: true,
      totalProducts: inventory.length,
      lowStockCount: lowStockItems.length,
      outOfStockCount: outOfStock.length,
      lastSync: store.lastInventorySync,
      inventory: inventory.sort((a, b) => a.totalQuantity - b.totalQuantity),
      lowStockItems,
      outOfStock
    });

  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Get low stock alerts across all stores
app.get('/api/inventory/alerts', (req, res) => {
  try {
    const { threshold = 10 } = req.query;
    const stores = loadStores();
    const alerts = [];

    Object.entries(stores.stores || {}).forEach(([storeId, store]) => {
      if (!store.inventory) return;

      Object.values(store.inventory).forEach(item => {
        if (item.totalQuantity <= parseInt(threshold)) {
          alerts.push({
            storeId,
            storeName: store.name,
            productId: item.productId,
            productTitle: item.title,
            quantity: item.totalQuantity,
            alertType: item.totalQuantity === 0 ? 'out_of_stock' : 'low_stock',
            lastSynced: item.lastSynced
          });
        }
      });
    });

    // Sort by quantity (most urgent first)
    alerts.sort((a, b) => a.quantity - b.quantity);

    res.json({
      success: true,
      threshold: parseInt(threshold),
      alertCount: alerts.length,
      outOfStockCount: alerts.filter(a => a.alertType === 'out_of_stock').length,
      lowStockCount: alerts.filter(a => a.alertType === 'low_stock').length,
      alerts
    });

  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Sync inventory for all stores
app.post('/api/inventory/sync-all', async (req, res) => {
  try {
    const stores = loadStores();
    const results = [];

    console.log('\n🔄 Syncing inventory for all stores...');

    for (const [storeId, store] of Object.entries(stores.stores || {})) {
      if (!store.shopifyConnected) {
        results.push({ storeId, storeName: store.name, success: false, error: 'Not connected' });
        continue;
      }

      try {
        const accessToken = await getShopifyAccessToken(store.shopify.shop, getStoreCredentials(store));

        // Simple count fetch for bulk sync
        const response = await axios.get(
          `https://${store.shopify.shop}/admin/api/2024-01/products.json?limit=250`,
          { headers: { 'X-Shopify-Access-Token': accessToken } }
        );

        const products = response.data.products;
        let totalInventory = 0;
        let lowStockCount = 0;

        if (!store.inventory) store.inventory = {};

        for (const product of products) {
          const qty = product.variants?.reduce((sum, v) => sum + (v.inventory_quantity || 0), 0) || 0;
          totalInventory += qty;
          if (qty <= 10) lowStockCount++;

          store.inventory[product.id] = {
            productId: product.id,
            title: product.title,
            totalQuantity: qty,
            lastSynced: new Date().toISOString()
          };
        }

        store.lastInventorySync = new Date().toISOString();

        results.push({
          storeId,
          storeName: store.name,
          success: true,
          productCount: products.length,
          totalInventory,
          lowStockCount
        });

        console.log(`   ✅ ${store.name}: ${products.length} products, ${lowStockCount} low stock`);

        await new Promise(resolve => setTimeout(resolve, 500));

      } catch (e) {
        results.push({ storeId, storeName: store.name, success: false, error: e.message });
        console.log(`   ❌ ${store.name}: ${e.message}`);
      }
    }

    saveStores(stores);

    const successful = results.filter(r => r.success);
    console.log(`✅ Bulk sync complete: ${successful.length}/${results.length} stores`);

    res.json({
      success: true,
      totalStores: results.length,
      successfulSyncs: successful.length,
      results
    });

  } catch (e) {
    console.error('❌ Bulk sync error:', e.message);
    res.json({ success: false, error: e.message });
  }
});

// Update inventory (push to Shopify)
app.post('/api/stores/:storeId/inventory/:productId', async (req, res) => {
  try {
    const { storeId, productId } = req.params;
    const { quantity, variantId } = req.body;

    const stores = loadStores();
    const store = stores.stores[storeId];

    if (!store || !store.shopifyConnected) {
      return res.json({ success: false, error: 'Store not found or not connected' });
    }

    const accessToken = await getShopifyAccessToken(store.shopify.shop, getStoreCredentials(store));

    // First, get the inventory item ID
    const productResponse = await axios.get(
      `https://${store.shopify.shop}/admin/api/2024-01/products/${productId}.json`,
      { headers: { 'X-Shopify-Access-Token': accessToken } }
    );

    const product = productResponse.data.product;
    const variant = variantId
      ? product.variants.find(v => v.id == variantId)
      : product.variants[0];

    if (!variant) {
      return res.json({ success: false, error: 'Variant not found' });
    }

    // Get location ID
    const locationsResponse = await axios.get(
      `https://${store.shopify.shop}/admin/api/2024-01/locations.json`,
      { headers: { 'X-Shopify-Access-Token': accessToken } }
    );

    const locationId = locationsResponse.data.locations[0]?.id;

    if (!locationId) {
      return res.json({ success: false, error: 'No location found' });
    }

    // Set inventory level
    await axios.post(
      `https://${store.shopify.shop}/admin/api/2024-01/inventory_levels/set.json`,
      {
        location_id: locationId,
        inventory_item_id: variant.inventory_item_id,
        available: quantity
      },
      { headers: { 'X-Shopify-Access-Token': accessToken, 'Content-Type': 'application/json' } }
    );

    // Update local inventory
    if (store.inventory && store.inventory[productId]) {
      store.inventory[productId].totalQuantity = quantity;
      store.inventory[productId].lastSynced = new Date().toISOString();
      saveStores(stores);
    }

    console.log(`✅ Updated inventory for product ${productId}: ${quantity} units`);

    res.json({
      success: true,
      productId,
      variantId: variant.id,
      quantity,
      updatedAt: new Date().toISOString()
    });

  } catch (e) {
    console.error('❌ Inventory update error:', e.message);
    res.json({ success: false, error: e.message });
  }
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

// ================== GOOGLE TRENDS API ==================

// Check Google Trends for a specific keyword
app.get('/api/trends', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) {
      return res.json({ success: false, error: 'Missing query parameter "q"' });
    }

    console.log(`📈 Checking Google Trends for: "${q}"`);
    const trendData = await checkGoogleTrend(q);

    res.json({
      success: true,
      keyword: q,
      ...trendData
    });
  } catch (e) {
    console.error('❌ Trends error:', e.message);
    res.json({ success: false, error: e.message });
  }
});

// Check multiple keywords at once
app.post('/api/trends/batch', async (req, res) => {
  try {
    const { keywords } = req.body;
    if (!keywords || !Array.isArray(keywords)) {
      return res.json({ success: false, error: 'Missing keywords array' });
    }

    const results = await batchCheckTrends(keywords);

    res.json({
      success: true,
      results
    });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ================== REGIONAL TREND DATA ==================

// Check trends across multiple regions for ad targeting
async function checkRegionalTrends(keyword, regions = ['US', 'GB', 'CA', 'AU', 'DE', 'FR']) {
  const results = {};
  const regionNames = {
    'US': 'United States',
    'GB': 'United Kingdom',
    'CA': 'Canada',
    'AU': 'Australia',
    'DE': 'Germany',
    'FR': 'France',
    'NL': 'Netherlands',
    'ES': 'Spain',
    'IT': 'Italy',
    'BR': 'Brazil',
    'MX': 'Mexico',
    'IN': 'India'
  };

  for (const geo of regions) {
    try {
      const cacheKey = `${keyword.toLowerCase().trim()}_${geo}`;
      const cached = trendsCache.get(cacheKey);

      if (cached && Date.now() - cached.timestamp < TRENDS_CACHE_TTL) {
        results[geo] = { ...cached.data, regionName: regionNames[geo] || geo };
        continue;
      }

      const response = await googleTrends.interestOverTime({
        keyword: keyword,
        startTime: new Date(Date.now() - (90 * 24 * 60 * 60 * 1000)),
        geo: geo
      });

      if (!response || response.startsWith('<') || response.startsWith('L')) {
        results[geo] = { error: 'Rate limited', score: 50, regionName: regionNames[geo] || geo };
        continue;
      }

      const data = JSON.parse(response);
      const timeline = data.default?.timelineData || [];

      if (timeline.length < 2) {
        results[geo] = { score: 50, direction: 'unknown', regionName: regionNames[geo] || geo };
        continue;
      }

      const values = timeline.map(t => t.value[0]);
      const recentAvg = values.slice(-4).reduce((a, b) => a + b, 0) / 4;
      const olderAvg = values.slice(0, 4).reduce((a, b) => a + b, 0) / 4;

      let direction = 'stable';
      let trendScore = 50;

      if (recentAvg > olderAvg * 1.2) {
        direction = 'rising';
        trendScore = Math.min(100, 60 + (recentAvg - olderAvg));
      } else if (recentAvg < olderAvg * 0.8) {
        direction = 'declining';
        trendScore = Math.max(0, 40 - (olderAvg - recentAvg));
      }

      const result = {
        score: Math.round(trendScore),
        direction,
        currentInterest: Math.round(recentAvg),
        previousInterest: Math.round(olderAvg),
        percentChange: Math.round(((recentAvg - olderAvg) / (olderAvg || 1)) * 100),
        regionName: regionNames[geo] || geo
      };

      trendsCache.set(cacheKey, { data: result, timestamp: Date.now() });
      results[geo] = result;

      // Small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 200));
    } catch (e) {
      results[geo] = {
        error: e.message,
        score: 50,
        direction: 'unknown',
        regionName: regionNames[geo] || geo
      };
    }
  }

  return results;
}

// Get regional trends for a keyword (for ad targeting)
app.get('/api/trends/regional', async (req, res) => {
  try {
    const { q, regions } = req.query;

    if (!q) {
      return res.json({ success: false, error: 'Missing query parameter "q"' });
    }

    const regionList = regions ? regions.split(',') : ['US', 'GB', 'CA', 'AU'];
    console.log(`🌍 Checking regional trends for "${q}" in ${regionList.join(', ')}`);

    const regionalData = await checkRegionalTrends(q, regionList);

    // Sort regions by score to find best markets
    const sortedRegions = Object.entries(regionalData)
      .map(([geo, data]) => ({ geo, ...data }))
      .sort((a, b) => (b.score || 0) - (a.score || 0));

    // Calculate recommendations
    const topMarkets = sortedRegions.filter(r => r.score >= 60 && r.direction !== 'declining');
    const risingMarkets = sortedRegions.filter(r => r.direction === 'rising');

    res.json({
      success: true,
      keyword: q,
      regional: regionalData,
      rankings: sortedRegions,
      recommendations: {
        topMarkets: topMarkets.slice(0, 3).map(r => r.geo),
        risingMarkets: risingMarkets.map(r => r.geo),
        bestForAds: topMarkets.length > 0 ? topMarkets[0].geo : 'US',
        suggestion: topMarkets.length > 0
          ? `Focus ads on ${topMarkets.slice(0, 2).map(r => r.regionName).join(' and ')} where demand is strongest.`
          : `Consider broader targeting or test multiple regions.`
      }
    });
  } catch (e) {
    console.error('❌ Regional trends error:', e.message);
    res.json({ success: false, error: e.message });
  }
});

// Compare trends across regions for multiple keywords (batch)
app.post('/api/trends/regional/batch', async (req, res) => {
  try {
    const { keywords, regions } = req.body;

    if (!keywords || !Array.isArray(keywords)) {
      return res.json({ success: false, error: 'Missing keywords array' });
    }

    const regionList = regions || ['US', 'GB', 'CA', 'AU'];
    const results = {};

    for (const keyword of keywords.slice(0, 5)) { // Limit to 5 keywords
      results[keyword] = await checkRegionalTrends(keyword, regionList);
      await new Promise(resolve => setTimeout(resolve, 500)); // Rate limit protection
    }

    res.json({
      success: true,
      results,
      regions: regionList
    });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ================== CROSS-REFERENCE DATA SOURCES ==================
// Structure for adding additional data sources (TikTok Creative Center, AliExpress, etc.)

const DATA_SOURCES = {
  scrapecreators: {
    name: 'ScrapeCreators',
    type: 'tiktok-shop',
    enabled: true,
    priority: 1
  },
  googleTrends: {
    name: 'Google Trends',
    type: 'trend-validation',
    enabled: true,
    priority: 2
  },
  // Future data sources - ready to integrate
  tiktokCreativeCenter: {
    name: 'TikTok Creative Center',
    type: 'ad-intelligence',
    enabled: false, // Set to true when API key is added
    priority: 3,
    note: 'Shows products with active paid ads - high conversion signal'
  },
  aliexpress: {
    name: 'AliExpress',
    type: 'supplier-pricing',
    enabled: false,
    priority: 5,
    note: 'AliExpress supplier pricing via Apify'
  },
  cjdropshipping: {
    name: 'CJDropshipping',
    type: 'supplier-fulfillment',
    enabled: false,
    priority: 4,
    note: 'Get actual supplier prices for accurate margin calculation'
  }
};

// Endpoint to get available data sources
app.get('/api/data-sources', (req, res) => {
  const config = loadConfig();
  const hasApify = !!config.apifyKey;
  const hasCJ = !!config.cjApiKey;

  // Update enabled status based on API key availability
  const sources = {
    ...DATA_SOURCES,
    tiktokCreativeCenter: { ...DATA_SOURCES.tiktokCreativeCenter, enabled: hasApify },
    aliexpress: { ...DATA_SOURCES.aliexpress, enabled: hasApify },
    cjdropshipping: { ...DATA_SOURCES.cjdropshipping, enabled: hasCJ }
  };

  res.json({
    success: true,
    sources,
    activeSources: Object.entries(sources)
      .filter(([_, v]) => v.enabled)
      .map(([k, v]) => ({ id: k, ...v }))
  });
});

// ================== APIFY INTEGRATIONS ==================

// Cache for Apify results (avoid excessive API calls)
const apifyCache = new Map();
const APIFY_CACHE_TTL = 1000 * 60 * 60; // 1 hour

// TikTok Creative Center - Get trending products with active paid ads
app.get('/api/tiktok/creative-center', async (req, res) => {
  try {
    const apify = getApify();

    if (!apify) {
      return res.json({
        success: false,
        error: 'Apify API key not configured. Add your key in Settings.',
        requiresKey: true
      });
    }

    const { country = 'US', maxResults = 50 } = req.query;
    const cacheKey = `creative-center-${country}`;

    // Check cache
    const cached = apifyCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < APIFY_CACHE_TTL) {
      console.log('📦 Returning cached Creative Center data');
      return res.json({ success: true, ...cached.data, fromCache: true });
    }

    console.log(`\n🎬 Fetching TikTok Creative Center data (${country})...`);

    try {
      // Run the TikTok Creative Center Top Ads scraper
      const run = await apify.actor('clockworks/tiktok-trends-scraper').call({
        country: country.toLowerCase(),
        maxItems: parseInt(maxResults)
      }, { timeout: 120000 }); // 2 minute timeout

      const { items } = await apify.dataset(run.defaultDatasetId).listItems();

      const result = {
        trendingProducts: items.slice(0, parseInt(maxResults)),
        totalFound: items.length,
        country,
        fetchedAt: new Date().toISOString()
      };

      // Cache the result
      apifyCache.set(cacheKey, { data: result, timestamp: Date.now() });

      console.log(`✅ Creative Center: Found ${items.length} trending items`);
      res.json({ success: true, ...result });

    } catch (apifyError) {
      console.error('❌ Apify Creative Center error:', apifyError.message);

      // Return fallback/cached data if available
      if (cached) {
        return res.json({
          success: true,
          ...cached.data,
          fromCache: true,
          cacheAge: Math.round((Date.now() - cached.timestamp) / 1000 / 60) + ' minutes'
        });
      }

      res.json({
        success: false,
        error: apifyError.message,
        tip: 'Check your Apify API key and account credits'
      });
    }

  } catch (e) {
    console.error('❌ Creative Center error:', e.message);
    res.json({ success: false, error: e.message });
  }
});

// ================== ALIEXPRESS SUPPLIER PRICING ==================

// Search AliExpress for supplier pricing
app.get('/api/aliexpress/search', async (req, res) => {
  try {
    const apify = getApify();

    if (!apify) {
      return res.json({
        success: false,
        error: 'Apify API key required for AliExpress data',
        requiresKey: true
      });
    }

    const { q, maxResults = 10 } = req.query;

    if (!q) {
      return res.json({ success: false, error: 'Query parameter "q" required' });
    }

    const cacheKey = `aliexpress-${q.toLowerCase().replace(/\s+/g, '-')}`;

    // Check cache (24 hour TTL for supplier prices)
    const cached = apifyCache.get(cacheKey);
    const ALIEXPRESS_CACHE_TTL = 1000 * 60 * 60 * 24; // 24 hours

    if (cached && Date.now() - cached.timestamp < ALIEXPRESS_CACHE_TTL) {
      console.log('📦 Returning cached AliExpress data');
      return res.json({ success: true, ...cached.data, fromCache: true });
    }

    console.log(`\n🛒 Searching AliExpress for: "${q}"...`);

    try {
      const run = await apify.actor('epctex/aliexpress-scraper').call({
        searchQuery: q,
        maxItems: parseInt(maxResults),
        proxyConfiguration: { useApifyProxy: true }
      }, { timeout: 180000 }); // 3 minute timeout

      const { items } = await apify.dataset(run.defaultDatasetId).listItems();

      // Process and normalize the data
      const suppliers = items.map(item => ({
        title: item.title || item.productTitle,
        price: parseFloat(item.price || item.salePrice || 0),
        originalPrice: parseFloat(item.originalPrice || 0),
        currency: item.currency || 'USD',
        minOrder: item.minOrder || 1,
        shipping: item.shippingInfo || item.freeShipping ? 'Free' : 'Varies',
        shippingCost: parseFloat(item.shippingCost || 0),
        sellerRating: parseFloat(item.sellerRating || item.storeRating || 0),
        soldCount: parseInt(item.soldCount || item.orders || 0),
        reviewCount: parseInt(item.reviewCount || item.reviews || 0),
        imageUrl: item.imageUrl || item.image,
        productUrl: item.productUrl || item.url,
        storeUrl: item.storeUrl,
        storeName: item.storeName || item.sellerName
      }));

      // Calculate summary stats
      const prices = suppliers.map(s => s.price).filter(p => p > 0);
      const summary = {
        avgPrice: prices.length > 0 ? parseFloat((prices.reduce((a, b) => a + b, 0) / prices.length).toFixed(2)) : 0,
        minPrice: prices.length > 0 ? Math.min(...prices) : 0,
        maxPrice: prices.length > 0 ? Math.max(...prices) : 0,
        supplierCount: suppliers.length
      };

      const result = {
        query: q,
        suppliers,
        summary,
        fetchedAt: new Date().toISOString()
      };

      // Cache the result
      apifyCache.set(cacheKey, { data: result, timestamp: Date.now() });

      console.log(`✅ AliExpress: Found ${suppliers.length} suppliers, avg price: $${summary.avgPrice}`);
      res.json({ success: true, ...result });

    } catch (apifyError) {
      console.error('❌ Apify AliExpress error:', apifyError.message);

      // Return cached data if available
      if (cached) {
        return res.json({
          success: true,
          ...cached.data,
          fromCache: true,
          cacheAge: Math.round((Date.now() - cached.timestamp) / 1000 / 60 / 60) + ' hours'
        });
      }

      // Fallback to generated search URLs
      res.json({
        success: true,
        query: q,
        suppliers: [],
        summary: { avgPrice: 0, minPrice: 0, maxPrice: 0, supplierCount: 0 },
        searchUrls: {
          aliexpress: `https://www.aliexpress.com/wholesale?SearchText=${encodeURIComponent(q)}`,
          cjdropshipping: `https://cjdropshipping.com/search?keyword=${encodeURIComponent(q)}`,
          alibaba: `https://www.alibaba.com/trade/search?SearchText=${encodeURIComponent(q)}`
        },
        error: 'API unavailable, use search links instead',
        fetchedAt: new Date().toISOString()
      });
    }

  } catch (e) {
    console.error('❌ AliExpress search error:', e.message);
    res.json({ success: false, error: e.message });
  }
});

// Get real supplier price for margin calculation
app.post('/api/aliexpress/pricing', async (req, res) => {
  try {
    const { productTitle, productPrice } = req.body;

    if (!productTitle) {
      return res.json({ success: false, error: 'Product title required' });
    }

    const memory = loadMemory();
    const searchTerms = productTitle.toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(' ')
      .filter(w => w.length > 2)
      .slice(0, 4)
      .join(' ');

    // Check cache first
    const cacheKey = `aliexpress-pricing-${searchTerms.replace(/\s+/g, '-')}`;
    const cached = memory.supplierPriceCache?.[cacheKey];
    const CACHE_TTL = 1000 * 60 * 60 * 24; // 24 hours

    if (cached && Date.now() - new Date(cached.lastUpdated).getTime() < CACHE_TTL) {
      return res.json({
        success: true,
        ...cached,
        fromCache: true
      });
    }

    // Try to get real prices from AliExpress
    const apify = getApify();

    if (!apify) {
      // Return estimated pricing without Apify
      const estimatedSupplierPrice = productPrice * 0.3;
      return res.json({
        success: true,
        searchTerms,
        estimatedPrice: estimatedSupplierPrice,
        priceRange: {
          min: estimatedSupplierPrice * 0.7,
          max: estimatedSupplierPrice * 1.5
        },
        source: 'estimated',
        note: 'Add Apify API key for real supplier prices'
      });
    }

    // Fetch from AliExpress via internal endpoint
    const searchRes = await axios.get(`http://localhost:${PORT}/api/aliexpress/search`, {
      params: { q: searchTerms, maxResults: 5 }
    });

    if (searchRes.data.success && searchRes.data.suppliers?.length > 0) {
      const pricing = {
        searchTerms,
        realPrice: searchRes.data.summary.avgPrice,
        priceRange: {
          min: searchRes.data.summary.minPrice,
          max: searchRes.data.summary.maxPrice
        },
        supplierCount: searchRes.data.summary.supplierCount,
        topSuppliers: searchRes.data.suppliers.slice(0, 3),
        source: 'aliexpress-api',
        lastUpdated: new Date().toISOString()
      };

      // Cache in memory
      if (!memory.supplierPriceCache) memory.supplierPriceCache = {};
      memory.supplierPriceCache[cacheKey] = pricing;
      saveMemory(memory);

      return res.json({ success: true, ...pricing });
    }

    // Fallback to estimation
    const estimatedSupplierPrice = productPrice * 0.3;
    res.json({
      success: true,
      searchTerms,
      estimatedPrice: estimatedSupplierPrice,
      priceRange: {
        min: estimatedSupplierPrice * 0.7,
        max: estimatedSupplierPrice * 1.5
      },
      source: 'estimated'
    });

  } catch (e) {
    console.error('❌ AliExpress pricing error:', e.message);
    res.json({ success: false, error: e.message });
  }
});

// ================== CJDROPSHIPPING INTEGRATION ==================

// CJ API Token cache (persisted to config to survive restarts)
function getCJTokenCache() {
  const config = loadConfig();
  return config.cjTokenCache || { accessToken: null, refreshToken: null, expiresAt: null };
}

function saveCJTokenCache(cache) {
  const config = loadConfig();
  config.cjTokenCache = cache;
  saveConfig(config);
}

// Get CJ Access Token
async function getCJAccessToken() {
  const config = loadConfig();

  if (!config.cjApiKey) {
    throw new Error('CJDropshipping API key not configured');
  }

  // Check persisted token cache
  const tokenCache = getCJTokenCache();

  // Return cached token if valid (with 1 hour buffer)
  if (tokenCache.accessToken && tokenCache.expiresAt > Date.now() + 3600000) {
    console.log('🔑 Using cached CJ token');
    return tokenCache.accessToken;
  }

  // Try to refresh token if we have a refresh token
  if (tokenCache.refreshToken && tokenCache.refreshExpiresAt > Date.now()) {
    try {
      console.log('🔄 Refreshing CJ access token...');
      const response = await axios.post(
        'https://developers.cjdropshipping.com/api2.0/v1/authentication/refreshAccessToken',
        { refreshToken: tokenCache.refreshToken },
        { headers: { 'Content-Type': 'application/json' } }
      );

      if (response.data.code === 200 && response.data.data) {
        const newCache = {
          accessToken: response.data.data.accessToken,
          refreshToken: response.data.data.refreshToken,
          expiresAt: new Date(response.data.data.accessTokenExpiryDate).getTime(),
          refreshExpiresAt: new Date(response.data.data.refreshTokenExpiryDate).getTime()
        };
        saveCJTokenCache(newCache);
        console.log('✅ CJ token refreshed');
        return newCache.accessToken;
      }
    } catch (e) {
      console.log('⚠️ Refresh failed, trying full auth...');
    }
  }

  console.log('🔄 Requesting new CJ access token...');

  try {
    const response = await axios.post(
      'https://developers.cjdropshipping.com/api2.0/v1/authentication/getAccessToken',
      { apiKey: config.cjApiKey },
      { headers: { 'Content-Type': 'application/json' } }
    );

    if (response.data.code === 200 && response.data.data) {
      const newCache = {
        accessToken: response.data.data.accessToken,
        refreshToken: response.data.data.refreshToken,
        expiresAt: new Date(response.data.data.accessTokenExpiryDate).getTime(),
        refreshExpiresAt: new Date(response.data.data.refreshTokenExpiryDate).getTime()
      };
      saveCJTokenCache(newCache);
      console.log('✅ CJ access token obtained');
      return newCache.accessToken;
    } else {
      throw new Error(response.data.message || 'Failed to get CJ token');
    }
  } catch (e) {
    // If rate limited (429), return cached token if we have one
    if (e.response?.status === 429 && tokenCache.accessToken) {
      console.log('⚠️ Rate limited, using existing cached token');
      return tokenCache.accessToken;
    }
    console.error('❌ CJ auth error:', e.message);
    throw e;
  }
}

// CJ Product Search
app.get('/api/cj/search', async (req, res) => {
  try {
    const { q, page = 1, size = 20, countryCode = 'US' } = req.query;

    if (!q) {
      return res.json({ success: false, error: 'Query parameter "q" required' });
    }

    const config = loadConfig();
    if (!config.cjApiKey) {
      return res.json({
        success: false,
        error: 'CJDropshipping API key not configured. Get yours at https://www.cjdropshipping.com/myCJ.html#/apikey',
        requiresKey: true,
        searchUrl: `https://cjdropshipping.com/search?keyword=${encodeURIComponent(q)}`
      });
    }

    // Check cache
    const cacheKey = `cj-search-${q.toLowerCase().replace(/\s+/g, '-')}-${countryCode}`;
    const memory = loadMemory();
    const cached = memory.cjSearchCache?.[cacheKey];
    const CJ_CACHE_TTL = 1000 * 60 * 60 * 12; // 12 hours

    if (cached && Date.now() - new Date(cached.timestamp).getTime() < CJ_CACHE_TTL) {
      console.log('📦 Returning cached CJ search results');
      return res.json({ success: true, ...cached.data, fromCache: true });
    }

    const accessToken = await getCJAccessToken();

    console.log(`\n🛒 Searching CJDropshipping for: "${q}"...`);

    const response = await axios.get(
      'https://developers.cjdropshipping.com/api2.0/v1/product/listV2',
      {
        params: {
          keyWord: q,
          page: parseInt(page),
          size: parseInt(size),
          countryCode,
          orderBy: 0 // best match
        },
        headers: {
          'CJ-Access-Token': accessToken,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log('📦 CJ API Response code:', response.data.code);

    if (response.data.code !== 200) {
      throw new Error(response.data.message || 'CJ API error');
    }

    // CJ API returns products in data.content[0].productList
    const productList = response.data.data?.content?.[0]?.productList || [];
    console.log(`📦 Found ${productList.length} products`);

    const products = productList.map(item => {
      // Parse price - can be "1.65" or "9.00 -- 23.05"
      let sellPrice = 0;
      if (item.sellPrice) {
        const priceStr = item.sellPrice.toString();
        if (priceStr.includes('--')) {
          // Take the lower price for range
          sellPrice = parseFloat(priceStr.split('--')[0].trim()) || 0;
        } else {
          sellPrice = parseFloat(priceStr) || 0;
        }
      }

      return {
        pid: item.id,
        sku: item.sku,
        title: item.nameEn,
        image: item.bigImage,
        sellPrice,
        priceRange: item.sellPrice,
        categoryId: item.categoryId,
        inventory: item.warehouseInventoryNum || 0,
        listedNum: item.listedNum || 0,
        sourceUrl: `https://cjdropshipping.com/product/${item.id}.html`
      };
    });

    // Calculate summary
    const prices = products.map(p => p.sellPrice).filter(p => p > 0);
    const result = {
      query: q,
      products,
      summary: {
        avgPrice: prices.length > 0 ? parseFloat((prices.reduce((a, b) => a + b, 0) / prices.length).toFixed(2)) : 0,
        minPrice: prices.length > 0 ? Math.min(...prices) : 0,
        maxPrice: prices.length > 0 ? Math.max(...prices) : 0,
        productCount: products.length,
        totalFound: response.data.data?.totalRecords || products.length
      },
      fetchedAt: new Date().toISOString()
    };

    // Cache results
    if (!memory.cjSearchCache) memory.cjSearchCache = {};
    memory.cjSearchCache[cacheKey] = { data: result, timestamp: new Date().toISOString() };
    saveMemory(memory);

    console.log(`✅ CJ: Found ${products.length} products, avg price: $${result.summary.avgPrice}`);
    res.json({ success: true, ...result });

  } catch (e) {
    console.error('❌ CJ search error:', e.message);
    res.json({
      success: false,
      error: e.message,
      searchUrl: `https://cjdropshipping.com/search?keyword=${encodeURIComponent(req.query.q || '')}`
    });
  }
});

// CJ Product Details
app.get('/api/cj/product/:pid', async (req, res) => {
  try {
    const { pid } = req.params;
    const { countryCode = 'US' } = req.query;

    const config = loadConfig();
    if (!config.cjApiKey) {
      return res.json({ success: false, error: 'CJDropshipping API key not configured' });
    }

    const accessToken = await getCJAccessToken();

    const response = await axios.get(
      'https://developers.cjdropshipping.com/api2.0/v1/product/query',
      {
        params: { pid, countryCode },
        headers: {
          'CJ-Access-Token': accessToken,
          'Content-Type': 'application/json'
        }
      }
    );

    if (response.data.code !== 200) {
      throw new Error(response.data.message || 'CJ API error');
    }

    const product = response.data.data;
    res.json({
      success: true,
      product: {
        pid: product.pid,
        sku: product.productSku,
        title: product.productNameEn,
        description: product.description,
        image: product.productImage,
        images: product.productImageSet || [],
        sellPrice: parseFloat(product.sellPrice || 0),
        weight: product.productWeight,
        category: product.categoryName,
        variants: (product.variants || []).map(v => ({
          vid: v.vid,
          sku: v.variantSku,
          name: v.variantNameEn,
          image: v.variantImage,
          price: parseFloat(v.variantSellPrice || 0),
          inventory: v.variantInventory || 0
        })),
        sourceUrl: `https://cjdropshipping.com/product/${product.pid}.html`
      }
    });

  } catch (e) {
    console.error('❌ CJ product error:', e.message);
    res.json({ success: false, error: e.message });
  }
});

// Find matching CJ supplier for a TikTok product
app.post('/api/cj/find-supplier', async (req, res) => {
  try {
    const { productTitle, productPrice } = req.body;

    if (!productTitle) {
      return res.json({ success: false, error: 'Product title required' });
    }

    // Extract key search terms from title
    const searchTerms = productTitle.toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(' ')
      .filter(w => w.length > 2 && !['the', 'and', 'for', 'with', 'new', 'hot', 'sale'].includes(w))
      .slice(0, 5)
      .join(' ');

    const config = loadConfig();

    if (!config.cjApiKey) {
      // Return manual search URLs if no API key
      return res.json({
        success: true,
        hasApiKey: false,
        searchTerms,
        suppliers: [],
        searchUrls: {
          cjdropshipping: `https://cjdropshipping.com/search?keyword=${encodeURIComponent(searchTerms)}`,
          aliexpress: `https://www.aliexpress.com/wholesale?SearchText=${encodeURIComponent(searchTerms)}`,
          alibaba: `https://www.alibaba.com/trade/search?SearchText=${encodeURIComponent(searchTerms)}`
        },
        message: 'Add CJ API key for automatic supplier matching'
      });
    }

    // Search CJ for matching products
    const searchResponse = await axios.get(`http://localhost:${PORT}/api/cj/search`, {
      params: { q: searchTerms, size: 10, countryCode: 'US' }
    });

    if (!searchResponse.data.success || !searchResponse.data.products?.length) {
      return res.json({
        success: true,
        hasApiKey: true,
        searchTerms,
        suppliers: [],
        searchUrls: {
          cjdropshipping: `https://cjdropshipping.com/search?keyword=${encodeURIComponent(searchTerms)}`
        },
        message: 'No matching suppliers found on CJ'
      });
    }

    const suppliers = searchResponse.data.products.map(p => ({
      ...p,
      profitMargin: productPrice ?
        parseFloat(((productPrice - p.sellPrice) / productPrice * 100).toFixed(1)) : null,
      estimatedProfit: productPrice ?
        parseFloat((productPrice - p.sellPrice).toFixed(2)) : null
    }));

    // Find best match (lowest price with good margin)
    const bestMatch = suppliers.reduce((best, curr) => {
      if (!best) return curr;
      if (curr.sellPrice < best.sellPrice) return curr;
      return best;
    }, null);

    res.json({
      success: true,
      hasApiKey: true,
      searchTerms,
      suppliers,
      bestMatch,
      summary: searchResponse.data.summary,
      profitAnalysis: productPrice ? {
        retailPrice: productPrice,
        bestSupplierCost: bestMatch?.sellPrice || 0,
        estimatedProfit: bestMatch ? (productPrice - bestMatch.sellPrice) : 0,
        profitMargin: bestMatch ? ((productPrice - bestMatch.sellPrice) / productPrice * 100).toFixed(1) + '%' : 'N/A'
      } : null
    });

  } catch (e) {
    console.error('❌ CJ find supplier error:', e.message);
    res.json({ success: false, error: e.message });
  }
});

// Save/Get CJ API Key
app.get('/api/cj/config', (req, res) => {
  const config = loadConfig();
  res.json({
    hasApiKey: !!config.cjApiKey,
    apiKeyPreview: config.cjApiKey ? config.cjApiKey.substring(0, 20) + '...' : null,
    getKeyUrl: 'https://www.cjdropshipping.com/myCJ.html#/apikey'
  });
});

app.post('/api/cj/config', (req, res) => {
  try {
    const { apiKey } = req.body;
    const config = loadConfig();
    config.cjApiKey = apiKey;
    saveConfig(config);

    // Clear token cache to force re-auth
    cjTokenCache = { accessToken: null, refreshToken: null, expiresAt: null };

    console.log('✅ CJ API key saved');
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ================== CJ AUTO-ORDER SYSTEM (Shopify Webhook Integration) ==================

const ORDERS_PATH = path.join(DATA_DIR, 'orders.json');

// Load/save orders database
function loadOrders() {
  try {
    if (fs.existsSync(ORDERS_PATH)) {
      return JSON.parse(fs.readFileSync(ORDERS_PATH, 'utf8'));
    }
  } catch (e) {
    console.error('Orders load error:', e.message);
  }
  return { orders: [], stats: { total: 0, fulfilled: 0, failed: 0 } };
}

function saveOrders(orders) {
  fs.writeFileSync(ORDERS_PATH, JSON.stringify(orders, null, 2));
}

// Shopify webhook verification
function verifyShopifyWebhook(data, hmacHeader, secret) {
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(data, 'utf8');
  const generatedHash = hmac.digest('base64');
  return crypto.timingSafeEqual(Buffer.from(generatedHash), Buffer.from(hmacHeader));
}

// Resolve a CJ variant id (vid) for a given CJ product id (pid).
// CJ's createOrder requires a variant id, but search/listing only gives us a pid,
// so we look up the product's variants and pick an in-stock (else cheapest) one.
async function resolveCjVariant(pid, accessToken) {
  const resp = await axios.get(
    'https://developers.cjdropshipping.com/api2.0/v1/product/query',
    { params: { pid, countryCode: 'US' }, headers: { 'CJ-Access-Token': accessToken } }
  );

  if (resp.data.code !== 200 || !resp.data.data) {
    throw new Error(resp.data.message || `CJ product ${pid} not found`);
  }

  const data = resp.data.data;
  const variants = data.variants || [];

  if (!variants.length) {
    // Some single-variant products expose the vid at the product level
    if (data.vid) return { vid: data.vid, price: parseFloat(data.sellPrice || 0) };
    throw new Error(`CJ product ${pid} has no orderable variants`);
  }

  const inStock = variants.filter(v => (v.variantInventory || 0) > 0);
  const pool = inStock.length ? inStock : variants;
  const chosen = pool.reduce((best, v) =>
    (!best || parseFloat(v.variantSellPrice || 0) < parseFloat(best.variantSellPrice || 0)) ? v : best, null);

  return { vid: chosen.vid, price: parseFloat(chosen.variantSellPrice || 0) };
}

// Create CJ order from a Shopify order.
// Pass { dryRun: true } to build/validate the payload (resolving vids) WITHOUT submitting.
async function createCJOrder(shopifyOrder, storeId, { dryRun = false } = {}) {
  const accessToken = await getCJAccessToken();
  const storesData = loadStores();
  const store = storesData.stores[storeId];

  if (!store) throw new Error('Store not found');

  // store.products is a hash-keyed object, not an array
  const storeProducts = Object.values(store.products || {});
  const orderItems = [];
  const unmatched = [];
  let resolvedNewVid = false;

  for (const item of (shopifyOrder.line_items || [])) {
    // Match the Shopify line item back to a curated store product
    const storeProduct = storeProducts.find(p =>
      (p.shopifyProductId && String(p.shopifyProductId) === String(item.product_id)) ||
      (p.title && item.title && p.title.toLowerCase().includes(item.title.toLowerCase().substring(0, 20)))
    );

    if (!storeProduct || !storeProduct.cjProductId) {
      unmatched.push(item.title || item.product_id || 'unknown');
      continue;
    }

    // Resolve the CJ variant id, caching it on the product for next time
    let vid = storeProduct.cjVariantId;
    if (!vid) {
      const resolved = await resolveCjVariant(storeProduct.cjProductId, accessToken);
      vid = resolved.vid;
      storeProduct.cjVariantId = vid;
      storeProduct.cjUnitCost = resolved.price;
      resolvedNewVid = true;
    }

    orderItems.push({ vid, quantity: item.quantity || 1 });
  }

  if (orderItems.length === 0) {
    throw new Error(`No CJ-linked products in this order (unmatched: ${unmatched.join(', ') || 'none'})`);
  }

  // Persist any variant ids we just resolved
  if (!dryRun && resolvedNewVid) saveStores(storesData);

  // Extract shipping address
  const shipping = shopifyOrder.shipping_address || shopifyOrder.billing_address || {};

  const cjOrderPayload = {
    orderNumber: `SHOP-${shopifyOrder.order_number || shopifyOrder.id}`,
    shippingZip: shipping.zip || '',
    shippingCountryCode: shipping.country_code || 'US',
    shippingCountry: shipping.country || 'United States',
    shippingProvince: shipping.province || '',
    shippingCity: shipping.city || '',
    shippingAddress: shipping.address1 || '',
    shippingAddress2: shipping.address2 || '',
    shippingCustomerName: `${shipping.first_name || ''} ${shipping.last_name || ''}`.trim(),
    shippingPhone: shipping.phone || shopifyOrder.phone || '',
    remark: `Shopify Order #${shopifyOrder.order_number || shopifyOrder.id}`,
    products: orderItems
  };

  if (dryRun) {
    return { success: true, dryRun: true, matched: orderItems.length, unmatched, payload: cjOrderPayload };
  }

  console.log(`📦 Creating CJ order for Shopify #${shopifyOrder.order_number || shopifyOrder.id}...`);

  const response = await axios.post(
    'https://developers.cjdropshipping.com/api2.0/v1/shopping/order/createOrder',
    cjOrderPayload,
    { headers: { 'Content-Type': 'application/json', 'CJ-Access-Token': accessToken } }
  );

  if (response.data.code === 200 && response.data.data) {
    return {
      success: true,
      cjOrderId: response.data.data.orderId,
      cjOrderNumber: response.data.data.orderNum
    };
  } else {
    throw new Error(response.data.message || 'CJ order creation failed');
  }
}

// Shopify Order Created Webhook Handler
app.post('/api/webhooks/shopify/orders/create', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const config = loadConfig();
    const shopDomain = req.headers['x-shopify-shop-domain'];
    const hmacHeader = req.headers['x-shopify-hmac-sha256'];

    console.log(`\n🛒 Received Shopify order webhook from ${shopDomain}`);

    // Find the store (stores is a hash-keyed object; match on its Shopify domain)
    const stores = loadStores();
    const store = Object.values(stores.stores || {}).find(s => s.shopify?.shop === shopDomain);

    if (!store) {
      console.log('⚠️ Unknown store, ignoring webhook');
      return res.status(200).send('OK');
    }

    // Body is a raw Buffer (express.raw). Parse it once; use the same bytes for HMAC.
    const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8')
                  : (typeof req.body === 'string' ? req.body : JSON.stringify(req.body));

    // Verify webhook signature (HMAC). Required before any autonomous fulfillment.
    // Per-store secret wins (store-level Notification webhooks each have their own secret),
    // then env, then global config.
    const webhookSecret = store.shopify?.webhookSecret || process.env.SHOPIFY_WEBHOOK_SECRET || config.shopifyWebhookSecret;
    let verified = false;
    if (webhookSecret && hmacHeader) {
      try {
        verified = verifyShopifyWebhook(rawBody, hmacHeader, webhookSecret);
      } catch (_) { verified = false; }
      if (!verified) {
        console.log('❌ Invalid webhook signature');
        return res.status(401).send('Invalid signature');
      }
    }

    const order = JSON.parse(rawBody);

    // Dedupe: Shopify retries webhooks, so skip orders we've already processed
    const ordersDb = loadOrders();
    if (ordersDb.orders.some(o => String(o.shopifyOrderId) === String(order.id))) {
      console.log('↩️ Duplicate webhook for order', order.id, '- already processed');
      return res.status(200).send('OK');
    }

    const orderRecord = {
      id: `ord_${Date.now().toString(36)}`,
      shopifyOrderId: order.id,
      shopifyOrderNumber: order.order_number,
      storeId: store.id,
      storeName: store.name,
      status: 'pending',
      verified,
      totalPrice: order.total_price,
      currency: order.currency,
      itemCount: order.line_items?.length || 0,
      customerEmail: order.email,
      createdAt: new Date().toISOString(),
      cjOrderId: null,
      cjOrderNumber: null,
      error: null,
      // Persist what CJ fulfillment needs so retries never require a read_orders refetch
      payload: {
        id: order.id,
        order_number: order.order_number,
        line_items: order.line_items,
        shipping_address: order.shipping_address,
        billing_address: order.billing_address,
        phone: order.phone
      }
    };

    // Gates before spending money: store toggle, HMAC verification, autonomy kill-switch.
    const autonomy = getAutonomyMode();
    if (!store.autoOrderEnabled) {
      orderRecord.status = 'received';
      console.log('ℹ️ Auto-order disabled for this store — recorded only');
    } else if (!verified) {
      orderRecord.status = 'unverified';
      orderRecord.error = 'Webhook HMAC not verified (missing/invalid secret) — refusing to auto-fulfill';
      console.log('🔒 Unverified webhook — refusing to auto-fulfill');
      await notify('warn', 'Unverified order webhook — not fulfilled',
        `Order #${order.order_number} on ${store.name}. Set SHOPIFY_WEBHOOK_SECRET to enable auto-fulfillment.`, { store: store.name });
    } else if (autonomy !== 'full') {
      orderRecord.status = 'held';
      orderRecord.error = `Autonomy is '${autonomy}' — fulfillment held`;
      await notify('warn', 'Order held (autonomy not full)',
        `Order #${order.order_number} on ${store.name} recorded but not fulfilled (autonomy=${autonomy}).`, { store: store.name });
    } else {
      try {
        const cjResult = await createCJOrder(order, store.id);
        orderRecord.status = 'submitted';
        orderRecord.cjOrderId = cjResult.cjOrderId;
        orderRecord.cjOrderNumber = cjResult.cjOrderNumber;
        orderRecord.submittedAt = new Date().toISOString();
        ordersDb.stats.fulfilled++;
        console.log(`✅ CJ order created: ${cjResult.cjOrderNumber}`);
        logAction({ job: 'order-webhook', store: store.name, type: 'fulfill', decision: 'auto-create CJ order', after: { cjOrderNumber: cjResult.cjOrderNumber }, result: 'submitted' });
        await notify('action', 'Order auto-fulfilled',
          `Shopify #${order.order_number} → CJ ${cjResult.cjOrderNumber} (${store.name})`, { store: store.name });
      } catch (cjError) {
        orderRecord.status = 'failed';
        orderRecord.error = cjError.message;
        ordersDb.stats.failed++;
        console.log(`❌ CJ order failed: ${cjError.message}`);
        logAction({ job: 'order-webhook', store: store.name, type: 'fulfill', decision: 'auto-create CJ order', result: 'failed', error: cjError.message });
        await notify('error', 'Order fulfillment failed',
          `Shopify #${order.order_number} (${store.name}): ${cjError.message}`, { store: store.name });
      }
    }

    ordersDb.orders.unshift(orderRecord);
    ordersDb.stats.total++;
    if (ordersDb.orders.length > 500) ordersDb.orders.pop();
    saveOrders(ordersDb);

    res.status(200).send('OK');

  } catch (e) {
    console.error('❌ Webhook error:', e.message);
    res.status(500).send('Error');
  }
});

// Get orders list
app.get('/api/orders', (req, res) => {
  try {
    const { storeId, status, limit = 50 } = req.query;
    let ordersDb = loadOrders();
    let orders = ordersDb.orders;

    if (storeId) {
      orders = orders.filter(o => o.storeId === storeId);
    }
    if (status) {
      orders = orders.filter(o => o.status === status);
    }

    res.json({
      success: true,
      orders: orders.slice(0, parseInt(limit)),
      stats: ordersDb.stats
    });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Get single order details
app.get('/api/orders/:orderId', async (req, res) => {
  try {
    const { orderId } = req.params;
    const ordersDb = loadOrders();
    const order = ordersDb.orders.find(o => o.id === orderId);

    if (!order) {
      return res.json({ success: false, error: 'Order not found' });
    }

    // If we have a CJ order, try to get tracking info
    let tracking = null;
    if (order.cjOrderId) {
      try {
        const accessToken = await getCJAccessToken();
        const trackingResponse = await axios.get(
          `https://developers.cjdropshipping.com/api2.0/v1/shopping/order/getOrderDetail?orderId=${order.cjOrderId}`,
          { headers: { 'CJ-Access-Token': accessToken } }
        );

        if (trackingResponse.data.code === 200 && trackingResponse.data.data) {
          tracking = {
            status: trackingResponse.data.data.orderStatus,
            trackingNumber: trackingResponse.data.data.trackNumber,
            carrier: trackingResponse.data.data.logisticName
          };
        }
      } catch (e) {
        console.log('Could not fetch CJ tracking:', e.message);
      }
    }

    res.json({ success: true, order, tracking });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Retry failed order
app.post('/api/orders/:orderId/retry', async (req, res) => {
  try {
    const { orderId } = req.params;
    const ordersDb = loadOrders();
    const orderIndex = ordersDb.orders.findIndex(o => o.id === orderId);

    if (orderIndex === -1) {
      return res.json({ success: false, error: 'Order not found' });
    }

    const order = ordersDb.orders[orderIndex];

    if (order.status !== 'failed') {
      return res.json({ success: false, error: 'Only failed orders can be retried' });
    }

    // We need the original Shopify order data - try to fetch from Shopify
    const storesData = loadStores();
    const store = storesData.stores[order.storeId];

    if (!store || !store.shopify?.shop) {
      return res.json({ success: false, error: 'Store not connected to Shopify' });
    }

    const accessToken = await getShopifyAccessToken(store.shopify.shop, getStoreCredentials(store));

    const shopifyResponse = await axios.get(
      `https://${store.shopify.shop}/admin/api/2024-01/orders/${order.shopifyOrderId}.json`,
      { headers: { 'X-Shopify-Access-Token': accessToken } }
    );

    const shopifyOrder = shopifyResponse.data.order;

    // Retry CJ order creation
    const cjResult = await createCJOrder(shopifyOrder, store.id);

    order.status = 'submitted';
    order.cjOrderId = cjResult.cjOrderId;
    order.cjOrderNumber = cjResult.cjOrderNumber;
    order.submittedAt = new Date().toISOString();
    order.error = null;
    order.retriedAt = new Date().toISOString();

    ordersDb.stats.failed--;
    ordersDb.stats.fulfilled++;
    saveOrders(ordersDb);

    console.log(`✅ Order retry successful: ${cjResult.cjOrderNumber}`);
    res.json({ success: true, order, cjResult });

  } catch (e) {
    console.error('❌ Retry error:', e.message);
    res.json({ success: false, error: e.message });
  }
});

// Toggle auto-order for a store
app.post('/api/stores/:storeId/auto-order', (req, res) => {
  try {
    const { storeId } = req.params;
    const { enabled } = req.body;

    const stores = loadStores();
    const store = stores.stores[storeId];

    if (!store) {
      return res.json({ success: false, error: 'Store not found' });
    }

    store.autoOrderEnabled = !!enabled;
    saveStores(stores);

    console.log(`${enabled ? '✅' : '⛔'} Auto-order ${enabled ? 'enabled' : 'disabled'} for ${store.name}`);
    res.json({ success: true, autoOrderEnabled: store.autoOrderEnabled });

  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Link store product(s) to a CJ supplier so auto-fulfillment can place orders.
// Without :productHash, auto-links every CJ-unlinked product in the store by title search.
app.post('/api/stores/:storeId/cj-link', async (req, res) => {
  try {
    const { storeId } = req.params;
    const { productHash } = req.body || {};
    const config = loadConfig();
    if (!config.cjApiKey) return res.json({ success: false, error: 'CJ API key not configured' });

    const storesData = loadStores();
    const store = storesData.stores[storeId];
    if (!store) return res.json({ success: false, error: 'Store not found' });

    const accessToken = await getCJAccessToken();
    const targets = productHash
      ? [store.products?.[productHash]].filter(Boolean)
      : Object.values(store.products || {}).filter(p => !p.cjProductId);

    if (targets.length === 0) return res.json({ success: true, linked: 0, message: 'Nothing to link' });

    const results = [];
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    for (const product of targets) {
      try {
        // CJ rate-limits aggressively (~1 req/s); space out requests
        if (results.length > 0) await sleep(1200);
        // Search CJ by the product's key terms
        const terms = (product.title || '').toLowerCase().replace(/[^\w\s]/g, ' ')
          .split(' ').filter(w => w.length > 2 && !['the','and','for','with','new','hot','sale'].includes(w))
          .slice(0, 5).join(' ');

        const search = await axios.get(
          'https://developers.cjdropshipping.com/api2.0/v1/product/listV2',
          { params: { keyWord: terms, page: 1, size: 5, countryCode: 'US', orderBy: 0 },
            headers: { 'CJ-Access-Token': accessToken } }
        );
        const list = search.data?.data?.content?.[0]?.productList || [];
        if (!list.length) { results.push({ title: product.title, linked: false, reason: 'no CJ match' }); continue; }

        const best = list[0];
        product.cjProductId = best.id;
        product.cjSourceUrl = `https://cjdropshipping.com/product/${best.id}.html`;

        // Resolve a concrete variant now so order time is fast and validated
        try {
          const resolved = await resolveCjVariant(best.id, accessToken);
          product.cjVariantId = resolved.vid;
          product.cjUnitCost = resolved.price;
        } catch (_) { /* vid resolved lazily at order time */ }

        results.push({ title: product.title, linked: true, cjProductId: best.id, cjVariantId: product.cjVariantId || null, cjCost: product.cjUnitCost || null });
      } catch (e) {
        results.push({ title: product.title, linked: false, reason: e.message });
      }
    }

    saveStores(storesData);
    res.json({ success: true, linked: results.filter(r => r.linked).length, total: targets.length, results });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Simulate an order locally to verify the Shopify -> CJ fulfillment path.
// Dry-run by default (no real CJ order); pass { submit: true } to actually place it.
app.post('/api/orders/simulate', async (req, res) => {
  try {
    const { storeId, lineItems, shipping, submit = false } = req.body || {};
    if (!storeId) return res.json({ success: false, error: 'storeId required' });

    const store = loadStores().stores[storeId];
    if (!store) return res.json({ success: false, error: 'Store not found' });

    // Default to the store's CJ-linked products if no line items provided
    let items = lineItems;
    if (!items || !items.length) {
      items = Object.values(store.products || {})
        .filter(p => p.cjProductId)
        .slice(0, 3)
        .map(p => ({ product_id: p.shopifyProductId, title: p.title, quantity: 1 }));
    }
    if (!items.length) {
      return res.json({ success: false, error: 'No CJ-linked products in this store. Run /api/stores/:id/cj-link first.' });
    }

    const fakeOrder = {
      id: 'SIM-' + Date.now().toString(36),
      order_number: 'SIM',
      line_items: items,
      shipping_address: shipping || {
        first_name: 'Test', last_name: 'Buyer', address1: '1 Test St',
        city: 'Miami', province: 'FL', zip: '33101',
        country: 'United States', country_code: 'US', phone: '3050000000'
      }
    };

    const result = await createCJOrder(fakeOrder, storeId, { dryRun: !submit });
    res.json({ success: true, mode: submit ? 'submitted' : 'dry-run', ...result });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Configure webhook secret
app.post('/api/shopify/webhook-secret', (req, res) => {
  try {
    const { secret, storeId } = req.body;
    if (storeId) {
      // Per-store secret (each store's Settings → Notifications webhook has its own)
      const stores = loadStores();
      const store = stores.stores[storeId];
      if (!store) return res.json({ success: false, error: 'Store not found' });
      if (!store.shopify) store.shopify = {};
      store.shopify.webhookSecret = secret;
      saveStores(stores);
      return res.json({ success: true, scope: 'store', storeId });
    }
    const config = loadConfig();
    config.shopifyWebhookSecret = secret;
    saveConfig(config);
    res.json({ success: true, scope: 'global' });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Get webhook setup instructions
app.get('/api/shopify/webhook-setup', (req, res) => {
  const config = loadConfig();
  res.json({
    hasSecret: !!config.shopifyWebhookSecret,
    webhookUrl: `/api/webhooks/shopify/orders/create`,
    instructions: [
      '1. Go to your Shopify Admin → Settings → Notifications → Webhooks',
      '2. Click "Create webhook"',
      '3. Event: "Order creation"',
      '4. Format: JSON',
      `5. URL: https://YOUR_DOMAIN/api/webhooks/shopify/orders/create`,
      '6. Copy the webhook signing secret and save it in Settings'
    ]
  });
});

// ================== COMPETITOR ANALYSIS ==================

// Analyze competition for a product (Amazon, saturation, etc.)
app.post('/api/competitor-analysis', async (req, res) => {
  try {
    const { product } = req.body;

    if (!product || !product.title) {
      return res.json({ success: false, error: 'Product data required' });
    }

    const memory = loadMemory();
    const hash = hashProduct(product);

    // Check cache (12 hour TTL)
    const cached = memory.competitorCache?.[hash];
    const CACHE_TTL = 1000 * 60 * 60 * 12; // 12 hours

    if (cached && Date.now() - new Date(cached.lastChecked).getTime() < CACHE_TTL) {
      return res.json({
        success: true,
        ...cached,
        fromCache: true
      });
    }

    console.log(`\n🔍 Analyzing competition for: "${product.title.substring(0, 40)}..."`);

    // Generate search terms
    const searchTerms = product.title.toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(' ')
      .filter(w => w.length > 2 && !['the', 'and', 'for', 'with', 'new'].includes(w))
      .slice(0, 5)
      .join(' ');

    let competitorData = {
      productTitle: product.title,
      searchTerms,
      amazonPresent: false,
      amazonPrice: null,
      sellerCount: 0,
      saturationLevel: 'unknown',
      saturationScore: 50,
      competitors: [],
      recommendation: '',
      lastChecked: new Date().toISOString()
    };

    const apify = getApify();

    if (apify) {
      try {
        // Try to search Amazon via Apify
        console.log('   🔎 Checking Amazon...');

        const run = await apify.actor('junglee/free-amazon-product-scraper').call({
          keyword: searchTerms,
          countryCode: 'US',
          maxItems: 20
        }, { timeout: 120000 });

        const { items } = await apify.dataset(run.defaultDatasetId).listItems();

        if (items && items.length > 0) {
          competitorData.amazonPresent = true;
          competitorData.sellerCount = items.length;

          // Get prices
          const prices = items
            .map(i => parseFloat(i.price?.replace(/[^0-9.]/g, '') || 0))
            .filter(p => p > 0);

          if (prices.length > 0) {
            competitorData.amazonPrice = {
              min: Math.min(...prices),
              max: Math.max(...prices),
              avg: parseFloat((prices.reduce((a, b) => a + b, 0) / prices.length).toFixed(2))
            };
          }

          // Store top competitors
          competitorData.competitors = items.slice(0, 5).map(i => ({
            title: i.title,
            price: i.price,
            rating: i.rating,
            reviews: i.reviews,
            url: i.url
          }));
        }

      } catch (amazonError) {
        console.log('   ⚠️ Amazon check failed:', amazonError.message);
      }
    }

    // Calculate saturation score based on available data
    const sellerCount = competitorData.sellerCount;

    if (sellerCount === 0) {
      competitorData.saturationLevel = 'unknown';
      competitorData.saturationScore = 50;
      competitorData.recommendation = 'Unable to verify competition. Manually check Amazon and other marketplaces.';
    } else if (sellerCount <= 10) {
      competitorData.saturationLevel = 'low';
      competitorData.saturationScore = 85;
      competitorData.recommendation = 'Low competition! Great opportunity for market entry.';
    } else if (sellerCount <= 30) {
      competitorData.saturationLevel = 'medium';
      competitorData.saturationScore = 60;
      competitorData.recommendation = 'Moderate competition. Focus on differentiation and unique marketing angles.';
    } else if (sellerCount <= 70) {
      competitorData.saturationLevel = 'high';
      competitorData.saturationScore = 35;
      competitorData.recommendation = 'High competition. Need strong USP and marketing budget to compete.';
    } else {
      competitorData.saturationLevel = 'saturated';
      competitorData.saturationScore = 15;
      competitorData.recommendation = 'Highly saturated market. Consider finding a less competitive alternative.';
    }

    // Add price comparison if we have both TikTok and Amazon prices
    if (product.price && competitorData.amazonPrice) {
      const priceDiff = ((competitorData.amazonPrice.avg - product.price) / product.price * 100).toFixed(1);
      competitorData.priceComparison = {
        tiktokPrice: product.price,
        amazonAvgPrice: competitorData.amazonPrice.avg,
        difference: parseFloat(priceDiff),
        analysis: priceDiff > 20 ? 'Amazon priced higher - good margin potential' :
                  priceDiff < -20 ? 'Amazon priced lower - pricing pressure' :
                  'Similar pricing across platforms'
      };
    }

    // Cache result
    if (!memory.competitorCache) memory.competitorCache = {};
    memory.competitorCache[hash] = competitorData;
    saveMemory(memory);

    console.log(`   ✅ Saturation: ${competitorData.saturationLevel} (${competitorData.sellerCount} sellers)`);

    res.json({ success: true, ...competitorData });

  } catch (e) {
    console.error('❌ Competitor analysis error:', e.message);
    res.json({ success: false, error: e.message });
  }
});

// Quick saturation check (uses cached data or estimates)
app.get('/api/saturation/:productHash', (req, res) => {
  try {
    const { productHash } = req.params;
    const memory = loadMemory();

    const cached = memory.competitorCache?.[productHash];

    if (cached) {
      return res.json({
        success: true,
        saturationLevel: cached.saturationLevel,
        saturationScore: cached.saturationScore,
        sellerCount: cached.sellerCount,
        lastChecked: cached.lastChecked,
        fromCache: true
      });
    }

    // No cached data - return unknown
    res.json({
      success: true,
      saturationLevel: 'unknown',
      saturationScore: 50,
      sellerCount: 0,
      note: 'Run competitor analysis for detailed data'
    });

  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ================== AI PRODUCT RECOMMENDATIONS ==================

// Weighted random selection - prioritizes higher-weight niches
function selectWeightedNiches(niches, count) {
  const selected = [];
  const available = [...niches];

  for (let i = 0; i < count && available.length > 0; i++) {
    // Calculate total weight
    const totalWeight = available.reduce((sum, n) => sum + n.weight, 0);

    // Random selection based on weight
    let random = Math.random() * totalWeight;
    let selectedIndex = 0;

    for (let j = 0; j < available.length; j++) {
      random -= available[j].weight;
      if (random <= 0) {
        selectedIndex = j;
        break;
      }
    }

    selected.push(available[selectedIndex]);
    available.splice(selectedIndex, 1); // Remove to avoid duplicates
  }

  return selected;
}

// Process raw TikTok Shop item into standardized format
function processShopItem(item, category, nicheTags) {
  // Extract price from nested structure
  let price = 0;
  if (item.product_price_info) {
    const priceStr = item.product_price_info.sale_price_decimal ||
                     item.product_price_info.sale_price_format ||
                     item.product_price_info.min_price ||
                     item.product_price_info.price || '0';

    // Handle different currency formats
    if (item.product_price_info.currency_name === 'VND') {
      const priceNum = parseFloat(priceStr.replace(/\./g, ''));
      price = priceNum / 25000;
    } else if (item.product_price_info.currency_name === 'USD' || item.product_price_info.currency_symbol === '$') {
      price = parseFloat(priceStr.replace(/,/g, ''));
    } else {
      price = parseFloat(priceStr.replace(/[^0-9.]/g, ''));
    }
  } else if (item.price) {
    price = item.price / 100;
  } else if (item.min_price) {
    price = parseFloat(item.min_price);
  }

  // Extract sold count
  let sold = 0;
  if (item.sold_info) {
    sold = parseInt(item.sold_info.sold_count || item.sold_info.sales || 0);
  } else {
    sold = item.sold_count || item.sales || 0;
  }

  // Extract rating
  let rating = 0;
  if (item.rate_info) {
    rating = parseFloat(item.rate_info.average_rating || item.rate_info.rating || 0);
  }

  // Extract image URL - handle different formats including nested objects
  let imageUrl = '';

  // Try direct string properties first
  if (typeof item.product_img_url === 'string' && item.product_img_url) {
    imageUrl = item.product_img_url;
  } else if (typeof item.cover === 'string' && item.cover) {
    imageUrl = item.cover;
  } else if (typeof item.cover_url === 'string' && item.cover_url) {
    imageUrl = item.cover_url;
  }
  // Handle image as object (common TikTok Shop structure)
  else if (item.image && typeof item.image === 'object') {
    // Try common object structures
    imageUrl = item.image.url || item.image.url_list?.[0] || item.image.thumb?.url ||
               item.image.cover || item.image.origin?.url || item.image.src || '';
  }
  // Handle image as string
  else if (typeof item.image === 'string' && item.image) {
    imageUrl = item.image;
  }
  // Handle images array
  else if (item.images && Array.isArray(item.images) && item.images.length > 0) {
    const firstImg = item.images[0];
    imageUrl = typeof firstImg === 'string' ? firstImg : (firstImg?.url || firstImg?.url_list?.[0] || '');
  }
  // Handle product_images array
  else if (item.product_images && Array.isArray(item.product_images) && item.product_images.length > 0) {
    const firstImg = item.product_images[0];
    imageUrl = typeof firstImg === 'string' ? firstImg : (firstImg?.url || '');
  }
  // Handle thumb/thumbnail
  else if (item.thumb && typeof item.thumb === 'string') {
    imageUrl = item.thumb;
  } else if (item.thumbnail && typeof item.thumbnail === 'string') {
    imageUrl = item.thumbnail;
  }

  // Extract review count
  const reviewCount = item.rate_info?.review_count || item.review_count || 0;

  // Calculate engagement score based on actual shop metrics
  // High sold count + good reviews = high engagement potential
  let engagementScore = 0;
  if (sold > 1000) engagementScore += 50;
  else if (sold > 500) engagementScore += 40;
  else if (sold > 100) engagementScore += 30;
  else if (sold > 50) engagementScore += 20;
  else if (sold > 10) engagementScore += 10;

  if (rating >= 4.5) engagementScore += 30;
  else if (rating >= 4.0) engagementScore += 20;
  else if (rating >= 3.5) engagementScore += 10;

  if (reviewCount > 100) engagementScore += 20;
  else if (reviewCount > 50) engagementScore += 15;
  else if (reviewCount > 10) engagementScore += 10;

  return {
    title: item.product_name || item.title || 'No title',
    image: imageUrl,
    // Use sold count as primary "views" metric (indicates demand)
    views: sold, // Repurposed: shows demand/popularity
    likes: reviewCount, // Repurposed: shows customer engagement
    sold: sold,
    price: price,
    rating: rating,
    reviewCount: reviewCount,
    // Engagement is now based on sales velocity + reviews + rating
    engagement: Math.min(100, engagementScore).toFixed(1),
    category: category,
    tags: nicheTags || [],
    shopName: item.seller_info?.shop_name || item.shop_name || '',
    rawData: item
  };
}

// Get automated product recommendations - ENHANCED VERSION
app.get('/api/recommendations', async (req, res) => {
  try {
    console.log('\n🤖 ========== GENERATING PRODUCT RECOMMENDATIONS ==========');

    // Check if user selected specific niches
    const { niches, keywords, mode } = req.query;
    let selectedNiches;
    let isCustomNicheSearch = false;
    let targetNicheIds = [];

    if (keywords) {
      // User selected specific niches - use their keywords
      isCustomNicheSearch = true;
      const keywordList = keywords.split(',').map(k => k.trim()).filter(k => k);
      targetNicheIds = niches ? niches.split(',') : [];

      console.log(`🎯 Custom niche search (${mode || 'single'} mode):`);
      console.log(`   Niches: ${targetNicheIds.join(', ')}`);
      console.log(`   Keywords: ${keywordList.slice(0, 8).join(', ')}${keywordList.length > 8 ? '...' : ''}`);

      // In single mode, use more keywords from the same niche for variety
      // In multi mode, spread keywords across niches
      const searchCount = mode === 'single' ? Math.min(6, keywordList.length) : Math.min(4, keywordList.length);

      // Shuffle and pick keywords for search variety
      const shuffled = keywordList.sort(() => Math.random() - 0.5);
      selectedNiches = shuffled.slice(0, searchCount).map(kw => ({
        query: kw,
        weight: 10,
        tags: targetNicheIds
      }));
    } else {
      // Default: weighted random selection
      console.log('📋 Using weighted niche selection for higher-quality results\n');
      selectedNiches = selectWeightedNiches(WINNING_NICHES, 4);
    }

    console.log('🎯 Selected search terms:');
    selectedNiches.forEach(n => console.log(`   - "${n.query}" (weight: ${n.weight})`));

    // Fetch products from TikTok Shop for each niche
    const allProducts = [];

    for (const niche of selectedNiches) {
      try {
        console.log(`\n📦 Fetching: "${niche.query}"...`);

        const data = await scrapecreators('/v1/tiktok/shop/search', {
          query: niche.query,
          region: 'US' // Target US market
        });

        const items = data.products || data.data || [];
        console.log(`   Found ${items.length} raw items`);

        // Process items (take more to have better filtering)
        const processed = items.slice(0, 12).map(item =>
          processShopItem(item, niche.query, niche.tags)
        );

        // Filter for English products only
        const englishProducts = processed.filter(p => isEnglish(p.title));

        // Debug: log prices and images to understand the data
        if (englishProducts.length > 0) {
          console.log(`   💰 Sample prices: ${englishProducts.slice(0, 3).map(p => '$' + p.price.toFixed(2)).join(', ')}`);
          console.log(`   🖼️ Sample images: ${englishProducts.slice(0, 2).map(p => p.image ? '✅' : '❌').join(', ')}`);
        }

        // Debug first item's raw image data
        if (items.length > 0) {
          const sample = items[0];
          console.log(`   📷 Raw image keys: product_img_url=${typeof sample.product_img_url}, image=${typeof sample.image}, cover=${typeof sample.cover}`);
          // If image is an object, show its keys
          if (sample.image && typeof sample.image === 'object') {
            console.log(`   📷 Image object keys: ${Object.keys(sample.image).join(', ')}`);
            // Show first URL-like value
            const imgObj = sample.image;
            const possibleUrl = imgObj.url || imgObj.url_list?.[0] || imgObj.thumb?.url || imgObj.cover || imgObj.src;
            console.log(`   📷 Extracted URL: ${possibleUrl ? possibleUrl.substring(0, 60) + '...' : 'NONE'}`);
          }
        }

        // Don't filter by price here - let the scoring algorithm handle it
        // This ensures we get products to analyze even if prices are unusual
        allProducts.push(...englishProducts);
      } catch (e) {
        console.error(`   ❌ Failed: ${e.message}`);
      }
    }

    console.log(`\n📊 Total raw products: ${allProducts.length}`);

    if (allProducts.length === 0) {
      return res.json({
        success: false,
        error: 'No products found. Check your ScrapeCreators API key or try again.'
      });
    }

    // ENHANCED FILTERING - Be more permissive, let scoring handle quality
    const validProducts = allProducts
      .filter(p => {
        // Only filter out products with no price or extreme prices
        if (p.price <= 0) return false;
        if (p.price > 500) return false; // Likely parsing error
        return true;
      });

    console.log(`📊 After basic filtering (price > 0, < 500): ${validProducts.length} products`);

    // Debug: show price distribution
    if (validProducts.length > 0) {
      const prices = validProducts.map(p => p.price).sort((a, b) => a - b);
      console.log(`📊 Price range: $${prices[0].toFixed(2)} - $${prices[prices.length-1].toFixed(2)}`);
    }

    // Remove duplicates by title similarity
    const uniqueProducts = [];
    const seenTitles = new Set();

    for (const p of validProducts) {
      const normalizedTitle = p.title.toLowerCase().replace(/[^a-z0-9]/g, '').substring(0, 30);
      if (!seenTitles.has(normalizedTitle)) {
        seenTitles.add(normalizedTitle);
        uniqueProducts.push(p);
      }
    }

    console.log(`📊 After deduplication: ${uniqueProducts.length} products`);

    // ========== GOOGLE TRENDS VALIDATION ==========
    // Check if the niche categories are trending on Google
    const nicheKeywords = selectedNiches.map(n => n.query);
    const trendsData = await batchCheckTrends(nicheKeywords);

    // Add margins, sourcing, and trends data to each product
    const productsWithAnalysis = uniqueProducts.map(p => {
      // Find the trend data for this product's category
      const categoryTrend = trendsData[p.category.toLowerCase()] || { direction: 'unknown', score: 50 };

      // Apply trend bonus/penalty to help scoring
      let trendBonus = 0;
      if (categoryTrend.direction === 'rising') {
        trendBonus = 15; // Boost rising trends
      } else if (categoryTrend.direction === 'declining') {
        trendBonus = -10; // Penalize declining trends
      }

      return {
        ...p,
        margins: calculateMargins(p.price),
        sourcing: getSourcingRecommendations(p.title),
        googleTrends: categoryTrend,
        trendBonus: trendBonus
      };
    });

    // Analyze with AI (includes algorithmic scoring)
    console.log('\n🧠 Running AI + algorithmic analysis...');
    const analyzedProducts = await analyzeProductsWithAI(productsWithAnalysis);

    // ========== APPLY MACHINE LEARNING ==========
    console.log('🤖 Applying learned preferences...');
    const learnedProducts = applyLearnedScores(analyzedProducts);

    // Sort by ADJUSTED score (includes learning bonus)
    const sortedProducts = learnedProducts
      .sort((a, b) => (b.adjustedScore || b.aiScore) - (a.adjustedScore || a.aiScore))
      .slice(0, 20); // Top 20 products

    // Separate products by verdict for easier consumption
    const strongBuys = sortedProducts.filter(p => p.verdict === 'STRONG BUY');
    const worthTesting = sortedProducts.filter(p => p.verdict === 'WORTH TESTING');
    const risky = sortedProducts.filter(p => p.verdict === 'RISKY' || !p.verdict);
    const skip = sortedProducts.filter(p => p.verdict === 'SKIP');

    // Count returning vs new products
    const returningCount = sortedProducts.filter(p => p.returningProduct).length;
    const newCount = sortedProducts.filter(p => p.isNew).length;

    console.log(`\n📈 Results breakdown:`);
    console.log(`   🟢 STRONG BUY: ${strongBuys.length}`);
    console.log(`   🟡 WORTH TESTING: ${worthTesting.length}`);
    console.log(`   🟠 RISKY: ${risky.length}`);
    console.log(`   🔴 SKIP: ${skip.length}`);
    console.log(`   🔄 Returning: ${returningCount} | ✨ New: ${newCount}`);

    // Get trending niches with enhanced stats
    const nicheStats = {};
    sortedProducts.forEach(p => {
      if (!nicheStats[p.category]) {
        nicheStats[p.category] = {
          category: p.category,
          count: 0,
          avgScore: 0,
          totalSales: 0,
          strongBuys: 0,
          tags: p.tags || []
        };
      }
      nicheStats[p.category].count++;
      nicheStats[p.category].avgScore += p.aiScore;
      nicheStats[p.category].totalSales += p.sold || 0;
      if (p.verdict === 'STRONG BUY') nicheStats[p.category].strongBuys++;
    });

    const trendingNiches = Object.values(nicheStats).map(n => ({
      ...n,
      avgScore: Math.round(n.avgScore / n.count)
    })).sort((a, b) => b.avgScore - a.avgScore);

    // ========== RECORD PRICES & SESSION & GET HISTORICAL COMPARISON ==========
    // Record price history for all products
    recordPrices(sortedProducts);

    const sessionInfo = recordSession(sortedProducts, trendingNiches);
    const historicalComparison = getHistoricalComparison(sortedProducts);

    // Add price trend data to products
    sortedProducts.forEach(p => {
      const hash = hashProduct(p);
      p.priceHistory = getPriceTrend(hash);
    });

    console.log('\n✅ Recommendation generation complete!');
    console.log(`📚 Session recorded: ${sessionInfo.sessionId}`);
    if (!historicalComparison.isFirstSession) {
      console.log(`📊 Comparison: ${historicalComparison.comparison.trend} (${historicalComparison.comparison.scoreDelta > 0 ? '+' : ''}${historicalComparison.comparison.scoreDelta} avg score)`);
    }
    console.log('');

    res.json({
      success: true,
      products: sortedProducts,
      summary: {
        strongBuys: strongBuys.length,
        worthTesting: worthTesting.length,
        risky: risky.length,
        skip: skip.length,
        topPick: strongBuys[0] || worthTesting[0] || sortedProducts[0],
        returningProducts: returningCount,
        newProducts: newCount
      },
      niches: trendingNiches,
      totalProducts: sortedProducts.length,
      searchedNiches: selectedNiches.map(n => n.query),
      // Custom niche search info
      isCustomNicheSearch,
      targetNicheIds,
      searchMode: mode || 'auto',
      timestamp: new Date().toISOString(),
      // Machine Learning Data
      session: sessionInfo,
      historicalComparison,
      learningEnabled: true
    });

  } catch (e) {
    console.error('❌ Recommendation error:', e.message);
    res.json({ success: false, error: e.message });
  }
});

// Basic product analysis (quick)
app.post('/api/analyze-product', async (req, res) => {
  try {
    const { product } = req.body;

    if (!product || !product.price) {
      return res.json({ success: false, error: 'Invalid product data' });
    }

    const margins = calculateMargins(product.price);
    const sourcing = getSourcingRecommendations(product.title);

    res.json({
      success: true,
      margins,
      sourcing
    });

  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ================== DEEP AI PRODUCT ANALYSIS ==================

// Deep AI-powered product analysis with specific sourcing recommendations
app.post('/api/deep-analyze', async (req, res) => {
  try {
    const { product } = req.body;

    if (!product || !product.title) {
      return res.json({ success: false, error: 'Product data required' });
    }

    console.log(`\n🔬 Deep analyzing: "${product.title.substring(0, 50)}..."`);

    // ========== RECORD INTEREST IN LEARNING SYSTEM ==========
    recordInterest(product);
    console.log('📚 Interest recorded in learning system');

    const analysis = await deepAnalyzeProduct(product);

    if (analysis.success) {
      console.log(`✅ Deep analysis complete (${analysis.tokensUsed} tokens used)`);

      // ========== FEED ANALYSIS RESULTS BACK INTO MEMORY ==========
      const memory = loadMemory();
      const hash = hashProduct(product);

      // Store deep analysis results for future reference
      if (!memory.deepAnalysisResults) memory.deepAnalysisResults = {};
      memory.deepAnalysisResults[hash] = {
        title: product.title,
        analyzedAt: new Date().toISOString(),
        isWinner: analysis.productAnalysis?.isWinner,
        confidence: analysis.productAnalysis?.confidence,
        recommendedSupplier: analysis.sourcingStrategy?.recommendedSupplier,
        suggestedPrice: analysis.pricingStrategy?.suggestedRetailPrice,
        targetAudience: analysis.marketingStrategy?.targetAudience?.demographics,
        overallRisk: analysis.riskAssessment?.overallRisk
      };

      // Update category score based on AI verdict
      const cat = product.category || 'unknown';
      if (memory.categoryScores[cat]) {
        if (analysis.productAnalysis?.isWinner) {
          memory.categoryScores[cat].score = Math.min(100, memory.categoryScores[cat].score + 10);
          memory.categoryScores[cat].winners = (memory.categoryScores[cat].winners || 0) + 1;
        }
      }

      saveMemory(memory);
    } else {
      console.log(`⚠️ Deep analysis failed: ${analysis.error}`);
    }

    res.json(analysis);

  } catch (e) {
    console.error('❌ Deep analysis error:', e.message);
    res.json({ success: false, error: e.message });
  }
});

// Batch deep analysis for multiple products
app.post('/api/deep-analyze-batch', async (req, res) => {
  try {
    const { products, maxProducts = 5 } = req.body;

    if (!products || !Array.isArray(products)) {
      return res.json({ success: false, error: 'Products array required' });
    }

    console.log(`\n🔬 Batch deep analyzing ${Math.min(products.length, maxProducts)} products...`);

    const results = [];
    const toAnalyze = products.slice(0, maxProducts);

    for (const product of toAnalyze) {
      try {
        const analysis = await deepAnalyzeProduct(product);
        results.push(analysis);

        // Small delay between requests to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (e) {
        results.push({
          success: false,
          product: { title: product.title },
          error: e.message
        });
      }
    }

    const successful = results.filter(r => r.success);
    console.log(`✅ Batch complete: ${successful.length}/${results.length} successful`);

    res.json({
      success: true,
      analyzed: results.length,
      successful: successful.length,
      results
    });

  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ================== HISTORY & MEMORY API ==================

// Get recommendation history
app.get('/api/history', (req, res) => {
  try {
    const history = loadHistory();
    const { limit = 20 } = req.query;

    res.json({
      success: true,
      totalSessions: history.sessions.length,
      totalRecommendations: history.totalRecommendations,
      firstSession: history.firstSession,
      lastSession: history.lastSession,
      recentSessions: history.sessions.slice(0, parseInt(limit))
    });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Get learning memory/preferences
app.get('/api/memory', (req, res) => {
  try {
    const memory = loadMemory();

    // Calculate top products by frequency
    const topProducts = Object.entries(memory.productFrequency)
      .map(([hash, data]) => ({ hash, ...data }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    // Calculate top categories
    const topCategories = Object.entries(memory.categoryScores)
      .map(([cat, data]) => ({ category: cat, ...data }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 10);

    res.json({
      success: true,
      learningStats: memory.learningStats,
      pricePreferences: memory.pricePreferences,
      topProducts,
      topCategories,
      interestedProducts: memory.interestedProducts.slice(0, 10),
      deepAnalysisCount: Object.keys(memory.deepAnalysisResults || {}).length,
      totalProductsTracked: Object.keys(memory.productFrequency).length
    });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Get specific session details
app.get('/api/history/:sessionId', (req, res) => {
  try {
    const history = loadHistory();
    const session = history.sessions.find(s => s.id === req.params.sessionId);

    if (!session) {
      return res.json({ success: false, error: 'Session not found' });
    }

    res.json({ success: true, session });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Compare two sessions
app.get('/api/history/compare/:session1/:session2', (req, res) => {
  try {
    const history = loadHistory();
    const s1 = history.sessions.find(s => s.id === req.params.session1);
    const s2 = history.sessions.find(s => s.id === req.params.session2);

    if (!s1 || !s2) {
      return res.json({ success: false, error: 'One or both sessions not found' });
    }

    const s1Hashes = new Set(s1.topProducts.map(p => p.hash));
    const s2Hashes = new Set(s2.topProducts.map(p => p.hash));

    const common = s1.topProducts.filter(p => s2Hashes.has(p.hash));
    const onlyInS1 = s1.topProducts.filter(p => !s2Hashes.has(p.hash));
    const onlyInS2 = s2.topProducts.filter(p => !s1Hashes.has(p.hash));

    res.json({
      success: true,
      session1: { id: s1.id, date: s1.date, avgScore: s1.avgScore },
      session2: { id: s2.id, date: s2.date, avgScore: s2.avgScore },
      scoreDelta: s2.avgScore - s1.avgScore,
      commonProducts: common,
      uniqueToSession1: onlyInS1,
      uniqueToSession2: onlyInS2,
      overlapPercentage: Math.round((common.length / Math.max(s1.topProducts.length, s2.topProducts.length)) * 100)
    });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ================== PRICE HISTORY API ==================

// Get price history for a product
app.get('/api/price-history/:productHash', (req, res) => {
  try {
    const { productHash } = req.params;
    const history = getPriceHistory(productHash);
    const trend = getPriceTrend(productHash);

    res.json({
      success: true,
      productHash,
      history,
      trend,
      hasHistory: history.length > 0
    });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Get price history for multiple products
app.post('/api/price-history/batch', (req, res) => {
  try {
    const { productHashes } = req.body;

    if (!productHashes || !Array.isArray(productHashes)) {
      return res.json({ success: false, error: 'productHashes array required' });
    }

    const results = {};
    productHashes.forEach(hash => {
      results[hash] = {
        history: getPriceHistory(hash),
        trend: getPriceTrend(hash)
      };
    });

    res.json({ success: true, results });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Get all products with significant price changes
app.get('/api/price-alerts', (req, res) => {
  try {
    const memory = loadMemory();
    const threshold = parseFloat(req.query.threshold) || 10; // Default 10% change

    const alerts = [];

    Object.entries(memory.priceHistory || {}).forEach(([hash, history]) => {
      if (history.length >= 2) {
        const trend = getPriceTrend(hash);

        if (Math.abs(trend.change) >= threshold) {
          const productInfo = memory.productFrequency[hash];
          alerts.push({
            productHash: hash,
            title: productInfo?.title || 'Unknown Product',
            category: productInfo?.category || 'Unknown',
            ...trend,
            alertType: trend.change > 0 ? 'price_increase' : 'price_decrease'
          });
        }
      }
    });

    // Sort by absolute change
    alerts.sort((a, b) => Math.abs(b.change) - Math.abs(a.change));

    res.json({
      success: true,
      threshold,
      alertCount: alerts.length,
      alerts: alerts.slice(0, 20) // Top 20 alerts
    });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Clear history (reset learning)
app.delete('/api/history', (req, res) => {
  try {
    fs.writeFileSync(HISTORY_PATH, JSON.stringify({
      sessions: [],
      totalRecommendations: 0,
      firstSession: null,
      lastSession: null
    }, null, 2));

    fs.writeFileSync(MEMORY_PATH, JSON.stringify({
      productFrequency: {},
      categoryScores: {},
      pricePreferences: { min: 10, max: 50, sweetSpot: 25, interactions: [] },
      interestedProducts: [],
      trendingPatterns: {},
      priceHistory: {},
      supplierPriceCache: {},
      competitorCache: {},
      deepAnalysisResults: {},
      learningStats: { totalInteractions: 0, lastUpdated: null, modelVersion: '2.0' }
    }, null, 2));

    console.log('🗑️ History and memory cleared');
    res.json({ success: true, message: 'History and learning memory cleared' });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ================== UNIFIED FULL ANALYSIS ==================

// Single endpoint that runs all analyses in parallel and returns unified results
app.post('/api/full-analysis', async (req, res) => {
  try {
    const { product } = req.body;

    if (!product || !product.title) {
      return res.json({ success: false, error: 'Product data required' });
    }

    console.log(`\n🔬 ========== FULL ANALYSIS: "${product.title.substring(0, 40)}..." ==========`);

    const startTime = Date.now();

    // Run all analyses in parallel for speed
    const [deepAnalysisResult, supplierResult, competitorResult, contentResult] = await Promise.allSettled([
      // 1. Deep AI Analysis (GPT-4)
      (async () => {
        const openai = getOpenAI();
        if (!openai) return { skipped: true, reason: 'No OpenAI key' };

        try {
          const analysisRes = await fetch(`http://localhost:${PORT}/api/deep-analyze`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ product })
          });
          return await analysisRes.json();
        } catch (e) {
          return { error: e.message };
        }
      })(),

      // 2. Supplier Pricing (AliExpress via Apify)
      (async () => {
        try {
          const pricingRes = await fetch(`http://localhost:${PORT}/api/aliexpress/pricing`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ productTitle: product.title, productPrice: product.price })
          });
          return await pricingRes.json();
        } catch (e) {
          return { error: e.message };
        }
      })(),

      // 3. Competitor Analysis (Amazon)
      (async () => {
        try {
          const compRes = await fetch(`http://localhost:${PORT}/api/competitor-analysis`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ product })
          });
          return await compRes.json();
        } catch (e) {
          return { error: e.message };
        }
      })(),

      // 4. Marketing Content (Gemini)
      (async () => {
        try {
          const contentRes = await fetch(`http://localhost:${PORT}/api/generate-content-prompts`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ product })
          });
          return await contentRes.json();
        } catch (e) {
          return { error: e.message };
        }
      })()
    ]);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`✅ Full analysis completed in ${elapsed}s`);

    // Extract results (handle both fulfilled and rejected promises)
    const deepAnalysis = deepAnalysisResult.status === 'fulfilled' ? deepAnalysisResult.value : { error: 'Failed' };
    const supplierPricing = supplierResult.status === 'fulfilled' ? supplierResult.value : { error: 'Failed' };
    const competitorAnalysis = competitorResult.status === 'fulfilled' ? competitorResult.value : { error: 'Failed' };
    const marketingContent = contentResult.status === 'fulfilled' ? contentResult.value : { error: 'Failed' };

    // Build unified response
    res.json({
      success: true,
      product: {
        title: product.title,
        price: product.price,
        image: product.image
      },

      // Verdict (from deep analysis)
      verdict: deepAnalysis.success ? {
        isWinner: deepAnalysis.productAnalysis?.isWinner,
        confidence: deepAnalysis.productAnalysis?.confidence,
        recommendation: deepAnalysis.productAnalysis?.whyOrWhyNot,
        tier: deepAnalysis.productAnalysis?.isWinner ?
          (deepAnalysis.productAnalysis?.confidence >= 80 ? 'STRONG BUY' : 'WORTH TESTING') :
          (deepAnalysis.productAnalysis?.confidence >= 60 ? 'RISKY' : 'SKIP')
      } : null,

      // Sourcing (combined from deep analysis + supplier pricing)
      sourcing: {
        // Real prices from AliExpress (if available)
        realPrice: supplierPricing.success ? supplierPricing.realPrice || supplierPricing.estimatedPrice : null,
        priceRange: supplierPricing.success ? supplierPricing.priceRange : null,
        topSuppliers: supplierPricing.success ? supplierPricing.topSuppliers : [],
        // Strategy from AI
        strategy: deepAnalysis.success ? deepAnalysis.sourcingStrategy : null,
        // Direct links
        links: deepAnalysis.success ? deepAnalysis.searchQueries : {
          aliexpress: `https://www.aliexpress.com/wholesale?SearchText=${encodeURIComponent(product.title)}`,
          cjdropshipping: `https://cjdropshipping.com/search?keyword=${encodeURIComponent(product.title)}`,
          alibaba: `https://www.alibaba.com/trade/search?SearchText=${encodeURIComponent(product.title)}`
        }
      },

      // Competition
      competition: competitorAnalysis.success ? {
        amazonPresent: competitorAnalysis.amazonPresent,
        amazonPrice: competitorAnalysis.amazonPrice,
        sellerCount: competitorAnalysis.sellerCount,
        saturationLevel: competitorAnalysis.saturationLevel,
        saturationScore: competitorAnalysis.saturationScore,
        priceComparison: competitorAnalysis.priceComparison,
        recommendation: competitorAnalysis.recommendation
      } : null,

      // Pricing Strategy (from AI)
      pricing: deepAnalysis.success ? deepAnalysis.pricingStrategy : null,

      // Marketing (from AI + Gemini content)
      marketing: {
        strategy: deepAnalysis.success ? deepAnalysis.marketingStrategy : null,
        content: marketingContent.success ? marketingContent.prompts : null
      },

      // Risk Assessment
      risk: deepAnalysis.success ? deepAnalysis.riskAssessment : null,

      // Action Plan
      actionPlan: deepAnalysis.success ? deepAnalysis.actionPlan : null,

      // Meta
      analysisTime: elapsed + 's',
      timestamp: new Date().toISOString(),
      tokensUsed: deepAnalysis.tokensUsed || 0
    });

  } catch (e) {
    console.error('❌ Full analysis error:', e.message);
    res.json({ success: false, error: e.message });
  }
});

// ================== AI STORE TEMPLATE GENERATION ==================

// Template types with descriptions
const TEMPLATE_TYPES = {
  homepage: {
    name: 'Homepage Hero',
    description: 'Store landing page with hero section and featured products',
    sections: ['hero', 'featured-products', 'trust-badges', 'newsletter']
  },
  product: {
    name: 'Product Page',
    description: 'High-converting product detail page',
    sections: ['product-gallery', 'buy-box', 'description', 'reviews', 'related']
  },
  collection: {
    name: 'Collection Page',
    description: 'Category grid layout with filters',
    sections: ['collection-header', 'product-grid', 'filters', 'pagination']
  },
  landing: {
    name: 'Landing Page',
    description: 'Single-product promo/sales page',
    sections: ['hero', 'problem-solution', 'features', 'testimonials', 'cta', 'faq']
  }
};

// Get available template types
app.get('/api/templates/types', (req, res) => {
  res.json({ success: true, types: TEMPLATE_TYPES });
});

// Generate AI-powered Shopify Liquid template
app.post('/api/stores/:storeId/generate-template', async (req, res) => {
  try {
    const { templateType, productHashes, customPrompt } = req.body;
    const storeId = req.params.storeId;

    const stores = loadStores();
    const store = stores.stores[storeId];

    if (!store) {
      return res.json({ success: false, error: 'Store not found' });
    }

    const ai = getOpenAI();
    if (!ai) {
      return res.json({ success: false, error: 'OpenAI API key not configured' });
    }

    // Get products for context
    const products = productHashes
      ? productHashes.map(h => store.products[h]).filter(Boolean)
      : Object.values(store.products).slice(0, 5);

    if (products.length === 0) {
      return res.json({ success: false, error: 'No products found in store' });
    }

    const templateInfo = TEMPLATE_TYPES[templateType] || TEMPLATE_TYPES.homepage;

    console.log(`\n🎨 Generating ${templateInfo.name} template for ${store.name}...`);

    // Build context for GPT-4o
    const productContext = products.map(p => ({
      title: p.title,
      price: p.customPrice || p.originalPrice,
      category: p.category,
      image: p.image
    }));

    const prompt = `You are an expert Shopify theme developer. Generate a high-converting ${templateInfo.name} Liquid template.

STORE DETAILS:
- Store Name: ${store.name}
- Niche: ${store.nicheName || store.nicheId}
- Store Concept: ${store.storeIdea || 'General Store'}

PRODUCTS (${products.length} items):
${productContext.map((p, i) => `${i + 1}. "${p.title}" - $${p.price} (${p.category})`).join('\n')}

TEMPLATE TYPE: ${templateInfo.name}
SECTIONS TO INCLUDE: ${templateInfo.sections.join(', ')}

${customPrompt ? `ADDITIONAL REQUIREMENTS: ${customPrompt}` : ''}

REQUIREMENTS:
1. Use valid Shopify Liquid syntax
2. Mobile-first responsive design using Tailwind CSS classes
3. Include schema settings for Shopify customizer
4. High-converting elements:
   - Clear, benefit-focused headlines
   - Trust badges (secure checkout, money-back guarantee, fast shipping)
   - Urgency elements (limited stock, sale timers)
   - Social proof placeholders
   - Clear CTA buttons with contrasting colors
5. Clean, modern aesthetic
6. Fast-loading (no heavy scripts)

OUTPUT FORMAT:
Return ONLY valid Liquid code wrapped in a code block. Include:
1. The main section code
2. Schema JSON at the bottom for Shopify customizer settings

Generate a complete, production-ready template:`;

    const response = await ai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: 'You are an expert Shopify Liquid developer who creates high-converting ecommerce templates. Always return valid, production-ready Liquid code with proper schema settings.'
        },
        { role: 'user', content: prompt }
      ],
      max_tokens: 4000,
      temperature: 0.7
    });

    const generatedTemplate = response.choices[0]?.message?.content || '';

    // Extract code from markdown code blocks if present
    let cleanTemplate = generatedTemplate;
    const codeBlockMatch = generatedTemplate.match(/```(?:liquid|html)?\n?([\s\S]*?)```/);
    if (codeBlockMatch) {
      cleanTemplate = codeBlockMatch[1].trim();
    }

    // Basic validation
    const hasSchema = cleanTemplate.includes('{% schema %}');
    const hasSection = cleanTemplate.includes('{%') || cleanTemplate.includes('{{');

    console.log(`✅ Template generated (${cleanTemplate.length} chars, schema: ${hasSchema})`);

    res.json({
      success: true,
      template: cleanTemplate,
      templateType,
      templateInfo,
      store: {
        id: store.id,
        name: store.name,
        niche: store.nicheName
      },
      products: productContext,
      validation: {
        hasSchema,
        hasLiquidSyntax: hasSection,
        charCount: cleanTemplate.length
      },
      generatedAt: new Date().toISOString()
    });

  } catch (e) {
    console.error('❌ Template generation error:', e.message);
    res.json({ success: false, error: e.message });
  }
});

// Generate complete store theme (multiple templates)
app.post('/api/stores/:storeId/generate-theme', async (req, res) => {
  try {
    const storeId = req.params.storeId;
    const stores = loadStores();
    const store = stores.stores[storeId];

    if (!store) {
      return res.json({ success: false, error: 'Store not found' });
    }

    const ai = getOpenAI();
    if (!ai) {
      return res.json({ success: false, error: 'OpenAI API key not configured' });
    }

    const products = Object.values(store.products).slice(0, 5);

    console.log(`\n🎨 Generating complete theme for ${store.name}...`);

    // Generate all template types
    const templates = {};
    const templateTypes = ['homepage', 'product', 'collection'];

    for (const type of templateTypes) {
      console.log(`  → Generating ${type} template...`);

      const templateInfo = TEMPLATE_TYPES[type];
      const productContext = products.map(p => `"${p.title}" - $${p.customPrice || p.originalPrice}`).join(', ');

      const prompt = `Generate a Shopify Liquid ${templateInfo.name} section for a ${store.nicheName || store.nicheId} store called "${store.name}".

Products: ${productContext}

Requirements:
- Valid Liquid syntax
- Tailwind CSS for styling
- Include {% schema %} settings
- Mobile-responsive
- High-converting design elements

Return ONLY the Liquid code:`;

      const response = await ai.chat.completions.create({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 3000,
        temperature: 0.7
      });

      let template = response.choices[0]?.message?.content || '';
      const codeMatch = template.match(/```(?:liquid|html)?\n?([\s\S]*?)```/);
      if (codeMatch) template = codeMatch[1].trim();

      templates[type] = {
        code: template,
        type: templateInfo.name,
        sections: templateInfo.sections
      };
    }

    console.log(`✅ Complete theme generated (${Object.keys(templates).length} templates)`);

    res.json({
      success: true,
      store: { id: store.id, name: store.name },
      templates,
      generatedAt: new Date().toISOString()
    });

  } catch (e) {
    console.error('❌ Theme generation error:', e.message);
    res.json({ success: false, error: e.message });
  }
});

// Generate store branding (colors, fonts, logo prompt)
app.post('/api/stores/:storeId/generate-branding', async (req, res) => {
  try {
    const storeId = req.params.storeId;
    const stores = loadStores();
    const store = stores.stores[storeId];

    if (!store) {
      return res.json({ success: false, error: 'Store not found' });
    }

    const ai = getOpenAI();
    if (!ai) {
      return res.json({ success: false, error: 'OpenAI API key not configured' });
    }

    console.log(`\n🎨 Generating branding for ${store.name}...`);

    const prompt = `Generate a complete branding guide for an ecommerce store:

Store Name: ${store.name}
Niche: ${store.nicheName || store.nicheId}
Concept: ${store.storeIdea || 'General Store'}
Products: ${Object.values(store.products).slice(0, 3).map(p => p.title).join(', ')}

Generate a JSON response with:
1. Color palette (primary, secondary, accent, background, text colors as hex codes)
2. Font recommendations (heading and body fonts from Google Fonts)
3. Logo description (what the logo should look like)
4. Brand voice (tone, style guidelines)
5. Tagline suggestions (3 options)

Return ONLY valid JSON:`;

    const response = await ai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 1500,
      temperature: 0.8
    });

    let brandingText = response.choices[0]?.message?.content || '{}';

    // Extract JSON from response
    const jsonMatch = brandingText.match(/```(?:json)?\n?([\s\S]*?)```/) ||
                      brandingText.match(/\{[\s\S]*\}/);

    let branding = {};
    try {
      branding = JSON.parse(jsonMatch ? jsonMatch[1] || jsonMatch[0] : brandingText);
    } catch (e) {
      branding = { raw: brandingText, parseError: true };
    }

    console.log(`✅ Branding generated for ${store.name}`);

    res.json({
      success: true,
      store: { id: store.id, name: store.name },
      branding,
      generatedAt: new Date().toISOString()
    });

  } catch (e) {
    console.error('❌ Branding generation error:', e.message);
    res.json({ success: false, error: e.message });
  }
});

// ================== TEMPLATE DEPLOYMENT TO SHOPIFY ==================

// Get list of themes for a store
app.get('/api/stores/:storeId/themes', async (req, res) => {
  try {
    const storeId = req.params.storeId;
    const stores = loadStores();
    const store = stores.stores[storeId];

    if (!store) {
      return res.json({ success: false, error: 'Store not found' });
    }

    if (!store.shopify) {
      return res.json({ success: false, error: 'Store not connected to Shopify' });
    }

    const accessToken = await getShopifyAccessToken(store.shopify.shop, getStoreCredentials(store));

    // Get all themes
    const response = await axios.get(
      `https://${store.shopify.shop}/admin/api/2024-01/themes.json`,
      { headers: { 'X-Shopify-Access-Token': accessToken } }
    );

    const themes = response.data.themes.map(t => ({
      id: t.id,
      name: t.name,
      role: t.role, // main, unpublished, demo
      isMain: t.role === 'main',
      previewable: t.previewable,
      processing: t.processing,
      createdAt: t.created_at,
      updatedAt: t.updated_at
    }));

    res.json({
      success: true,
      themes,
      shop: store.shopify.shop
    });

  } catch (e) {
    console.error('❌ Theme list error:', e.message);
    res.json({ success: false, error: e.message });
  }
});

// Get existing template assets from a theme
app.get('/api/stores/:storeId/themes/:themeId/assets', async (req, res) => {
  try {
    const { storeId, themeId } = req.params;
    const stores = loadStores();
    const store = stores.stores[storeId];

    if (!store?.shopify) {
      return res.json({ success: false, error: 'Store not connected to Shopify' });
    }

    const accessToken = await getShopifyAccessToken(store.shopify.shop, getStoreCredentials(store));

    // Get all assets
    const response = await axios.get(
      `https://${store.shopify.shop}/admin/api/2024-01/themes/${themeId}/assets.json`,
      { headers: { 'X-Shopify-Access-Token': accessToken } }
    );

    // Filter to template/section files
    const templateAssets = response.data.assets.filter(a =>
      a.key.startsWith('templates/') ||
      a.key.startsWith('sections/') ||
      a.key.startsWith('snippets/')
    );

    res.json({
      success: true,
      assets: templateAssets,
      themeId
    });

  } catch (e) {
    console.error('❌ Asset list error:', e.message);
    res.json({ success: false, error: e.message });
  }
});

// Deploy a template to Shopify theme
app.post('/api/stores/:storeId/deploy-template', async (req, res) => {
  try {
    const storeId = req.params.storeId;
    const { themeId, templateType, templateContent, fileName } = req.body;
    const stores = loadStores();
    const store = stores.stores[storeId];

    if (!store) {
      return res.json({ success: false, error: 'Store not found' });
    }

    if (!store.shopify) {
      return res.json({ success: false, error: 'Store not connected to Shopify' });
    }

    if (!templateContent) {
      return res.json({ success: false, error: 'Template content required' });
    }

    const accessToken = await getShopifyAccessToken(store.shopify.shop, getStoreCredentials(store));

    // Determine file path based on template type
    const getAssetKey = (type, customFileName) => {
      if (customFileName) return customFileName;

      const mappings = {
        'homepage': 'sections/custom-homepage.liquid',
        'product': 'sections/custom-product.liquid',
        'collection': 'sections/custom-collection.liquid',
        'landing': 'sections/custom-landing.liquid'
      };
      return mappings[type] || `sections/custom-${type || 'template'}.liquid`;
    };

    const assetKey = getAssetKey(templateType, fileName);

    // Get the main theme if no themeId specified
    let targetThemeId = themeId;
    if (!targetThemeId) {
      const themesResponse = await axios.get(
        `https://${store.shopify.shop}/admin/api/2024-01/themes.json`,
        { headers: { 'X-Shopify-Access-Token': accessToken } }
      );
      const mainTheme = themesResponse.data.themes.find(t => t.role === 'main');
      if (!mainTheme) {
        return res.json({ success: false, error: 'No main theme found' });
      }
      targetThemeId = mainTheme.id;
    }

    console.log(`\n🚀 Deploying template to ${store.shopify.shop}...`);
    console.log(`   Theme ID: ${targetThemeId}`);
    console.log(`   Asset Key: ${assetKey}`);

    // Upload the template as a theme asset
    const response = await axios.put(
      `https://${store.shopify.shop}/admin/api/2024-01/themes/${targetThemeId}/assets.json`,
      {
        asset: {
          key: assetKey,
          value: templateContent
        }
      },
      { headers: { 'X-Shopify-Access-Token': accessToken } }
    );

    console.log(`✅ Template deployed: ${assetKey}`);

    // Save deployment record
    if (!store.deployments) store.deployments = [];
    store.deployments.push({
      templateType,
      assetKey,
      themeId: targetThemeId,
      deployedAt: new Date().toISOString()
    });
    stores.stores[storeId] = store;
    saveStores(stores);

    res.json({
      success: true,
      deployment: {
        assetKey,
        themeId: targetThemeId,
        shop: store.shopify.shop,
        editorUrl: `https://${store.shopify.shop}/admin/themes/${targetThemeId}/editor`,
        assetUrl: `https://${store.shopify.shop}/admin/themes/${targetThemeId}?key=${encodeURIComponent(assetKey)}`
      },
      message: `Template deployed to ${assetKey}`
    });

  } catch (e) {
    console.error('❌ Template deployment error:', e.message);
    if (e.response?.data) {
      console.error('Shopify error:', JSON.stringify(e.response.data));
    }
    res.json({ success: false, error: e.message });
  }
});

// Generate and deploy template in one step
app.post('/api/stores/:storeId/generate-and-deploy', async (req, res) => {
  try {
    const storeId = req.params.storeId;
    const { templateType, customPrompt, themeId, fileName } = req.body;
    const stores = loadStores();
    const store = stores.stores[storeId];

    if (!store) {
      return res.json({ success: false, error: 'Store not found' });
    }

    if (!store.shopify) {
      return res.json({ success: false, error: 'Store not connected to Shopify' });
    }

    if (!templateType) {
      return res.json({ success: false, error: 'Template type required' });
    }

    console.log(`\n🎨 Generate & Deploy: ${templateType} for ${store.name}...`);

    // Step 1: Generate the template
    const ai = getOpenAI();
    if (!ai) {
      return res.json({ success: false, error: 'OpenAI API key not configured' });
    }

    const templateInfo = TEMPLATE_TYPES[templateType];
    if (!templateInfo) {
      return res.json({ success: false, error: 'Invalid template type' });
    }

    // Get store products for context
    const products = Object.values(store.products || {}).slice(0, 5).map(p => ({
      title: p.title,
      price: p.originalPrice || p.customPrice,
      category: p.category,
      image: p.image
    }));

    const prompt = `Generate a high-converting Shopify ${templateType} section template.

STORE: ${store.name}
NICHE: ${store.nicheName || store.nicheId}
CONCEPT: ${store.storeIdea || 'General Store'}
${products.length > 0 ? `PRODUCTS: ${products.map(p => p.title).join(', ')}` : ''}

TEMPLATE TYPE: ${templateInfo.name}
SECTIONS TO INCLUDE: ${templateInfo.sections.join(', ')}

${customPrompt ? `CUSTOM REQUIREMENTS: ${customPrompt}` : ''}

CRITICAL SHOPIFY SCHEMA RULES (MUST FOLLOW EXACTLY):
1. Schema "name" field: MAX 25 characters (e.g., "Home Hero", "Products")
2. Settings MUST use valid types: text, textarea, richtext, image_picker, url, checkbox, range, select, color, font_picker
3. For "text" type: ONLY use "id", "type", "label", "default" (NO "content" field)
4. For "textarea" type: same as text
5. For "richtext" type: default must be HTML string
6. For "select" type: MUST include "options" array with "value" and "label" for each
7. For "range" type: MUST include "min", "max", "step", "unit"
8. NO invalid attributes - each type has specific allowed attributes only
9. Block types need "name" and "type" fields

VALID SCHEMA EXAMPLE:
{% schema %}
{
  "name": "Hero Banner",
  "settings": [
    {
      "type": "text",
      "id": "heading",
      "label": "Heading",
      "default": "Welcome"
    },
    {
      "type": "image_picker",
      "id": "image",
      "label": "Background Image"
    },
    {
      "type": "color",
      "id": "bg_color",
      "label": "Background Color",
      "default": "#ffffff"
    }
  ],
  "presets": [
    {
      "name": "Hero Banner"
    }
  ]
}
{% endschema %}

DESIGN REQUIREMENTS:
1. Mobile-first responsive design using inline CSS (no Tailwind - use style tags)
2. Include trust signals (badges, guarantees)
3. High contrast CTA buttons
4. Clean, modern aesthetic
5. Use {{ section.settings.SETTING_ID }} to reference settings

Return ONLY valid Liquid code. No explanations or markdown.`;

    const response = await ai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 4000,
      temperature: 0.7
    });

    let template = response.choices[0]?.message?.content || '';

    // Clean up template
    template = template.replace(/```liquid\n?/g, '').replace(/```\n?/g, '').trim();

    // Fix common Shopify schema issues
    template = template.replace(/{% schema %}\s*\{([^}]*)"name"\s*:\s*"([^"]{26,})"/g, (match, before, name) => {
      const shortName = name.substring(0, 24);
      console.log(`   ⚠️ Truncating schema name: "${name}" → "${shortName}"`);
      return `{% schema %}\n{${before}"name": "${shortName}"`;
    });

    // Also fix preset names
    template = template.replace(/"presets"\s*:\s*\[\s*\{([^}]*)"name"\s*:\s*"([^"]{26,})"/g, (match, before, name) => {
      const shortName = name.substring(0, 24);
      return `"presets": [\n    {\n${before}"name": "${shortName}"`;
    });

    if (!template || template.length < 100) {
      return res.json({ success: false, error: 'Generated template too short or empty' });
    }

    console.log(`   ✅ Template generated (${template.length} chars)`);

    // Step 2: Deploy to Shopify
    const accessToken = await getShopifyAccessToken(store.shopify.shop, getStoreCredentials(store));

    // Determine asset key
    const assetKey = fileName || `sections/ai-${templateType}.liquid`;

    // Get main theme if not specified
    let targetThemeId = themeId;
    if (!targetThemeId) {
      const themesResponse = await axios.get(
        `https://${store.shopify.shop}/admin/api/2024-01/themes.json`,
        { headers: { 'X-Shopify-Access-Token': accessToken } }
      );
      const mainTheme = themesResponse.data.themes.find(t => t.role === 'main');
      if (!mainTheme) {
        return res.json({ success: false, error: 'No main theme found', template });
      }
      targetThemeId = mainTheme.id;
    }

    console.log(`   🚀 Deploying to theme ${targetThemeId}...`);

    // Upload to Shopify
    await axios.put(
      `https://${store.shopify.shop}/admin/api/2024-01/themes/${targetThemeId}/assets.json`,
      {
        asset: {
          key: assetKey,
          value: template
        }
      },
      { headers: { 'X-Shopify-Access-Token': accessToken } }
    );

    console.log(`   ✅ Deployed: ${assetKey}`);

    // Save deployment record
    if (!store.deployments) store.deployments = [];
    store.deployments.push({
      templateType,
      assetKey,
      themeId: targetThemeId,
      deployedAt: new Date().toISOString(),
      charCount: template.length
    });
    stores.stores[storeId] = store;
    saveStores(stores);

    res.json({
      success: true,
      template,
      templateType,
      deployment: {
        assetKey,
        themeId: targetThemeId,
        shop: store.shopify.shop,
        editorUrl: `https://${store.shopify.shop}/admin/themes/${targetThemeId}/editor`,
        assetUrl: `https://${store.shopify.shop}/admin/themes/${targetThemeId}?key=${encodeURIComponent(assetKey)}`
      },
      validation: {
        hasSchema: template.includes('{% schema %}'),
        hasLiquidSyntax: template.includes('{%') || template.includes('{{'),
        charCount: template.length
      },
      generatedAt: new Date().toISOString()
    });

  } catch (e) {
    console.error('❌ Generate & Deploy error:', e.message);

    // Provide detailed error information
    let errorMessage = e.message;
    let errorDetails = null;

    if (e.response) {
      // Shopify API error
      const shopifyError = e.response.data?.errors || e.response.data?.error;
      if (shopifyError) {
        errorMessage = typeof shopifyError === 'string' ? shopifyError : JSON.stringify(shopifyError);
        errorDetails = {
          status: e.response.status,
          shopifyError: shopifyError,
          hint: e.response.status === 401 ? 'Authentication failed - check if app is installed on store with correct scopes (read_themes, write_themes)' :
                e.response.status === 403 ? 'Permission denied - app may be missing write_themes scope' :
                e.response.status === 404 ? 'Theme or asset not found' :
                e.response.status === 422 ? 'Invalid Liquid syntax in template' : null
        };
      }
    } else if (e.message.includes('authenticate') || e.message.includes('token')) {
      errorDetails = {
        hint: 'Authentication issue - verify store has correct Client ID and Secret configured'
      };
    }

    console.error('   Error details:', errorDetails);

    res.json({
      success: false,
      error: errorMessage,
      details: errorDetails
    });
  }
});

// Set a section as the homepage - updates templates/index.json
app.post('/api/stores/:storeId/set-homepage', async (req, res) => {
  try {
    const storeId = req.params.storeId;
    const { sectionKey, themeId } = req.body;
    const stores = loadStores();
    const store = stores.stores[storeId];

    if (!store) {
      return res.json({ success: false, error: 'Store not found' });
    }

    if (!store.shopify) {
      return res.json({ success: false, error: 'Store not connected to Shopify' });
    }

    const accessToken = await getShopifyAccessToken(store.shopify.shop, getStoreCredentials(store));

    // Get main theme if not specified
    let targetThemeId = themeId;
    if (!targetThemeId) {
      const themesResponse = await axios.get(
        `https://${store.shopify.shop}/admin/api/2024-01/themes.json`,
        { headers: { 'X-Shopify-Access-Token': accessToken } }
      );
      const mainTheme = themesResponse.data.themes.find(t => t.role === 'main');
      if (!mainTheme) {
        return res.json({ success: false, error: 'No main theme found' });
      }
      targetThemeId = mainTheme.id;
    }

    console.log(`\n🏠 Setting homepage for ${store.name}...`);

    // Get the section name from the key (e.g., "sections/custom-homepage.liquid" -> "custom-homepage")
    const sectionName = (sectionKey || 'custom-homepage').replace('sections/', '').replace('.liquid', '');

    // Create a new index.json template that uses our custom section
    const indexTemplate = {
      sections: {
        [sectionName]: {
          type: sectionName,
          settings: {}
        }
      },
      order: [sectionName]
    };

    console.log(`   📄 Updating templates/index.json to use section: ${sectionName}`);

    // Upload the new index.json
    const response = await axios.put(
      `https://${store.shopify.shop}/admin/api/2024-01/themes/${targetThemeId}/assets.json`,
      {
        asset: {
          key: 'templates/index.json',
          value: JSON.stringify(indexTemplate, null, 2)
        }
      },
      { headers: { 'X-Shopify-Access-Token': accessToken } }
    );

    console.log(`   ✅ Homepage set to ${sectionName}`);

    res.json({
      success: true,
      message: `Homepage now uses section: ${sectionName}`,
      template: indexTemplate,
      themeId: targetThemeId,
      storeUrl: `https://${store.shopify.shop}`,
      editorUrl: `https://${store.shopify.shop}/admin/themes/${targetThemeId}/editor`
    });

  } catch (e) {
    console.error('❌ Set homepage error:', e.message);
    if (e.response?.data) {
      console.error('Shopify error:', JSON.stringify(e.response.data));
    }
    res.json({ success: false, error: e.message, details: e.response?.data });
  }
});

// Get a theme asset
app.get('/api/stores/:storeId/themes/:themeId/asset', async (req, res) => {
  try {
    const { storeId, themeId } = req.params;
    const { key } = req.query;
    const stores = loadStores();
    const store = stores.stores[storeId];

    if (!store || !store.shopify) {
      return res.json({ success: false, error: 'Store not found or not connected' });
    }

    const accessToken = await getShopifyAccessToken(store.shopify.shop, getStoreCredentials(store));

    const response = await axios.get(
      `https://${store.shopify.shop}/admin/api/2024-01/themes/${themeId}/assets.json`,
      {
        params: { 'asset[key]': key },
        headers: { 'X-Shopify-Access-Token': accessToken }
      }
    );

    res.json({ success: true, asset: response.data.asset });

  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Get deployment history for a store
app.get('/api/stores/:storeId/deployments', async (req, res) => {
  try {
    const storeId = req.params.storeId;
    const stores = loadStores();
    const store = stores.stores[storeId];

    if (!store) {
      return res.json({ success: false, error: 'Store not found' });
    }

    res.json({
      success: true,
      deployments: store.deployments || [],
      shop: store.shopify?.shop
    });

  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ================== CONTENT GENERATION ==================

// Get product images from AliExpress or Google
app.post('/api/get-product-images', async (req, res) => {
  try {
    const { productName, productImage } = req.body;

    if (!productName) {
      return res.json({ success: false, error: 'Product name required' });
    }

    // Use the existing product image as primary
    const images = [];

    if (productImage) {
      images.push({
        url: productImage,
        source: 'TikTok Shop',
        type: 'product'
      });
    }

    // Generate AliExpress search URL for additional images
    const aliExpressSearchUrl = `https://www.aliexpress.com/wholesale?SearchText=${encodeURIComponent(productName)}`;

    res.json({
      success: true,
      images,
      searchUrls: {
        aliexpress: aliExpressSearchUrl,
        google: `https://www.google.com/search?q=${encodeURIComponent(productName)}&tbm=isch`
      }
    });

  } catch (e) {
    console.error('❌ Image fetch error:', e.message);
    res.json({ success: false, error: e.message });
  }
});

// Generate marketing prompts for Gemini
app.post('/api/generate-content-prompts', async (req, res) => {
  try {
    const { product } = req.body;

    if (!product || !product.title) {
      return res.json({ success: false, error: 'Invalid product data' });
    }

    const gemini = getGemini();

    if (!gemini) {
      // Return basic prompts without AI
      return res.json({
        success: true,
        prompts: {
          imagePrompts: [
            `Professional product photography of ${product.title} on white background, studio lighting, high quality, commercial photography`,
            `${product.title} in lifestyle setting, natural lighting, Instagram aesthetic, trendy background`,
            `Creative flat lay composition featuring ${product.title}, minimalist style, pastel colors, top-down view`
          ],
          videoPrompts: [
            `15-second product showcase of ${product.title}, smooth rotation, professional lighting, modern aesthetic`,
            `TikTok-style video showing ${product.title} in use, dynamic angles, energetic vibe, trending music`,
            `Unboxing video for ${product.title}, ASMR style, close-up shots, satisfying reveal`
          ],
          socialCaptions: [
            `🔥 Just found the perfect ${product.category || 'product'}! ${product.title} is trending right now. Link in bio! #trending #musthave`,
            `This ${product.title} is a game changer! 😍 Can't believe the quality for the price. Who else needs this? #productreview #viral`,
            `POV: You discover the ${product.title} everyone's talking about ✨ #fyp #trending #shopsmall`
          ]
        },
        generatedBy: 'default'
      });
    }

    try {
      const model = gemini.getGenerativeModel({ model: 'gemini-pro' });

      const prompt = `Generate marketing content prompts for this product:
Product: ${product.title}
Category: ${product.category || 'general'}
Price: $${product.price}
Trend: ${product.trend || 'Rising'}
AI Score: ${product.aiScore || 'N/A'}/100

Generate:
1. Three detailed image generation prompts for Google Imagen (focus on product photography, lifestyle shots, and creative compositions)
2. Three detailed video generation prompts for Google Veo (focus on TikTok/Instagram Reels style, 15-30 second clips)
3. Three engaging social media captions for TikTok/Instagram

Return as JSON:
{
  "imagePrompts": ["prompt1", "prompt2", "prompt3"],
  "videoPrompts": ["prompt1", "prompt2", "prompt3"],
  "socialCaptions": ["caption1", "caption2", "caption3"]
}`;

      const result = await model.generateContent(prompt);
      const response = await result.response;
      const text = response.text();

      // Try to parse JSON from response
      let prompts;
      try {
        // Extract JSON from markdown code blocks if present
        const jsonMatch = text.match(/```json\n([\s\S]*?)\n```/) || text.match(/```\n([\s\S]*?)\n```/);
        if (jsonMatch) {
          prompts = JSON.parse(jsonMatch[1]);
        } else {
          prompts = JSON.parse(text);
        }
      } catch (parseError) {
        console.error('Failed to parse Gemini response as JSON:', text);
        // Return default prompts if parsing fails
        prompts = {
          imagePrompts: [
            `Professional product photography of ${product.title} on white background, studio lighting, high quality, commercial photography`,
            `${product.title} in lifestyle setting, natural lighting, Instagram aesthetic, trendy background`,
            `Creative flat lay composition featuring ${product.title}, minimalist style, pastel colors, top-down view`
          ],
          videoPrompts: [
            `15-second product showcase of ${product.title}, smooth rotation, professional lighting, modern aesthetic`,
            `TikTok-style video showing ${product.title} in use, dynamic angles, energetic vibe, trending music`,
            `Unboxing video for ${product.title}, ASMR style, close-up shots, satisfying reveal`
          ],
          socialCaptions: [
            `🔥 Just found the perfect ${product.category || 'product'}! ${product.title} is trending right now. #trending #musthave`,
            `This ${product.title} is a game changer! 😍 #productreview #viral`,
            `POV: You discover the ${product.title} everyone's talking about ✨ #fyp #trending`
          ]
        };
      }

      res.json({
        success: true,
        prompts,
        generatedBy: 'gemini'
      });

    } catch (aiError) {
      console.error('❌ Gemini API error:', aiError.message);
      // Return basic prompts on error
      res.json({
        success: true,
        prompts: {
          imagePrompts: [
            `Professional product photography of ${product.title} on white background, studio lighting, high quality, commercial photography`,
            `${product.title} in lifestyle setting, natural lighting, Instagram aesthetic, trendy background`,
            `Creative flat lay composition featuring ${product.title}, minimalist style, pastel colors, top-down view`
          ],
          videoPrompts: [
            `15-second product showcase of ${product.title}, smooth rotation, professional lighting, modern aesthetic`,
            `TikTok-style video showing ${product.title} in use, dynamic angles, energetic vibe, trending music`,
            `Unboxing video for ${product.title}, ASMR style, close-up shots, satisfying reveal`
          ],
          socialCaptions: [
            `🔥 Just found the perfect ${product.category || 'product'}! ${product.title} is trending right now. Link in bio! #trending #musthave`,
            `This ${product.title} is a game changer! 😍 Can't believe the quality for the price. #productreview #viral`,
            `POV: You discover the ${product.title} everyone's talking about ✨ #fyp #trending`
          ]
        },
        generatedBy: 'default',
        error: aiError.message
      });
    }

  } catch (e) {
    console.error('❌ Content generation error:', e.message);
    res.json({ success: false, error: e.message });
  }
});

// ================== AI IMAGE GENERATION (DALL-E 3) ==================

// Generate product images using DALL-E 3
app.post('/api/generate-product-images', async (req, res) => {
  try {
    const { product, imageType = 'product', customPrompt } = req.body;

    if (!product || !product.title) {
      return res.json({ success: false, error: 'Product with title is required' });
    }

    const openai = getOpenAI();
    if (!openai) {
      return res.json({ success: false, error: 'OpenAI API key not configured' });
    }

    // Build prompt based on image type
    let prompt;
    const productName = product.title.substring(0, 100);

    if (customPrompt) {
      prompt = customPrompt;
    } else {
      switch (imageType) {
        case 'product':
          prompt = `Professional e-commerce product photography of ${productName}. Clean white background, studio lighting with soft shadows, high resolution, commercial quality. The product should be the clear focus, shot from a 3/4 angle to show depth and detail. No text, watermarks, or logos.`;
          break;
        case 'lifestyle':
          prompt = `Lifestyle product photography featuring ${productName} in a modern, aesthetic setting. Natural lighting, Instagram-worthy composition, warm and inviting atmosphere. Show the product in use or in context of daily life. Trendy, aspirational mood. No text or logos.`;
          break;
        case 'ad':
          prompt = `Eye-catching advertising photo for ${productName}. Bold, vibrant colors, dynamic composition that grabs attention. Perfect for social media ads and marketing materials. Professional commercial photography style with slight dramatic lighting. Clean, modern aesthetic. No text.`;
          break;
        case 'flatlay':
          prompt = `Top-down flat lay product photography of ${productName} with complementary props and accessories. Minimalist aesthetic, pastel or neutral background, carefully arranged composition. Instagram-style, aesthetically pleasing arrangement. No text or logos.`;
          break;
        default:
          prompt = `High-quality product photo of ${productName}, professional lighting, clean background, e-commerce ready. No text or logos.`;
      }
    }

    console.log(`🎨 Generating ${imageType} image for: ${productName.substring(0, 40)}...`);

    const response = await openai.images.generate({
      model: 'dall-e-3',
      prompt: prompt,
      n: 1,
      size: '1024x1024',
      quality: 'hd',
      style: imageType === 'ad' ? 'vivid' : 'natural'
    });

    const imageUrl = response.data[0]?.url;
    const revisedPrompt = response.data[0]?.revised_prompt;

    if (!imageUrl) {
      return res.json({ success: false, error: 'No image generated' });
    }

    console.log(`✅ Image generated successfully`);

    res.json({
      success: true,
      image: {
        url: imageUrl,
        type: imageType,
        prompt: prompt,
        revisedPrompt: revisedPrompt,
        generatedAt: new Date().toISOString()
      },
      product: {
        title: product.title,
        hash: hashProduct(product)
      }
    });

  } catch (e) {
    console.error('❌ Image generation error:', e.message);

    // Handle specific OpenAI errors
    if (e.message.includes('content_policy_violation')) {
      return res.json({
        success: false,
        error: 'Image generation was blocked due to content policy. Try a different product or prompt.'
      });
    }

    if (e.message.includes('rate_limit')) {
      return res.json({
        success: false,
        error: 'Rate limit reached. Please wait a moment and try again.'
      });
    }

    res.json({ success: false, error: e.message });
  }
});

// Generate multiple image types for a product
app.post('/api/generate-product-images/batch', async (req, res) => {
  try {
    const { product, imageTypes = ['product', 'lifestyle', 'ad'] } = req.body;

    if (!product || !product.title) {
      return res.json({ success: false, error: 'Product with title is required' });
    }

    const openai = getOpenAI();
    if (!openai) {
      return res.json({ success: false, error: 'OpenAI API key not configured' });
    }

    const results = [];
    const errors = [];

    for (const imageType of imageTypes.slice(0, 3)) { // Limit to 3 images
      try {
        console.log(`🎨 Generating ${imageType} image...`);

        // Build type-specific prompt
        let prompt;
        const productName = product.title.substring(0, 100);

        switch (imageType) {
          case 'product':
            prompt = `Professional e-commerce product photography of ${productName}. Clean white background, studio lighting, high resolution, commercial quality. No text.`;
            break;
          case 'lifestyle':
            prompt = `Lifestyle product photography featuring ${productName} in a modern aesthetic setting. Natural lighting, Instagram-worthy, trendy mood. No text.`;
            break;
          case 'ad':
            prompt = `Eye-catching advertising photo for ${productName}. Bold colors, dynamic composition for social media ads. Professional, attention-grabbing. No text.`;
            break;
          default:
            prompt = `High-quality product photo of ${productName}, professional lighting, e-commerce ready. No text.`;
        }

        const response = await openai.images.generate({
          model: 'dall-e-3',
          prompt: prompt,
          n: 1,
          size: '1024x1024',
          quality: 'standard' // Use standard for batch to save cost
        });

        results.push({
          type: imageType,
          url: response.data[0]?.url,
          prompt: prompt,
          success: true
        });

        // Small delay between requests
        await new Promise(resolve => setTimeout(resolve, 1000));

      } catch (e) {
        errors.push({ type: imageType, error: e.message });
      }
    }

    res.json({
      success: results.length > 0,
      images: results,
      errors: errors.length > 0 ? errors : undefined,
      product: {
        title: product.title,
        hash: hashProduct(product)
      }
    });

  } catch (e) {
    console.error('❌ Batch image generation error:', e.message);
    res.json({ success: false, error: e.message });
  }
});

// ================== AI MEDIA CURATION (GPT-4o Vision) ==================

// Analyze product images using GPT-4o Vision
app.post('/api/analyze-product-media', async (req, res) => {
  try {
    const { product, imageUrls } = req.body;

    if (!imageUrls || !Array.isArray(imageUrls) || imageUrls.length === 0) {
      return res.json({ success: false, error: 'Image URLs array is required' });
    }

    const openai = getOpenAI();
    if (!openai) {
      return res.json({ success: false, error: 'OpenAI API key not configured' });
    }

    // Limit to 5 images to control costs
    const imagesToAnalyze = imageUrls.slice(0, 5);

    console.log(`🔍 Analyzing ${imagesToAnalyze.length} images for: ${product?.title?.substring(0, 40) || 'product'}...`);

    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: `You are an expert e-commerce product photographer and marketing specialist. Analyze product images for dropshipping quality and provide actionable recommendations.`
        },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `Analyze these ${imagesToAnalyze.length} product images for e-commerce/dropshipping use. For each image, evaluate:

1. Quality Score (1-10): lighting, resolution, clarity
2. E-commerce Suitability (1-10): background, composition, professionalism
3. Best Use: "hero" (main product image), "gallery" (additional shots), "lifestyle" (in-use shots), "skip" (don't use)
4. Issues: any problems (watermarks, bad lighting, cluttered background, etc.)
5. Improvements: specific suggestions to make it better

Return JSON format:
{
  "images": [
    { "index": 0, "qualityScore": 8, "ecommerceScore": 7, "bestUse": "hero", "issues": [], "improvements": [] }
  ],
  "recommendation": {
    "heroImageIndex": 0,
    "galleryImages": [1, 2],
    "skipImages": [],
    "overallQuality": "good/fair/poor",
    "needsNewImages": true/false,
    "summary": "Brief recommendation"
  }
}`
            },
            ...imagesToAnalyze.map((url, idx) => ({
              type: 'image_url',
              image_url: { url, detail: 'low' }
            }))
          ]
        }
      ],
      max_tokens: 1500
    });

    const content = response.choices[0]?.message?.content;

    // Parse JSON response
    let analysis;
    try {
      const jsonMatch = content.match(/```json\n?([\s\S]*?)\n?```/) || content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        analysis = JSON.parse(jsonMatch[1] || jsonMatch[0]);
      } else {
        throw new Error('Could not parse analysis');
      }
    } catch (parseError) {
      // Return raw analysis if JSON parsing fails
      analysis = { rawAnalysis: content, parseError: true };
    }

    console.log(`✅ Media analysis complete`);

    res.json({
      success: true,
      analysis,
      analyzedCount: imagesToAnalyze.length,
      product: product ? { title: product.title, hash: hashProduct(product) } : null
    });

  } catch (e) {
    console.error('❌ Media analysis error:', e.message);
    res.json({ success: false, error: e.message });
  }
});

// ================== AI VIDEO GENERATION (Runway ML) ==================

// Generate product video using Runway ML (placeholder - requires API key)
app.post('/api/generate-product-video', async (req, res) => {
  try {
    const { product, videoType = 'showcase', imageUrl } = req.body;

    if (!product || !product.title) {
      return res.json({ success: false, error: 'Product with title is required' });
    }

    const config = loadConfig();

    if (!config.runwayApiKey) {
      return res.json({
        success: false,
        error: 'Runway ML API key not configured',
        setupInstructions: {
          step1: 'Go to https://runwayml.com and create an account',
          step2: 'Subscribe to API access',
          step3: 'Get your API key from the dashboard',
          step4: 'Add it to Settings in the dashboard'
        }
      });
    }

    // Build video prompt based on type
    let prompt;
    const productName = product.title.substring(0, 50);

    switch (videoType) {
      case 'showcase':
        prompt = `Product showcase video: ${productName} rotating slowly 360 degrees on a clean white background, professional studio lighting, smooth motion, high quality product video`;
        break;
      case 'lifestyle':
        prompt = `Lifestyle video: ${productName} being used in a modern, aesthetic setting, natural movement, soft lighting, Instagram-style content`;
        break;
      case 'unboxing':
        prompt = `Unboxing video: hands carefully opening a package to reveal ${productName}, ASMR style, satisfying reveal, close-up shots`;
        break;
      case 'demo':
        prompt = `Product demonstration: showing key features of ${productName}, dynamic angles, professional presentation, highlighting benefits`;
        break;
      default:
        prompt = `Product video featuring ${productName}, professional quality, smooth motion, e-commerce style`;
    }

    console.log(`🎬 Generating ${videoType} video for: ${productName}...`);

    // Runway ML API call
    try {
      const runwayResponse = await axios.post('https://api.runwayml.com/v1/text-to-video', {
        prompt: prompt,
        duration: 4, // 4 seconds
        aspect_ratio: '9:16', // TikTok/Reels format
        ...(imageUrl && { image_url: imageUrl }) // Use source image if provided
      }, {
        headers: {
          'Authorization': `Bearer ${config.runwayApiKey}`,
          'Content-Type': 'application/json'
        }
      });

      // Runway returns a task ID for async generation
      const taskId = runwayResponse.data.id;

      res.json({
        success: true,
        status: 'processing',
        taskId: taskId,
        message: 'Video generation started. Poll /api/video-status/:taskId for completion.',
        estimatedTime: '2-5 minutes',
        prompt: prompt,
        videoType: videoType
      });

    } catch (apiError) {
      console.error('❌ Runway API error:', apiError.response?.data || apiError.message);

      // Return helpful error message
      if (apiError.response?.status === 401) {
        return res.json({ success: false, error: 'Invalid Runway API key' });
      }
      if (apiError.response?.status === 429) {
        return res.json({ success: false, error: 'Runway rate limit reached. Try again later.' });
      }

      res.json({
        success: false,
        error: apiError.response?.data?.error || apiError.message,
        prompt: prompt // Return prompt so user can try elsewhere
      });
    }

  } catch (e) {
    console.error('❌ Video generation error:', e.message);
    res.json({ success: false, error: e.message });
  }
});

// Check video generation status
app.get('/api/video-status/:taskId', async (req, res) => {
  try {
    const { taskId } = req.params;
    const config = loadConfig();

    if (!config.runwayApiKey) {
      return res.json({ success: false, error: 'Runway API key not configured' });
    }

    const response = await axios.get(`https://api.runwayml.com/v1/tasks/${taskId}`, {
      headers: { 'Authorization': `Bearer ${config.runwayApiKey}` }
    });

    const task = response.data;

    res.json({
      success: true,
      status: task.status,
      progress: task.progress,
      videoUrl: task.status === 'completed' ? task.output?.video_url : null,
      error: task.status === 'failed' ? task.error : null
    });

  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ================== AD ANALYTICS DASHBOARD ==================

// Get Meta (Facebook/Instagram) Ads campaigns and metrics
app.get('/api/ads/meta/campaigns', async (req, res) => {
  try {
    const config = loadConfig();

    if (!config.metaAdsToken || !config.metaAdAccountId) {
      return res.json({
        success: false,
        error: 'Meta Ads API not configured',
        setupInstructions: {
          step1: 'Go to Meta Business Suite → Settings → Business Settings',
          step2: 'Navigate to System Users → Add → Create System User',
          step3: 'Go to Apps → Add Assets → Select your ad account',
          step4: 'Generate token with ads_read permission',
          step5: 'Copy Token and Ad Account ID to Settings'
        }
      });
    }

    console.log('📊 Fetching Meta Ads campaigns...');

    const response = await axios.get(
      `https://graph.facebook.com/v19.0/act_${config.metaAdAccountId}/campaigns`,
      {
        params: {
          access_token: config.metaAdsToken,
          fields: 'id,name,status,objective,created_time,updated_time,daily_budget,lifetime_budget,insights{spend,impressions,clicks,cpc,ctr,reach,frequency,actions,cost_per_action_type}',
          limit: 50
        }
      }
    );

    const campaigns = response.data.data || [];

    // Calculate totals
    let totalSpend = 0;
    let totalImpressions = 0;
    let totalClicks = 0;
    let totalConversions = 0;

    campaigns.forEach(campaign => {
      if (campaign.insights?.data?.[0]) {
        const insights = campaign.insights.data[0];
        totalSpend += parseFloat(insights.spend || 0);
        totalImpressions += parseInt(insights.impressions || 0);
        totalClicks += parseInt(insights.clicks || 0);

        // Count conversions (purchases, leads, etc.)
        if (insights.actions) {
          const purchaseAction = insights.actions.find(a => a.action_type === 'purchase' || a.action_type === 'omni_purchase');
          if (purchaseAction) {
            totalConversions += parseInt(purchaseAction.value || 0);
          }
        }
      }
    });

    res.json({
      success: true,
      campaigns: campaigns.map(c => ({
        id: c.id,
        name: c.name,
        status: c.status,
        objective: c.objective,
        budget: c.daily_budget || c.lifetime_budget,
        insights: c.insights?.data?.[0] || null
      })),
      totals: {
        spend: totalSpend.toFixed(2),
        impressions: totalImpressions,
        clicks: totalClicks,
        conversions: totalConversions,
        ctr: totalImpressions > 0 ? ((totalClicks / totalImpressions) * 100).toFixed(2) : 0,
        cpc: totalClicks > 0 ? (totalSpend / totalClicks).toFixed(2) : 0,
        roas: totalConversions > 0 && totalSpend > 0 ? (totalConversions * 50 / totalSpend).toFixed(2) : 0 // Assuming $50 avg order value
      },
      count: campaigns.length
    });

  } catch (e) {
    console.error('❌ Meta Ads error:', e.response?.data || e.message);
    res.json({
      success: false,
      error: e.response?.data?.error?.message || e.message
    });
  }
});

// Get Meta Ads insights for date range
app.get('/api/ads/meta/insights', async (req, res) => {
  try {
    const config = loadConfig();
    const { startDate, endDate, breakdown } = req.query;

    if (!config.metaAdsToken || !config.metaAdAccountId) {
      return res.json({ success: false, error: 'Meta Ads API not configured' });
    }

    const params = {
      access_token: config.metaAdsToken,
      fields: 'spend,impressions,clicks,cpc,ctr,reach,frequency,actions,cost_per_action_type',
      level: 'account',
      time_range: JSON.stringify({
        since: startDate || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
        until: endDate || new Date().toISOString().split('T')[0]
      })
    };

    if (breakdown === 'country') {
      params.breakdowns = 'country';
    } else if (breakdown === 'age') {
      params.breakdowns = 'age';
    } else if (breakdown === 'placement') {
      params.breakdowns = 'publisher_platform';
    }

    const response = await axios.get(
      `https://graph.facebook.com/v19.0/act_${config.metaAdAccountId}/insights`,
      { params }
    );

    res.json({
      success: true,
      insights: response.data.data || [],
      breakdown: breakdown || 'none'
    });

  } catch (e) {
    res.json({ success: false, error: e.response?.data?.error?.message || e.message });
  }
});

// Get TikTok Ads campaigns and metrics
app.get('/api/ads/tiktok/campaigns', async (req, res) => {
  try {
    const config = loadConfig();

    if (!config.tiktokAdsToken || !config.tiktokAdAccountId) {
      return res.json({
        success: false,
        error: 'TikTok Ads API not configured',
        setupInstructions: {
          step1: 'Go to TikTok Ads Manager → Account Settings',
          step2: 'Click on "Marketing API" or "Developer"',
          step3: 'Create an app and get access token',
          step4: 'Copy Token and Advertiser ID to Settings'
        }
      });
    }

    console.log('📊 Fetching TikTok Ads campaigns...');

    const response = await axios.get('https://business-api.tiktok.com/open_api/v1.3/campaign/get/', {
      params: {
        advertiser_id: config.tiktokAdAccountId,
        page_size: 50
      },
      headers: {
        'Access-Token': config.tiktokAdsToken
      }
    });

    if (response.data.code !== 0) {
      throw new Error(response.data.message || 'TikTok API error');
    }

    const campaigns = response.data.data?.list || [];

    // Get campaign metrics
    const metricsResponse = await axios.get('https://business-api.tiktok.com/open_api/v1.3/report/integrated/get/', {
      params: {
        advertiser_id: config.tiktokAdAccountId,
        service_type: 'AUCTION',
        report_type: 'BASIC',
        data_level: 'AUCTION_CAMPAIGN',
        dimensions: JSON.stringify(['campaign_id']),
        metrics: JSON.stringify(['spend', 'impressions', 'clicks', 'ctr', 'cpc', 'conversion', 'cost_per_conversion']),
        start_date: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
        end_date: new Date().toISOString().split('T')[0]
      },
      headers: {
        'Access-Token': config.tiktokAdsToken
      }
    });

    const metrics = metricsResponse.data.data?.list || [];

    // Merge campaigns with metrics
    const campaignsWithMetrics = campaigns.map(campaign => {
      const campaignMetrics = metrics.find(m => m.dimensions?.campaign_id === campaign.campaign_id);
      return {
        ...campaign,
        metrics: campaignMetrics?.metrics || null
      };
    });

    // Calculate totals
    let totalSpend = 0;
    let totalImpressions = 0;
    let totalClicks = 0;
    let totalConversions = 0;

    metrics.forEach(m => {
      if (m.metrics) {
        totalSpend += parseFloat(m.metrics.spend || 0);
        totalImpressions += parseInt(m.metrics.impressions || 0);
        totalClicks += parseInt(m.metrics.clicks || 0);
        totalConversions += parseInt(m.metrics.conversion || 0);
      }
    });

    res.json({
      success: true,
      campaigns: campaignsWithMetrics,
      totals: {
        spend: totalSpend.toFixed(2),
        impressions: totalImpressions,
        clicks: totalClicks,
        conversions: totalConversions,
        ctr: totalImpressions > 0 ? ((totalClicks / totalImpressions) * 100).toFixed(2) : 0,
        cpc: totalClicks > 0 ? (totalSpend / totalClicks).toFixed(2) : 0
      },
      count: campaigns.length
    });

  } catch (e) {
    console.error('❌ TikTok Ads error:', e.response?.data || e.message);
    res.json({
      success: false,
      error: e.response?.data?.message || e.message
    });
  }
});

// Combined ads overview (both platforms)
app.get('/api/ads/overview', async (req, res) => {
  try {
    const config = loadConfig();

    const metaConfigured = !!(config.metaAdsToken && config.metaAdAccountId);
    const tiktokConfigured = !!(config.tiktokAdsToken && config.tiktokAdAccountId);

    // If no ads accounts configured, return setup state
    if (!metaConfigured && !tiktokConfigured) {
      return res.json({
        success: false,
        needsSetup: true,
        message: 'No ad accounts connected'
      });
    }

    const results = {
      meta: { connected: metaConfigured, campaigns: [], totalSpend: 0 },
      tiktok: { connected: tiktokConfigured, campaigns: [], totalSpend: 0 },
      combined: {
        totalSpend: 0,
        totalImpressions: 0,
        totalClicks: 0,
        totalConversions: 0,
        avgRoas: 0,
        avgCpa: 0,
        regions: [],
        topProducts: []
      }
    };

    // Fetch Meta Ads if configured
    if (metaConfigured) {
      try {
        // Get campaigns list
        const campaignsRes = await axios.get(
          `https://graph.facebook.com/v19.0/act_${config.metaAdAccountId}/campaigns`,
          {
            params: {
              access_token: config.metaAdsToken,
              fields: 'name,status,objective,insights{spend,impressions,clicks,actions,cost_per_action_type}',
              limit: 20
            }
          }
        );

        if (campaignsRes.data.data) {
          results.meta.campaigns = campaignsRes.data.data.map(c => ({
            id: c.id,
            name: c.name,
            status: c.status,
            objective: c.objective,
            spend: parseFloat(c.insights?.data?.[0]?.spend || 0),
            impressions: parseInt(c.insights?.data?.[0]?.impressions || 0),
            clicks: parseInt(c.insights?.data?.[0]?.clicks || 0),
            conversions: parseInt(c.insights?.data?.[0]?.actions?.find(a => a.action_type === 'purchase')?.value || 0)
          }));

          results.meta.totalSpend = results.meta.campaigns.reduce((sum, c) => sum + c.spend, 0);
          results.combined.totalSpend += results.meta.totalSpend;
          results.combined.totalImpressions += results.meta.campaigns.reduce((sum, c) => sum + c.impressions, 0);
          results.combined.totalClicks += results.meta.campaigns.reduce((sum, c) => sum + c.clicks, 0);
          results.combined.totalConversions += results.meta.campaigns.reduce((sum, c) => sum + c.conversions, 0);
        }

        // Get regional breakdown
        try {
          const regionalRes = await axios.get(
            `https://graph.facebook.com/v19.0/act_${config.metaAdAccountId}/insights`,
            {
              params: {
                access_token: config.metaAdsToken,
                fields: 'spend,impressions,clicks,actions,purchase_roas',
                breakdowns: 'country',
                date_preset: 'last_30d',
                limit: 10
              }
            }
          );

          if (regionalRes.data.data) {
            regionalRes.data.data.forEach(r => {
              const revenue = parseFloat(r.purchase_roas?.[0]?.value || 0) * parseFloat(r.spend || 0);
              results.combined.regions.push({
                region: r.country,
                spend: parseFloat(r.spend || 0),
                conversions: parseInt(r.actions?.find(a => a.action_type === 'purchase')?.value || 0),
                roas: parseFloat(r.purchase_roas?.[0]?.value || 0)
              });
            });
          }
        } catch (e) {
          // Regional data optional
        }

      } catch (e) {
        results.meta.error = e.response?.data?.error?.message || e.message;
      }
    }

    // Fetch TikTok Ads if configured
    if (tiktokConfigured) {
      try {
        // Get campaigns list
        const tiktokCampaignsRes = await axios.get('https://business-api.tiktok.com/open_api/v1.3/campaign/get/', {
          params: {
            advertiser_id: config.tiktokAdAccountId,
            page_size: 20
          },
          headers: { 'Access-Token': config.tiktokAdsToken }
        });

        if (tiktokCampaignsRes.data.data?.list) {
          // Get metrics for each campaign
          const campaignIds = tiktokCampaignsRes.data.data.list.map(c => c.campaign_id);

          const metricsRes = await axios.get('https://business-api.tiktok.com/open_api/v1.3/report/integrated/get/', {
            params: {
              advertiser_id: config.tiktokAdAccountId,
              service_type: 'AUCTION',
              report_type: 'BASIC',
              data_level: 'AUCTION_CAMPAIGN',
              dimensions: JSON.stringify(['campaign_id']),
              metrics: JSON.stringify(['spend', 'impressions', 'clicks', 'conversion', 'total_complete_payment_rate']),
              start_date: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
              end_date: new Date().toISOString().split('T')[0],
              filtering: JSON.stringify([{ field_name: 'campaign_ids', filter_type: 'IN', filter_value: JSON.stringify(campaignIds) }])
            },
            headers: { 'Access-Token': config.tiktokAdsToken }
          });

          const metricsMap = {};
          if (metricsRes.data.data?.list) {
            metricsRes.data.data.list.forEach(m => {
              metricsMap[m.dimensions.campaign_id] = m.metrics;
            });
          }

          results.tiktok.campaigns = tiktokCampaignsRes.data.data.list.map(c => {
            const metrics = metricsMap[c.campaign_id] || {};
            return {
              id: c.campaign_id,
              name: c.campaign_name,
              status: c.operation_status,
              objective: c.objective_type,
              spend: parseFloat(metrics.spend || 0),
              impressions: parseInt(metrics.impressions || 0),
              clicks: parseInt(metrics.clicks || 0),
              conversions: parseInt(metrics.conversion || 0)
            };
          });

          results.tiktok.totalSpend = results.tiktok.campaigns.reduce((sum, c) => sum + c.spend, 0);
          results.combined.totalSpend += results.tiktok.totalSpend;
          results.combined.totalImpressions += results.tiktok.campaigns.reduce((sum, c) => sum + c.impressions, 0);
          results.combined.totalClicks += results.tiktok.campaigns.reduce((sum, c) => sum + c.clicks, 0);
          results.combined.totalConversions += results.tiktok.campaigns.reduce((sum, c) => sum + c.conversions, 0);
        }
      } catch (e) {
        results.tiktok.error = e.response?.data?.message || e.message;
      }
    }

    // Calculate combined metrics
    results.combined.ctr = results.combined.totalImpressions > 0
      ? ((results.combined.totalClicks / results.combined.totalImpressions) * 100).toFixed(2)
      : 0;
    results.combined.cpc = results.combined.totalClicks > 0
      ? (results.combined.totalSpend / results.combined.totalClicks).toFixed(2)
      : 0;
    results.combined.avgCpa = results.combined.totalConversions > 0
      ? results.combined.totalSpend / results.combined.totalConversions
      : 0;

    // Calculate average ROAS (if we have revenue data)
    if (results.combined.regions.length > 0) {
      const totalRoas = results.combined.regions.reduce((sum, r) => sum + r.roas, 0);
      results.combined.avgRoas = totalRoas / results.combined.regions.length;
    }

    // Sort regions by spend
    results.combined.regions.sort((a, b) => b.spend - a.spend);

    res.json({
      success: true,
      ...results
    });

  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ================== AUTOPILOT EXECUTION ==================

async function runAutopilot() {
  const state = loadAutopilotState();

  if (!state.enabled) {
    console.log('[Autopilot] Disabled, skipping run');
    return { success: false, reason: 'disabled' };
  }

  // Reset daily count if new day
  const today = new Date().toISOString().split('T')[0];
  if (state.lastResetDate !== today) {
    state.todayProductCount = 0;
    state.lastResetDate = today;
  }

  // Check daily limit
  if (state.todayProductCount >= state.maxDailyProducts) {
    console.log('[Autopilot] Daily limit reached:', state.maxDailyProducts);
    return { success: false, reason: 'daily_limit_reached' };
  }

  console.log('[Autopilot] Starting automated product discovery...');

  const runResult = {
    productsFound: 0,
    productsScored: 0,
    productsRouted: 0,
    productsPushed: 0,
    imagesGenerated: 0,
    suppliersFound: 0,
    errors: []
  };

  try {
    const config = loadConfig();
    const stores = loadStores();

    // Pick a random niche
    const niche = state.niches[Math.floor(Math.random() * state.niches.length)];
    console.log('[Autopilot] Searching niche:', niche);

    // Fetch products from TikTok Shop
    const products = await fetchTikTokProducts(niche, config.apiKey);

    if (!products || products.length === 0) {
      runResult.errors.push('No products found for niche: ' + niche);
      logAutopilotRun(runResult);
      return { success: false, reason: 'no_products', runResult };
    }

    runResult.productsFound = products.length;

    // Score products
    const scoredProducts = scoreProducts(products);
    runResult.productsScored = scoredProducts.length;

    // Filter by minimum AI score
    const qualifiedProducts = scoredProducts.filter(p => p.aiScore >= state.minAiScore);
    console.log('[Autopilot] Found', qualifiedProducts.length, 'products with score >=', state.minAiScore);

    // Process up to remaining daily limit
    const remaining = state.maxDailyProducts - state.todayProductCount;
    const toProcess = qualifiedProducts.slice(0, remaining);

    for (const product of toProcess) {
      try {
        // 1. Auto-route to best store (findBestStoreMatch expects the store MAP)
        const routeMatch = findBestStoreMatch(product, stores.stores);
        if (!routeMatch) {
          runResult.errors.push(`No store match for: ${product.title}`);
          continue;
        }
        runResult.productsRouted++;

        const store = stores.stores[routeMatch.storeId];
        if (!store.products || Array.isArray(store.products)) store.products = {};

        const storeProduct = {
          ...product,
          hash: hashProduct(product),
          addedAt: new Date().toISOString(),
          autoRouted: true,
          routeConfidence: routeMatch.confidence,
          status: 'curated',
          shopifyProductId: null
        };

        // 2. Find the CJ supplier FIRST — gives real product photos + links the product
        //    for auto-fulfillment (cjProductId/cjVariantId) and margin monitoring (cjUnitCost).
        let cjImages = [];
        if (state.autoFindSupplier && config.cjApiKey) {
          try {
            const suppliers = await searchCJProducts(product.title.split(' ').slice(0, 3).join(' '), config.cjApiKey);
            if (suppliers && suppliers.length > 0) {
              const sup = suppliers[0];
              storeProduct.cjSupplier = sup;
              storeProduct.cjProductId = sup.pid || sup.productId || sup.id;
              const img = sup.productImage || sup.bigImage || sup.image;
              if (img) cjImages = [img];
              runResult.suppliersFound++;
              // Resolve a concrete variant so fulfillment + margin work without a later lookup
              try {
                const accessToken = await getCJAccessToken();
                const v = await resolveCjVariant(storeProduct.cjProductId, accessToken);
                storeProduct.cjVariantId = v.vid;
                storeProduct.cjUnitCost = v.price;
              } catch (_) { /* vid resolved lazily at order time */ }
            }
          } catch (e) { /* supplier optional */ }
        }

        // 3. Prefer the real CJ supplier photo over the TikTok thumbnail
        if (cjImages.length) {
          storeProduct.cjImages = cjImages;
          storeProduct.image = cjImages[0];
        }

        // 4. AI image generation ONLY as a fallback when no real CJ image exists
        if (!cjImages.length && state.autoGenerateImages && config.openaiKey) {
          try {
            const openai = new OpenAI({ apiKey: config.openaiKey });
            const imageRes = await openai.images.generate({
              model: 'dall-e-3',
              prompt: `Professional product photo of ${product.title}, clean white background, e-commerce style, high quality`,
              n: 1,
              size: '1024x1024',
              quality: 'standard'
            });
            if (imageRes.data?.[0]?.url) {
              storeProduct.aiGeneratedImages = [imageRes.data[0].url];
              storeProduct.image = imageRes.data[0].url;
              runResult.imagesGenerated++;
            }
          } catch (e) {
            runResult.errors.push(`Image generation failed: ${e.message}`);
          }
        }

        // 5. Persist into the store's hash-keyed product map
        store.products[storeProduct.hash] = storeProduct;

        // 6. Push to Shopify (with the CJ-preferred images) if enabled and connected
        if (state.autoPushToShopify && store.shopify?.status === 'connected') {
          try {
            const shopifyProduct = await pushProductToShopify(store, storeProduct, config);
            if (shopifyProduct) {
              storeProduct.shopifyProductId = shopifyProduct.id;
              runResult.productsPushed++;
            }
          } catch (e) {
            runResult.errors.push(`Shopify push failed: ${e.message}`);
          }
        }

        state.todayProductCount++;

      } catch (e) {
        runResult.errors.push(`Error processing product: ${e.message}`);
      }
    }

    // Save stores
    saveStores(stores);

    // Update autopilot state
    state.lastRun = new Date().toISOString();
    saveAutopilotState(state);

    // Log the run
    logAutopilotRun(runResult);

    console.log('[Autopilot] Run complete:', runResult);
    return { success: true, runResult };

  } catch (e) {
    runResult.errors.push(`Fatal error: ${e.message}`);
    logAutopilotRun(runResult);
    return { success: false, error: e.message, runResult };
  }
}

// Helper to fetch products (reuse existing logic)
async function fetchTikTokProducts(query, apiKey) {
  try {
    const response = await axios.get('https://api.scrapecreators.com/v1/tiktokshop/search', {
      params: {
        query,
        region: 'US',
        page: 1
      },
      headers: {
        'x-api-key': apiKey
      }
    });

    if (response.data?.products) {
      return response.data.products.map(processShopItem).filter(p => p && p.price > 0);
    }
    return [];
  } catch (e) {
    console.error('[Autopilot] Fetch error:', e.message);
    return [];
  }
}

// Helper to push product to Shopify
async function pushProductToShopify(store, product, config) {
  // getShopifyAccessToken(shop, storeCredentials) — pass per-store creds object (falls back to global)
  const token = await getShopifyAccessToken(store.shopify.shop, getStoreCredentials(store));

  // Prefer real CJ supplier photos (multiple), else the TikTok thumbnail
  const imageSrcs = (product.cjImages && product.cjImages.length)
    ? product.cjImages
    : (product.image ? [product.image] : []);

  const shopifyProduct = {
    product: {
      title: product.title,
      body_html: product.description || `<p>${product.title}</p>`,
      vendor: product.seller || 'TikTok Shop',
      product_type: product.category || 'General',
      tags: ['autopilot', 'tiktok-shop'],
      variants: [{
        price: (product.price * 1.5).toFixed(2),
        compare_at_price: (product.price * 2).toFixed(2),
        inventory_management: 'shopify',
        inventory_quantity: 100
      }],
      images: imageSrcs.map(src => ({ src }))
    }
  };

  const res = await axios.post(
    `https://${store.shopify.shop}/admin/api/2024-01/products.json`,
    shopifyProduct,
    { headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' } }
  );

  return res.data.product;
}

// Helper to search CJ products
async function searchCJProducts(keyword, apiKey) {
  const tokenData = loadConfig().cjTokenCache;
  if (!tokenData?.accessToken) return null;

  const res = await axios.get('https://developers.cjdropshipping.com/api2.0/v1/product/list', {
    params: {
      productNameEn: keyword,
      pageNum: 1,
      pageSize: 5
    },
    headers: { 'CJ-Access-Token': tokenData.accessToken }
  });

  return res.data?.data?.list || [];
}

// Start/stop cron job
function startAutopilotCron(schedule) {
  if (autopilotCronJob) {
    autopilotCronJob.stop();
  }

  if (cron.validate(schedule)) {
    autopilotCronJob = cron.schedule(schedule, async () => {
      console.log('[Autopilot] Cron triggered at', new Date().toISOString());
      await runAutopilot();
    });
    console.log('[Autopilot] Cron scheduled:', schedule);
  } else {
    console.error('[Autopilot] Invalid cron schedule:', schedule);
  }
}

function stopAutopilotCron() {
  if (autopilotCronJob) {
    autopilotCronJob.stop();
    autopilotCronJob = null;
    console.log('[Autopilot] Cron stopped');
  }
}

// ================== MULTI-TASK JOB SCHEDULER ==================
// Named registry of cron jobs (fulfillment, inventory, pricing, ads, research, summary).
// Replaces the single autopilot cron. State persisted in scheduler_state.json.

const SCHEDULER_PATH = path.join(DATA_DIR, 'scheduler_state.json');

const DEFAULT_SCHEDULER_STATE = {
  jobs: {
    'fulfillment-sweep':    { cron: '*/15 * * * *', enabled: false, lastRun: null, lastResult: null },
    'inventory-sync':       { cron: '0 */4 * * *',  enabled: false, lastRun: null, lastResult: null },
    'price-margin-monitor': { cron: '0 */6 * * *',  enabled: false, lastRun: null, lastResult: null },
    'ad-metrics':           { cron: '0 9 * * *',    enabled: false, lastRun: null, lastResult: null },
    'api-health':           { cron: '0 * * * *',    enabled: false, lastRun: null, lastResult: null },
    'product-research':     { cron: '0 */6 * * *',  enabled: false, lastRun: null, lastResult: null },
    'daily-summary':        { cron: '0 18 * * *',   enabled: false, lastRun: null, lastResult: null }
  },
  globalAutonomy: 'full', // 'full' = act + report | 'suggest' = alert only | 'off' = do nothing
  meta: { version: '1.0' }
};

function loadScheduler() {
  let stored = {};
  try {
    if (fs.existsSync(SCHEDULER_PATH)) stored = JSON.parse(fs.readFileSync(SCHEDULER_PATH, 'utf8'));
  } catch (e) {
    console.error('Scheduler load error:', e.message);
  }
  // Merge per-job so jobs added in code appear even for older state files
  const jobs = {};
  for (const [name, def] of Object.entries(DEFAULT_SCHEDULER_STATE.jobs)) {
    jobs[name] = { ...def, ...(stored.jobs?.[name] || {}) };
  }
  for (const [name, j] of Object.entries(stored.jobs || {})) {
    if (!jobs[name]) jobs[name] = j; // preserve unknown/legacy jobs
  }
  return {
    jobs,
    globalAutonomy: stored.globalAutonomy || DEFAULT_SCHEDULER_STATE.globalAutonomy,
    meta: { ...DEFAULT_SCHEDULER_STATE.meta, ...(stored.meta || {}) }
  };
}

function saveScheduler(state) {
  fs.writeFileSync(SCHEDULER_PATH, JSON.stringify(state, null, 2));
}

// Effective autonomy: env kill-switch overrides persisted state.
function getAutonomyMode() {
  if (process.env.AUTONOMY_DISABLED === '1') return 'off';
  return loadScheduler().globalAutonomy || 'full';
}

// name -> { handler, jobRef }
const JOB_REGISTRY = {};

function registerJob(name, handler) {
  JOB_REGISTRY[name] = { handler, jobRef: JOB_REGISTRY[name]?.jobRef || null };
}

// Run a job once, record lastRun/lastResult, never throw.
async function executeJob(name, opts = {}) {
  const reg = JOB_REGISTRY[name];
  if (!reg) return { success: false, error: 'Unknown job: ' + name };

  const startedAt = new Date().toISOString();
  let result;
  try {
    console.log(`[Scheduler] ▶ ${name}${opts.dryRun ? ' (dry-run)' : ''}`);
    result = await reg.handler({ jobName: name, autonomy: getAutonomyMode(), dryRun: !!opts.dryRun });
    if (!result || typeof result !== 'object') result = { success: true, result };
  } catch (e) {
    result = { success: false, error: e.message };
    console.error(`[Scheduler] ✖ ${name}:`, e.message);
  }

  const state = loadScheduler();
  if (state.jobs[name]) {
    state.jobs[name].lastRun = startedAt;
    state.jobs[name].lastResult = result;
    saveScheduler(state);
  }
  return result;
}

function startJob(name) {
  const state = loadScheduler();
  const cfg = state.jobs[name];
  const reg = JOB_REGISTRY[name];
  if (!cfg || !reg) return false;

  if (reg.jobRef) { reg.jobRef.stop(); reg.jobRef = null; }
  if (!cfg.enabled) return false;
  if (!cron.validate(cfg.cron)) {
    console.error(`[Scheduler] Invalid cron for ${name}: ${cfg.cron}`);
    return false;
  }
  reg.jobRef = cron.schedule(cfg.cron, () => { executeJob(name); });
  console.log(`[Scheduler] Scheduled ${name} (${cfg.cron})`);
  return true;
}

function stopJob(name) {
  const reg = JOB_REGISTRY[name];
  if (reg?.jobRef) { reg.jobRef.stop(); reg.jobRef = null; console.log(`[Scheduler] Stopped ${name}`); }
}

function startAllJobs() {
  const state = loadScheduler();
  let started = 0;
  for (const name of Object.keys(JOB_REGISTRY)) {
    if (state.jobs[name]?.enabled && startJob(name)) started++;
  }
  console.log(`[Scheduler] Started ${started} enabled job(s); autonomy=${getAutonomyMode()}`);
}

const runJobNow = (name, opts) => executeJob(name, opts);

// Legacy autopilot endpoints now drive the scheduler's product-research job
// (single source of truth — prevents a parallel cron double-running research).
function syncProductResearchJob(enabled, cronExpr) {
  const state = loadScheduler();
  if (enabled !== undefined) state.jobs['product-research'].enabled = !!enabled;
  if (cronExpr && cron.validate(cronExpr)) state.jobs['product-research'].cron = cronExpr;
  saveScheduler(state);
  if (state.jobs['product-research'].enabled) startJob('product-research'); else stopJob('product-research');
}

// One-time migration: seed product-research from the legacy autopilot state.
function seedSchedulerFromAutopilot() {
  if (fs.existsSync(SCHEDULER_PATH)) return;
  const auto = loadAutopilotState();
  const state = loadScheduler();
  state.jobs['product-research'].enabled = !!auto.enabled;
  if (auto.scheduleInterval && cron.validate(auto.scheduleInterval)) {
    state.jobs['product-research'].cron = auto.scheduleInterval;
  }
  saveScheduler(state);
  console.log('[Scheduler] Seeded from legacy autopilot (product-research.enabled=' + !!auto.enabled + ')');
}

// ================== ALERTING + AUDIT LOG ==================

const ACTIONS_LOG_PATH = path.join(DATA_DIR, 'actions_log.json');
const ALERTS_LOG_PATH = path.join(DATA_DIR, 'alerts_log.json');

function loadJsonArray(p) {
  try { if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { console.error('read', p, e.message); }
  return [];
}
function saveJsonArray(p, arr) { fs.writeFileSync(p, JSON.stringify(arr, null, 2)); }

function getAlertWebhookUrl() {
  return (process.env.ALERT_WEBHOOK_URL || loadConfig().alertWebhookUrl || '').trim();
}

// Post a message to the configured Slack OR Discord webhook (auto-detected by URL).
// Always records the alert locally; no-ops the network call if no webhook is set.
async function notify(level, title, body, meta = {}) {
  const at = new Date().toISOString();
  const entry = { level, title, body: body || '', meta, at };

  try {
    const alerts = loadJsonArray(ALERTS_LOG_PATH);
    alerts.unshift(entry);
    saveJsonArray(ALERTS_LOG_PATH, alerts.slice(0, 200));
  } catch (e) { /* non-fatal */ }

  const url = getAlertWebhookUrl();
  const emoji = { info: 'ℹ️', warn: '⚠️', error: '🚨', action: '⚙️' }[level] || '•';
  if (!url) {
    console.log(`[notify:${level}] ${title} — ${body || ''} (no webhook configured)`);
    return { sent: false, reason: 'no-webhook' };
  }

  try {
    const isDiscord = url.includes('discord.com/api/webhooks') || url.includes('discordapp.com/api/webhooks');
    if (isDiscord) {
      const color = { info: 3447003, warn: 16776960, error: 15158332, action: 3066993 }[level] || 8421504;
      await axios.post(url, {
        embeds: [{
          title: `${emoji} ${title}`.slice(0, 256),
          description: (body || '').slice(0, 4000),
          color, timestamp: at,
          footer: { text: meta.store || meta.job || 'product-trends' }
        }]
      });
    } else {
      const ctx = [meta.store && `store: ${meta.store}`, meta.job && `job: ${meta.job}`].filter(Boolean).join(' · ');
      await axios.post(url, { text: `${emoji} *${title}*\n${body || ''}${ctx ? `\n_${ctx}_` : ''}` });
    }
    return { sent: true };
  } catch (e) {
    console.error('[notify] webhook post failed:', e.message);
    return { sent: false, reason: e.message };
  }
}

// Append-only audit trail for every autonomous (and agent) action.
function logAction(entry) {
  const actions = loadJsonArray(ACTIONS_LOG_PATH);
  const record = {
    id: 'act_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    at: new Date().toISOString(),
    autonomous: true,
    source: 'daemon',
    dryRun: false,
    ...entry
  };
  actions.unshift(record);
  saveJsonArray(ACTIONS_LOG_PATH, actions.slice(0, 1000));
  return record;
}

// ---- Alerting / audit API ----
app.post('/api/config/alert-webhook', (req, res) => {
  try {
    const { url } = req.body || {};
    const config = loadConfig();
    config.alertWebhookUrl = (url || '').trim();
    saveConfig(config);
    res.json({ success: true, hasWebhook: !!config.alertWebhookUrl, usingEnv: !!process.env.ALERT_WEBHOOK_URL });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

app.post('/api/alerts/test', async (req, res) => {
  const result = await notify('info', 'Test alert', 'If you can read this, your webhook is wired up correctly. ✅', { job: 'manual-test' });
  res.json({ success: result.sent, ...result });
});

app.get('/api/alerts/recent', (req, res) => {
  const limit = parseInt(req.query.limit) || 30;
  res.json({ success: true, alerts: loadJsonArray(ALERTS_LOG_PATH).slice(0, limit) });
});

app.get('/api/actions', (req, res) => {
  const { store, type, job, source, limit = 50 } = req.query;
  let actions = loadJsonArray(ACTIONS_LOG_PATH);
  if (store) actions = actions.filter(a => a.store === store);
  if (type) actions = actions.filter(a => a.type === type);
  if (job) actions = actions.filter(a => a.job === job);
  if (source) actions = actions.filter(a => a.source === source);
  res.json({ success: true, actions: actions.slice(0, parseInt(limit)) });
});

// ---- Job handlers ----
// Real handler: product research wraps the existing autopilot routine.
registerJob('product-research', async () => {
  return await runAutopilot();
});

// Daily summary: aggregate the last 24h and post one digest to the alert channel.
registerJob('daily-summary', async () => {
  const since = Date.now() - 24 * 60 * 60 * 1000;
  const within = (iso) => iso && new Date(iso).getTime() >= since;

  const ordersDb = loadOrders();
  const orders24 = (ordersDb.orders || []).filter(o => within(o.createdAt));
  const byStatus = orders24.reduce((m, o) => { m[o.status] = (m[o.status] || 0) + 1; return m; }, {});

  const actions24 = loadJsonArray(ACTIONS_LOG_PATH).filter(a => within(a.at));
  const actionsByType = actions24.reduce((m, a) => { m[a.type] = (m[a.type] || 0) + 1; return m; }, {});

  // Low-stock count across stores
  let lowStock = 0;
  const stores = loadStores().stores || {};
  for (const s of Object.values(stores)) {
    for (const inv of Object.values(s.inventory || {})) {
      if ((inv.totalQuantity ?? 99) <= 5) lowStock++;
    }
  }

  const lines = [
    `*Orders (24h):* ${orders24.length}` + (Object.keys(byStatus).length ? ` — ${Object.entries(byStatus).map(([k, v]) => `${k}: ${v}`).join(', ')}` : ''),
    `*Autonomous actions (24h):* ${actions24.length}` + (Object.keys(actionsByType).length ? ` — ${Object.entries(actionsByType).map(([k, v]) => `${k}: ${v}`).join(', ')}` : ''),
    `*Low-stock products:* ${lowStock}`,
    `*Autonomy mode:* ${getAutonomyMode()}`
  ];
  const body = lines.join('\n');
  await notify('info', '📊 Daily Summary', body, { job: 'daily-summary' });
  return { success: true, orders24: orders24.length, actions24: actions24.length, lowStock };
});

// ================== PHASE 3: MONITORING DAEMON JOBS ==================
// Every mutating job is bounded, audited (logAction), alert-emitting (notify),
// and gated by autonomy: 'full' acts, 'suggest' detects+alerts only, 'off' skips.
// dryRun (from /run) forces detect-only regardless of autonomy.

const DEFAULT_BOUNDS = {
  maxRetries: 4,
  retryBackoffMin: 30,       // base minutes; doubles each retry
  maxActionsPerRun: 25,      // per-store mutation cap (runaway guard)
  lowStockThreshold: 5,
  targetMargin: 25,          // desired net margin %
  marginFloor: 12,           // never reprice below this net margin %
  maxPriceChangePct: 15,     // clamp price moves per run
  repriceCooldownHrs: 24,    // ≤1 reprice/product/day
  roasThreshold: 1.5,
  autoPauseAds: false        // pausing ad spend stays suggest-only unless true
};

const connectedStores = () =>
  Object.values(loadStores().stores || {}).filter(s => s.shopify?.shop);

async function getShopifyProductsLive(store, accessToken) {
  const res = await axios.get(
    `https://${store.shopify.shop}/admin/api/2024-01/products.json?limit=250`,
    { headers: { 'X-Shopify-Access-Token': accessToken } }
  );
  return res.data.products || [];
}

async function setShopifyProductStatus(store, accessToken, productId, status) {
  await axios.put(
    `https://${store.shopify.shop}/admin/api/2024-01/products/${productId}.json`,
    { product: { id: productId, status } },
    { headers: { 'X-Shopify-Access-Token': accessToken } }
  );
}

async function setShopifyVariantPrice(store, accessToken, variantId, price) {
  await axios.put(
    `https://${store.shopify.shop}/admin/api/2024-01/variants/${variantId}.json`,
    { variant: { id: variantId, price: String(price) } },
    { headers: { 'X-Shopify-Access-Token': accessToken } }
  );
}

// (Re)create the CJ order for a stored order. Prefers the persisted webhook payload
// (works cross-org with no read_orders scope); falls back to a Shopify refetch if absent.
async function retryOrderFulfillment(order) {
  const store = loadStores().stores[order.storeId];
  if (!store) throw new Error('Store not found');
  if (order.payload && order.payload.line_items) {
    return await createCJOrder(order.payload, order.storeId);
  }
  if (!store.shopify?.shop) throw new Error('Store not connected to Shopify');
  const token = await getShopifyAccessToken(store.shopify.shop, getStoreCredentials(store));
  const resp = await axios.get(
    `https://${store.shopify.shop}/admin/api/2024-01/orders/${order.shopifyOrderId}.json`,
    { headers: { 'X-Shopify-Access-Token': token } }
  );
  return await createCJOrder(resp.data.order, store.id);
}

// ---- fulfillment-sweep: retry failed/held orders with exponential backoff ----
registerJob('fulfillment-sweep', async ({ autonomy, dryRun }) => {
  const b = DEFAULT_BOUNDS;
  const ordersDb = loadOrders();
  const now = Date.now();
  const candidates = (ordersDb.orders || []).filter(o =>
    (o.status === 'failed' || o.status === 'held') &&
    (o.retryCount || 0) < b.maxRetries &&
    (!o.nextRetryAt || new Date(o.nextRetryAt).getTime() <= now)
  ).slice(0, b.maxActionsPerRun);

  const act = autonomy === 'full' && !dryRun;
  let recovered = 0, exhausted = 0, stillFailing = 0;
  const planned = [];

  for (const order of candidates) {
    if (!act) { planned.push({ order: order.shopifyOrderNumber, store: order.storeName, wouldRetry: true }); continue; }
    order.retryCount = (order.retryCount || 0) + 1;
    try {
      const cj = await retryOrderFulfillment(order);
      order.status = 'submitted'; order.cjOrderId = cj.cjOrderId; order.cjOrderNumber = cj.cjOrderNumber;
      order.error = null; order.submittedAt = new Date().toISOString(); order.nextRetryAt = null;
      recovered++;
      logAction({ job: 'fulfillment-sweep', store: order.storeName, type: 'retry-order', decision: `retry #${order.retryCount}`, result: 'recovered', after: { cjOrderNumber: cj.cjOrderNumber } });
      await notify('action', 'Order recovered', `#${order.shopifyOrderNumber} → CJ ${cj.cjOrderNumber}`, { store: order.storeName });
    } catch (e) {
      order.error = e.message;
      if (order.retryCount >= b.maxRetries) {
        order.status = 'needs_human'; exhausted++;
        logAction({ job: 'fulfillment-sweep', store: order.storeName, type: 'retry-order', result: 'exhausted', error: e.message });
        await notify('error', 'Order needs manual help', `#${order.shopifyOrderNumber}: ${e.message}`, { store: order.storeName });
      } else {
        const backoff = b.retryBackoffMin * Math.pow(2, order.retryCount - 1);
        order.nextRetryAt = new Date(now + backoff * 60000).toISOString();
        stillFailing++;
        logAction({ job: 'fulfillment-sweep', store: order.storeName, type: 'retry-order', result: 'will-retry', error: e.message, after: { nextRetryAt: order.nextRetryAt } });
      }
    }
  }
  if (act) saveOrders(ordersDb);
  return { success: true, autonomy, acted: act, candidates: candidates.length, recovered, exhausted, stillFailing, planned: act ? undefined : planned };
});

// ---- inventory-sync: hide out-of-stock, restock auto-hidden, flag low stock ----
registerJob('inventory-sync', async ({ autonomy, dryRun }) => {
  const b = DEFAULT_BOUNDS;
  const act = autonomy === 'full' && !dryRun;
  const storesData = loadStores();
  let hidden = 0, restocked = 0, lowStock = 0, changed = false;
  const planned = [];

  for (const store of Object.values(storesData.stores || {})) {
    if (!store.shopify?.shop) continue;
    let token, products;
    try {
      token = await getShopifyAccessToken(store.shopify.shop, getStoreCredentials(store));
      products = await getShopifyProductsLive(store, token);
    } catch (e) { continue; }

    if (!store.inventory) store.inventory = {};
    if (!store.autoHidden) store.autoHidden = {};
    let storeActions = 0;

    for (const p of products) {
      const qty = (p.variants || []).reduce((s, v) => s + (v.inventory_quantity || 0), 0);
      store.inventory[p.id] = { productId: p.id, title: p.title, totalQuantity: qty, status: p.status, lastSynced: new Date().toISOString() };
      changed = true;

      if (qty <= 0 && p.status === 'active' && storeActions < b.maxActionsPerRun) {
        planned.push({ store: store.name, product: p.title, action: 'hide (out of stock)' });
        if (act) {
          try {
            await setShopifyProductStatus(store, token, p.id, 'draft');
            store.autoHidden[p.id] = true; hidden++; storeActions++;
            logAction({ job: 'inventory-sync', store: store.name, type: 'hide-product', decision: 'out of stock', after: { productId: p.id, status: 'draft' } });
            await notify('action', 'Hid out-of-stock product', `${p.title} (${store.name})`, { store: store.name });
          } catch (e) { /* skip */ }
        }
      } else if (qty > 0 && p.status === 'draft' && store.autoHidden[p.id] && storeActions < b.maxActionsPerRun) {
        // Only un-hide products WE auto-hid — never touch drafts the user left intentionally
        planned.push({ store: store.name, product: p.title, action: 'restock (un-hide)' });
        if (act) {
          try {
            await setShopifyProductStatus(store, token, p.id, 'active');
            delete store.autoHidden[p.id]; restocked++; storeActions++;
            logAction({ job: 'inventory-sync', store: store.name, type: 'restock-product', decision: 'back in stock', after: { productId: p.id, status: 'active' } });
            await notify('action', 'Restocked product', `${p.title} (${store.name})`, { store: store.name });
          } catch (e) { /* skip */ }
        }
      } else if (qty > 0 && qty <= b.lowStockThreshold) {
        lowStock++;
      }
    }
  }
  if (act && changed) saveStores(storesData);
  return { success: true, autonomy, acted: act, hidden, restocked, lowStock, planned: act ? undefined : planned.slice(0, 50) };
});

// ---- price-margin-monitor: bounded auto-reprice when net margin drifts below target ----
registerJob('price-margin-monitor', async ({ autonomy, dryRun }) => {
  const b = DEFAULT_BOUNDS;
  const act = autonomy === 'full' && !dryRun;
  const storesData = loadStores();
  const now = Date.now();
  let repriced = 0, scanned = 0, belowTarget = 0;
  const planned = [];

  // Net margin model: profit = price - cjCost - shipping - platformFees(15%)
  const SHIP = 5;
  const netMarginPct = (price, cost) => price > 0 ? ((price - cost - SHIP - price * 0.15) / price) * 100 : 0;
  // Price that restores target margin: price*(1 - 0.15 - t) = cost + SHIP
  const priceForTarget = (cost, t) => (cost + SHIP) / (1 - 0.15 - t / 100);

  for (const store of Object.values(storesData.stores || {})) {
    if (!store.shopify?.shop) continue;
    let token, products;
    try {
      token = await getShopifyAccessToken(store.shopify.shop, getStoreCredentials(store));
      products = await getShopifyProductsLive(store, token);
    } catch (e) { continue; }

    let storeActions = 0;
    for (const p of products) {
      // Match to a local store product carrying a known CJ cost
      const sp = Object.values(store.products || {}).find(x => String(x.shopifyProductId) === String(p.id) && x.cjUnitCost);
      const variant = p.variants?.[0];
      if (!sp || !variant) continue;
      const cost = parseFloat(sp.cjUnitCost);
      const price = parseFloat(variant.price);
      if (!cost || !price) continue;
      scanned++;

      const margin = netMarginPct(price, cost);
      if (margin >= b.targetMargin) continue;
      belowTarget++;

      // Cooldown: at most one reprice per product per day
      if (sp.lastRepricedAt && (now - new Date(sp.lastRepricedAt).getTime()) < b.repriceCooldownHrs * 3600000) continue;

      let target = priceForTarget(cost, b.targetMargin);
      // Clamp move to ±maxPriceChangePct of current
      const maxUp = price * (1 + b.maxPriceChangePct / 100);
      const newPrice = Math.min(target, maxUp);
      const newMargin = netMarginPct(newPrice, cost);

      // Never set a price whose margin is below the floor (don't sell at a loss)
      if (newMargin < b.marginFloor) {
        planned.push({ store: store.name, product: p.title, issue: `margin ${margin.toFixed(1)}% — can't reach floor within bounds`, alertOnly: true });
        await notify('warn', 'Margin too low to fix automatically', `${p.title} (${store.name}) at $${price} cost $${cost} → margin ${margin.toFixed(1)}%`, { store: store.name });
        continue;
      }

      planned.push({ store: store.name, product: p.title, from: price, to: +newPrice.toFixed(2), marginFrom: +margin.toFixed(1), marginTo: +newMargin.toFixed(1) });
      if (act && storeActions < b.maxActionsPerRun) {
        try {
          await setShopifyVariantPrice(store, token, variant.id, newPrice.toFixed(2));
          sp.customPrice = +newPrice.toFixed(2); sp.lastRepricedAt = new Date().toISOString();
          if (typeof recordPrice === 'function') { try { recordPrice({ ...sp, price: +newPrice.toFixed(2) }); } catch (_) {} }
          repriced++; storeActions++;
          logAction({ job: 'price-margin-monitor', store: store.name, type: 'reprice', decision: `restore ~${b.targetMargin}% margin`, before: { price, margin: +margin.toFixed(1) }, after: { price: +newPrice.toFixed(2), margin: +newMargin.toFixed(1) } });
          await notify('action', 'Repriced product', `${p.title} (${store.name}): $${price} → $${newPrice.toFixed(2)} (margin ${margin.toFixed(1)}%→${newMargin.toFixed(1)}%)`, { store: store.name });
        } catch (e) { /* skip */ }
      }
    }
  }
  if (act) saveStores(storesData);
  return { success: true, autonomy, acted: act, scanned, belowTarget, repriced, planned: act ? undefined : planned.slice(0, 50) };
});

// ---- ad-metrics: read Meta ROAS, recommend (pausing stays suggest-only by default) ----
registerJob('ad-metrics', async ({ autonomy, dryRun }) => {
  const config = loadConfig();
  const token = process.env.META_ADS_TOKEN || config.metaAdsToken;
  const acct = config.metaAdAccountId;
  if (!token || !acct) return { success: true, note: 'Meta ads not configured (set metaAdsToken + metaAdAccountId)' };

  let insights;
  try {
    const res = await axios.get(`https://graph.facebook.com/v19.0/act_${acct}/insights`, {
      params: { level: 'campaign', fields: 'campaign_name,spend,purchase_roas', date_preset: 'last_7d', access_token: token }
    });
    insights = res.data?.data || [];
  } catch (e) {
    await notify('error', 'Meta ads fetch failed', e.message, { job: 'ad-metrics' });
    return { success: false, error: e.message };
  }

  const b = DEFAULT_BOUNDS;
  const lowRoas = insights.map(i => ({
    name: i.campaign_name,
    spend: parseFloat(i.spend || 0),
    roas: parseFloat(i.purchase_roas?.[0]?.value || 0)
  })).filter(c => c.spend > 0 && c.roas < b.roasThreshold);

  if (lowRoas.length) {
    const body = lowRoas.map(c => `${c.name}: ROAS ${c.roas.toFixed(2)} on $${c.spend.toFixed(0)} spend`).join('\n');
    await notify('warn', `⚠️ ${lowRoas.length} underperforming ad campaign(s)`, body + (b.autoPauseAds ? '' : '\n(Enable bounds.autoPauseAds to auto-pause)'), { job: 'ad-metrics' });
  }
  // Pausing ad spend is high-impact: only act if explicitly opted in AND autonomy=full
  return { success: true, autonomy, campaigns: insights.length, lowRoas: lowRoas.length, autoPaused: 0, note: b.autoPauseAds ? 'auto-pause enabled' : 'suggest-only' };
});

// ---- api-health: ping external APIs/tokens, alert on breakage (read-only) ----
registerJob('api-health', async () => {
  const config = loadConfig();
  const checks = [];
  try { await getCJAccessToken(); checks.push({ api: 'CJ', ok: true }); }
  catch (e) { checks.push({ api: 'CJ', ok: false, error: e.message }); }
  checks.push({ api: 'OpenAI', ok: !!(process.env.OPENAI_KEY || config.openaiKey) });
  checks.push({ api: 'Apify', ok: !!(process.env.APIFY_KEY || config.apifyKey) });
  for (const s of connectedStores()) {
    try { await getShopifyAccessToken(s.shopify.shop, getStoreCredentials(s)); checks.push({ api: `Shopify:${s.name}`, ok: true }); }
    catch (e) { checks.push({ api: `Shopify:${s.name}`, ok: false, error: e.message }); }
  }
  const failing = checks.filter(c => !c.ok);
  if (failing.length) {
    await notify('error', 'API health check failing', failing.map(f => `${f.api}: ${f.error || 'not configured'}`).join('\n'), { job: 'api-health' });
  }
  return { success: true, checks, failing: failing.length };
});

// ---- Scheduler management API ----
app.get('/api/scheduler', (req, res) => {
  const state = loadScheduler();
  const jobs = Object.entries(state.jobs).map(([name, cfg]) => ({
    name, ...cfg,
    registered: !!JOB_REGISTRY[name],
    running: !!JOB_REGISTRY[name]?.jobRef
  }));
  res.json({ success: true, autonomy: getAutonomyMode(), persistedAutonomy: state.globalAutonomy, envKillSwitch: process.env.AUTONOMY_DISABLED === '1', jobs });
});

// Must be declared before '/api/scheduler/:name' so 'autonomy' isn't captured as a job name
app.post('/api/scheduler/autonomy', (req, res) => {
  try {
    const { mode } = req.body || {};
    if (!['full', 'suggest', 'off'].includes(mode)) {
      return res.json({ success: false, error: "mode must be 'full', 'suggest', or 'off'" });
    }
    const state = loadScheduler();
    state.globalAutonomy = mode;
    saveScheduler(state);
    res.json({ success: true, persistedAutonomy: mode, effectiveAutonomy: getAutonomyMode(), envKillSwitch: process.env.AUTONOMY_DISABLED === '1' });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

app.post('/api/scheduler/:name', (req, res) => {
  try {
    const { name } = req.params;
    const { cron: cronExpr, enabled } = req.body || {};
    const state = loadScheduler();
    if (!state.jobs[name]) return res.json({ success: false, error: 'Unknown job: ' + name });

    if (cronExpr !== undefined) {
      if (!cron.validate(cronExpr)) return res.json({ success: false, error: 'Invalid cron expression' });
      state.jobs[name].cron = cronExpr;
    }
    if (enabled !== undefined) state.jobs[name].enabled = !!enabled;
    saveScheduler(state);

    // Apply immediately
    if (state.jobs[name].enabled) startJob(name); else stopJob(name);

    res.json({ success: true, job: { name, ...state.jobs[name], running: !!JOB_REGISTRY[name]?.jobRef } });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

app.post('/api/scheduler/:name/run', async (req, res) => {
  const { name } = req.params;
  if (!JOB_REGISTRY[name]) return res.json({ success: false, error: 'Unknown job: ' + name });
  const result = await runJobNow(name, { dryRun: !!(req.body && req.body.dryRun) });
  res.json({ success: true, name, result });
});

// ---- Admin state seed/export (for migrating local state onto a prod volume) ----
// Protected by the ADMIN_TOKEN env var. Used once after deploy to push stores.json
// and config.json (CJ token cache, per-store creds) onto the mounted volume.
function requireAdmin(req, res) {
  if (!process.env.ADMIN_TOKEN || req.headers['x-admin-token'] !== process.env.ADMIN_TOKEN) {
    res.status(403).json({ success: false, error: 'forbidden' });
    return false;
  }
  return true;
}

app.post('/api/admin/restore-state', (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { stores, config } = req.body || {};
    const written = [];
    if (stores && stores.stores) { saveStores(stores); written.push('stores.json'); }
    if (config && typeof config === 'object') {
      // Merge onto whatever the file has; env still overrides at read time
      const merged = { ...loadConfig(), ...config };
      saveConfig(merged);
      written.push('config.json');
    }
    res.json({ success: true, written });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

app.get('/api/admin/state-summary', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const stores = loadStores();
  const cfg = loadConfig();
  res.json({
    success: true,
    dataDir: DATA_DIR,
    storeCount: Object.keys(stores.stores || {}).length,
    hasCjToken: !!cfg.cjTokenCache?.accessToken,
    hasOpenAI: !!cfg.openaiKey,
    hasCjKey: !!cfg.cjApiKey
  });
});

// ================== AUTOPILOT API ENDPOINTS ==================

// Get autopilot settings
app.get('/api/autopilot/settings', (req, res) => {
  const state = loadAutopilotState();
  res.json({ success: true, settings: state });
});

// Update autopilot settings
app.post('/api/autopilot/settings', (req, res) => {
  try {
    const state = loadAutopilotState();
    const updates = req.body;

    // Update allowed fields
    const allowedFields = [
      'enabled', 'minAiScore', 'maxDailyProducts', 'autoGenerateImages',
      'autoGenerateVideos', 'autoPost', 'autoPushToShopify', 'autoFindSupplier',
      'scheduleInterval', 'notifyEmail', 'niches'
    ];

    allowedFields.forEach(field => {
      if (updates[field] !== undefined) {
        state[field] = updates[field];
      }
    });

    saveAutopilotState(state);

    // Drive the scheduler's product-research job (legacy autopilot is now a scheduler job)
    if (updates.scheduleInterval !== undefined || updates.enabled !== undefined) {
      syncProductResearchJob(state.enabled, state.scheduleInterval);
    }

    res.json({ success: true, settings: state });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Toggle autopilot on/off
app.post('/api/autopilot/toggle', (req, res) => {
  try {
    const state = loadAutopilotState();
    state.enabled = !state.enabled;
    saveAutopilotState(state);

    syncProductResearchJob(state.enabled, state.scheduleInterval);

    res.json({ success: true, enabled: state.enabled });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Manually trigger autopilot run
app.post('/api/autopilot/run', async (req, res) => {
  try {
    // Temporarily enable for manual run
    const state = loadAutopilotState();
    const wasEnabled = state.enabled;
    state.enabled = true;
    saveAutopilotState(state);

    const result = await runAutopilot();

    // Restore state
    if (!wasEnabled) {
      state.enabled = false;
      saveAutopilotState(state);
    }

    res.json({ success: true, ...result });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Get autopilot logs
app.get('/api/autopilot/logs', (req, res) => {
  const logs = loadAutopilotLogs();
  const limit = parseInt(req.query.limit) || 20;
  res.json({
    success: true,
    logs: logs.runs.slice(0, limit),
    totalRuns: logs.runs.length,
    totalProductsProcessed: logs.totalProductsProcessed,
    totalPushed: logs.totalPushed
  });
});

// Get autopilot status (quick check)
app.get('/api/autopilot/status', (req, res) => {
  const state = loadAutopilotState();
  const logs = loadAutopilotLogs();

  res.json({
    success: true,
    enabled: state.enabled,
    lastRun: state.lastRun,
    todayProductCount: state.todayProductCount,
    maxDailyProducts: state.maxDailyProducts,
    nextRun: autopilotCronJob ? 'Scheduled' : 'Not scheduled',
    totalRuns: logs.runs.length,
    recentRun: logs.runs[0] || null
  });
});

// ================== SOCIAL MEDIA SCHEDULING ==================

const SOCIAL_CALENDAR_PATH = path.join(DATA_DIR, 'social_calendar.json');

function loadSocialCalendar() {
  try {
    if (fs.existsSync(SOCIAL_CALENDAR_PATH)) {
      return JSON.parse(fs.readFileSync(SOCIAL_CALENDAR_PATH, 'utf8'));
    }
  } catch (e) {
    console.error('Social calendar load error:', e.message);
  }
  return { scheduledPosts: [], postedHistory: [] };
}

function saveSocialCalendar(calendar) {
  fs.writeFileSync(SOCIAL_CALENDAR_PATH, JSON.stringify(calendar, null, 2));
}

// Get content calendar
app.get('/api/social/calendar', (req, res) => {
  const calendar = loadSocialCalendar();
  res.json({ success: true, ...calendar });
});

// Schedule a post
app.post('/api/social/schedule', (req, res) => {
  try {
    const { productId, platform, content, scheduledFor, mediaUrls } = req.body;

    if (!productId || !platform || !content || !scheduledFor) {
      return res.json({ success: false, error: 'Missing required fields' });
    }

    const calendar = loadSocialCalendar();
    const postId = 'post_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);

    calendar.scheduledPosts.push({
      id: postId,
      productId,
      platform, // 'tiktok', 'instagram', 'facebook'
      content,
      mediaUrls: mediaUrls || [],
      scheduledFor: new Date(scheduledFor).toISOString(),
      createdAt: new Date().toISOString(),
      status: 'scheduled'
    });

    // Sort by scheduled time
    calendar.scheduledPosts.sort((a, b) => new Date(a.scheduledFor) - new Date(b.scheduledFor));

    saveSocialCalendar(calendar);

    res.json({ success: true, postId, message: 'Post scheduled' });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Cancel scheduled post
app.delete('/api/social/schedule/:postId', (req, res) => {
  try {
    const calendar = loadSocialCalendar();
    calendar.scheduledPosts = calendar.scheduledPosts.filter(p => p.id !== req.params.postId);
    saveSocialCalendar(calendar);
    res.json({ success: true, message: 'Post cancelled' });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Post immediately (manual trigger)
app.post('/api/social/post', async (req, res) => {
  try {
    const { platform, content, mediaUrls, productId } = req.body;
    const config = loadConfig();

    // Note: Actual posting requires platform-specific API integration
    // This is a placeholder that logs the intent

    const calendar = loadSocialCalendar();
    const postRecord = {
      id: 'posted_' + Date.now(),
      productId,
      platform,
      content,
      mediaUrls,
      postedAt: new Date().toISOString(),
      status: 'posted_manually'
    };

    // For now, just record the post
    calendar.postedHistory.unshift(postRecord);
    calendar.postedHistory = calendar.postedHistory.slice(0, 100);
    saveSocialCalendar(calendar);

    res.json({
      success: true,
      message: `Post recorded for ${platform}. Note: Actual API posting requires platform tokens.`,
      postId: postRecord.id
    });

  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Get upcoming posts
app.get('/api/social/upcoming', (req, res) => {
  const calendar = loadSocialCalendar();
  const now = new Date();
  const upcoming = calendar.scheduledPosts
    .filter(p => new Date(p.scheduledFor) > now && p.status === 'scheduled')
    .slice(0, 10);

  res.json({ success: true, posts: upcoming });
});

// Start server
app.listen(PORT, () => {
  console.log(`
┌─────────────────────────────────────────┐
│   Product Trends Dashboard              │
│   http://localhost:${PORT}                 │
└─────────────────────────────────────────┘
  `);

  // Initialize the multi-task scheduler (migrates legacy autopilot on first boot)
  seedSchedulerFromAutopilot();
  startAllJobs();
});
