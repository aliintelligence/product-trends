const express = require('express');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const OpenAI = require('openai');

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

// Trending product categories to search
const TRENDING_CATEGORIES = [
  'viral gadgets', 'beauty products', 'home decor', 'fitness gear',
  'tech accessories', 'kitchen tools', 'pet products', 'fashion accessories',
  'phone accessories', 'car accessories', 'gaming gear', 'smart home'
];

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

// Get sourcing recommendations
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

// Analyze products with AI
async function analyzeProductsWithAI(products) {
  const ai = getOpenAI();
  if (!ai) {
    // Return basic analysis without AI
    return products.map(p => ({
      ...p,
      aiScore: Math.floor(Math.random() * 30) + 70, // Random score 70-100
      trend: Math.random() > 0.5 ? 'Rising' : 'Stable',
      competition: Math.random() > 0.5 ? 'Medium' : 'High',
      recommendation: 'Analyze manually for best results'
    }));
  }

  try {
    const productSummaries = products.slice(0, 10).map((p, i) =>
      `${i+1}. ${p.title} - $${p.price} - ${p.views} views, ${p.likes} likes, ${p.engagement}% engagement`
    ).join('\n');

    const prompt = `Analyze these trending TikTok products for dropshipping potential. For each product, provide:
1. AI Score (0-100) based on viral potential, engagement, and market demand
2. Trend direction (Rising/Stable/Declining)
3. Competition level (Low/Medium/High)
4. Brief recommendation (one sentence)

Products:
${productSummaries}

Respond in JSON format: [{"productIndex": 1, "aiScore": 85, "trend": "Rising", "competition": "Medium", "recommendation": "..."}]`;

    const response = await ai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0.7
    });

    const analysis = JSON.parse(response.choices[0].message.content);
    const analysisArray = analysis.products || Object.values(analysis);

    return products.map((p, i) => {
      const aiData = analysisArray.find(a => a.productIndex === i + 1) || {};
      return {
        ...p,
        aiScore: aiData.aiScore || 75,
        trend: aiData.trend || 'Stable',
        competition: aiData.competition || 'Medium',
        recommendation: aiData.recommendation || 'Good potential for dropshipping'
      };
    });
  } catch (error) {
    console.error('AI analysis error:', error.message);
    // Return products with basic scores
    return products.map(p => ({
      ...p,
      aiScore: Math.floor(Math.random() * 30) + 70,
      trend: 'Unknown',
      competition: 'Medium',
      recommendation: 'Manual analysis recommended'
    }));
  }
}

// ================== API ROUTES ==================

// Get/Save config
app.get('/api/config', (req, res) => {
  const config = loadConfig();
  res.json({
    hasKey: !!config.apiKey,
    apiKey: config.apiKey || '',
    hasOpenAIKey: !!config.openaiKey,
    openaiKey: config.openaiKey || ''
  });
});

