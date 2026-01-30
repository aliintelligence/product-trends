const express = require('express');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const OpenAI = require('openai');
const { GoogleGenerativeAI } = require('@google/generative-ai');

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

// Trending product categories to search (US/UK focused)
const TRENDING_CATEGORIES = [
  'viral gadgets', 'beauty products', 'home decor', 'fitness equipment',
  'tech accessories', 'kitchen gadgets', 'pet supplies', 'fashion accessories',
  'phone cases', 'car accessories', 'gaming accessories', 'smart home devices',
  'makeup', 'skincare', 'jewelry', 'workout gear', 'led lights', 'desk accessories'
];

// Check if text is primarily English
function isEnglish(text) {
  if (!text) return false;
  // Count English characters vs total characters
  const englishChars = text.match(/[a-zA-Z]/g) || [];
  const totalChars = text.replace(/\s/g, '').length;
  // Require at least 50% English characters
  return totalChars > 0 && (englishChars.length / totalChars) >= 0.5;
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
    openaiKey: config.openaiKey || '',
    hasGeminiKey: !!config.geminiKey,
    geminiKey: config.geminiKey || ''
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
        const data = await scrapecreators('/v1/tiktok/shop/search', {
          query: category,
          region: 'US' // Target US market
        });
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

            // Handle different currency formats
            if (item.product_price_info.currency_name === 'VND') {
              // Vietnamese Dong - remove dots and convert to USD
              const priceNum = parseFloat(priceStr.replace(/\./g, ''));
              price = priceNum / 25000;
            } else if (item.product_price_info.currency_name === 'USD' || item.product_price_info.currency_symbol === '$') {
              // USD - remove commas if any
              price = parseFloat(priceStr.replace(/,/g, ''));
            } else {
              // Other currencies - try to parse as-is
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

        // Filter for English products only
        const englishProducts = processed.filter(p => isEnglish(p.title));
        console.log(`🌍 ${englishProducts.length}/${processed.length} English products for ${category}`);

        allProducts.push(...englishProducts);
      } catch (e) {
        console.error(`Failed to fetch ${category}:`, e.message);
      }
    }

    console.log(`✅ Total products (all categories): ${allProducts.length}`);

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

// Start server
app.listen(PORT, () => {
  console.log(`
┌─────────────────────────────────────────┐
│   Product Trends Dashboard              │
│   http://localhost:${PORT}                 │
└─────────────────────────────────────────┘
  `);
});
