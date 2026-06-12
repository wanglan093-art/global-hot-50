'use strict';

const express = require('express');
const cors = require('cors');
const { fetchTrending } = require('./lib/fetch-news');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Root
app.get('/', function(_, res) {
  res.json({
    name: 'Global Hot 50 API',
    version: '4.0.0',
    endpoint: '/api/trending/{domestic|international}/{finance|politics|military}',
    health: '/api/health',
    sources: {
      domestic_finance: '7 HTML scrapers: Caixin, STCN, NBD, 21Jingji, Yicai, XinhuaFortune, CEWeekly',
      domestic_politics: 'CCTV JSONP + 5 RSS (PeopleDaily, ChinaDaily, ChinaNews) + Huanqiu HTML + FMPRC HTML',
      domestic_military: '11 HTML scrapers: MOD, 81cn, XinhuaMil, HuanqiuMil, Cankaoxiaoxi, ThePaper, Guancha, CNRMil, IfengMil, QQMIL, DSTI',
      international: 'NewsAPI (15+ outlets) + 14 RSS feeds (BBC, France24, DW, NYT, SCMP, Asahi, Yonhap, NHK, DefenseNews, WarZone, NavalNews, MarketWatch, NikkeiAsia, Al-Monitor)',
      total_sources: '50+ outlets across 6 categories',
      features: '50 items/category target, 48h freshness, 30-min cache, scored military categorization, auto-translate'
    },
    cache: '30 minutes',
    principles: 'v4 implements design principles 1-13'
  });
});

// News web app
app.get('/news', function(_, res) {
  res.sendFile(__dirname + '/hot-news.html');
});

// Trending
app.get('/api/trending/:domain/:category', async function(req, res) {
  const domain = req.params.domain;
  const cat = req.params.category;
  const validDomains = ['domestic', 'international'];
  const validCats = ['finance', 'politics', 'military'];
  if (!validDomains.includes(domain) || !validCats.includes(cat)) {
    return res.status(404).json({
      error: 'Invalid domain/category',
      valid: ['domestic-finance','domestic-politics','domestic-military','international-finance','international-politics','international-military']
    });
  }
  try {
    const result = await fetchTrending(domain, cat);
    res.json(result);
  } catch (err) {
    console.error('Trending error:', err.message);
    res.status(502).json({ error: 'Failed to fetch news', domain, category: cat, message: err.message });
  }
});

// Health
app.get('/api/health', function(_, res) {
  res.json({ status: 'ok', version: '4.0.0', uptime: process.uptime() });
});

// 404
app.use(function(_, res) {
  res.status(404).json({ error: 'Not found', hint: 'Try / for API docs' });
});

if (require.main === module) {
  app.listen(PORT, '0.0.0.0', function() {
    console.log('Global Hot 50 API v4.0 on port ' + PORT);
    console.log('Domestic: 20+ HTML scrapers + CCTV JSONP + RSS');
    console.log('International: NewsAPI + 14 RSS feeds');
  });
}

module.exports = app;