app.post('/api/config', (req, res) => {
  const config = loadConfig();
  if (req.body.apiKey !== undefined) config.apiKey = req.body.apiKey;
  if (req.body.openaiKey !== undefined) {
    config.openaiKey = req.body.openaiKey;
    openai = null; // Reset OpenAI instance
  }
  saveConfig(config);
  console.log('✅ Config saved');
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

// ================== AI PRODUCT RECOMMENDATIONS ==================

// Get automated product recommendations
app.get('/api/recommendations', async (req, res) => {
  try {
    console.log('🤖 Generating product recommendations...');

    // Pick 3 random trending categories
    const selectedCategories = TRENDING_CATEGORIES
      .sort(() => Math.random() - 0.5)
      .slice(0, 3);

    console.log('📦 Searching categories:', selectedCategories.join(', '));

    // Fetch products from TikTok Shop for each category
    const allProducts = [];

    for (const category of selectedCategories) {
      try {
        const data = await scrapecreators('/v1/tiktok/shop/search', { query: category });
        const items = data.products || data.data || [];

        // Debug: Log first item structure
        if (items.length > 0) {
          console.log(`📦 Sample item keys for ${category}:`, Object.keys(items[0]));
          console.log(`💰 Price info:`, items[0].product_price_info);
          console.log(`📊 Sold info:`, items[0].sold_info);
        }

        // Process items
        const processed = items.slice(0, 8).map(item => {
          // Extract price from nested structure
          let price = 0;
          if (item.product_price_info) {
            // Price is in sale_price_decimal or sale_price_format
            const priceStr = item.product_price_info.sale_price_decimal ||
                           item.product_price_info.sale_price_format ||
                           item.product_price_info.min_price ||
                           item.product_price_info.price || '0';

            // Remove formatting (dots/commas) and convert to number
            const priceNum = parseFloat(priceStr.replace(/[.,]/g, ''));

            // Convert from VND to USD (approximate: 1 USD = 25,000 VND)
            if (item.product_price_info.currency_name === 'VND') {
              price = priceNum / 25000;
            } else {
              price = priceNum;
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

          return {
            title: item.product_name || item.title || 'No title',
            image: item.product_img_url || item.image || item.cover || '',
            views: item.statistics?.play_count || item.rate_info?.view_count || 0,
            likes: item.statistics?.digg_count || item.rate_info?.like_count || 0,
            sold: sold,
            price: price,
            engagement: item.statistics?.play_count > 0
              ? ((item.statistics?.digg_count || 0) / item.statistics?.play_count * 100).toFixed(2)
              : 0,
            category: category,
            rawData: item
          };
        });

        allProducts.push(...processed);
      } catch (e) {
        console.error(`Failed to fetch ${category}:`, e.message);
      }
    }

    if (allProducts.length === 0) {
      return res.json({
        success: false,
        error: 'No products found. Try again or check your API key.'
      });
    }

    console.log(`✅ Found ${allProducts.length} products`);

    // Debug: Log price data
    console.log('📊 Sample product prices:', allProducts.slice(0, 3).map(p => ({
      title: p.title.substring(0, 30),
      price: p.price,
      sold: p.sold
    })));

    // Filter products with price and sales data
    const validProducts = allProducts
      .filter(p => p.price > 0 && p.price < 200) // Reasonable price range
      .sort((a, b) => (b.views + b.likes + b.sold) - (a.views + a.likes + a.sold))
      .slice(0, 20);

    console.log(`✅ ${validProducts.length} products after filtering (price > 0 && price < 200)`);

    // Add margins and sourcing to each product
    const productsWithAnalysis = validProducts.map(p => ({
      ...p,
      margins: calculateMargins(p.price),
      sourcing: getSourcingRecommendations(p.title)
    }));

    // Analyze with AI
    const analyzedProducts = await analyzeProductsWithAI(productsWithAnalysis);

    // Sort by AI score
    const sortedProducts = analyzedProducts.sort((a, b) => b.aiScore - a.aiScore);

    // Get trending niches
    const niches = {};
    sortedProducts.forEach(p => {
      if (!niches[p.category]) {
        niches[p.category] = {
          category: p.category,
          count: 0,
          avgScore: 0,
          totalSales: 0
        };
      }
      niches[p.category].count++;
      niches[p.category].avgScore += p.aiScore;
      niches[p.category].totalSales += p.sold || 0;
    });

    const trendingNiches = Object.values(niches).map(n => ({
      ...n,
      avgScore: Math.round(n.avgScore / n.count)
    })).sort((a, b) => b.avgScore - a.avgScore);

    res.json({
      success: true,
      products: sortedProducts,
      niches: trendingNiches,
      totalProducts: sortedProducts.length,
      timestamp: new Date().toISOString()
    });

  } catch (e) {
    console.error('❌ Recommendation error:', e.message);
    res.json({ success: false, error: e.message });
  }
});

// Analyze specific product
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

// Start server
app.listen(PORT, () => {
  console.log(`
┌─────────────────────────────────────────┐
│   Product Trends Dashboard              │
│   http://localhost:${PORT}                 │
└─────────────────────────────────────────┘
  `);
});
