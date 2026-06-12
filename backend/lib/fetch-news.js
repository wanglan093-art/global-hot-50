'use strict';

const https = require('https');
const http = require('http');
const cache = require('./cache');
const { SOURCES, isChinese, getSrc } = require('./sources');
const { translateBatch } = require('./translate');
const RssParser = require('rss-parser');

const NEWSAPI_KEY = process.env.NEWSAPI_KEY || '2f0b960a820e4900b2583fc103d808c5';
const NEWSAPI_BASE = 'https://newsapi.org/v2';
const TODAY = new Date().toISOString().split('T')[0];
const CACHE_TTL = 10 * 60 * 1000;
const TRANSLATE_CONCURRENCY = 4;
const TARGET_COUNT = 50;
const MAX_AGE_HOURS = 24;

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const get = url.startsWith('https') ? https.get : http.get;
    get(url, { timeout: 15000 }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        httpGet(res.headers.location).then(resolve).catch(reject);
        return;
      }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    }).on('error', reject).on('timeout', function() { this.destroy(); reject(new Error('timeout')); });
  });
}

function safeParseJSON(str, fallback) {
  try { return JSON.parse(str); } catch (e) { return fallback || null; }
}

function calcHotScore(base, minsAgo, trust) {
  const authority = { A: 1.0, B: 0.85, C: 0.6 };
  return Math.round((base || 50) * Math.pow(0.99, (minsAgo || 0) / 30) * (authority[trust] || 0.85));
}

const NEWSAPI_SOURCES = {
  finance: 'bloomberg,reuters,financial-times,the-wall-street-journal,the-economist,cnbc,fortune,business-insider',
  politics: 'bbc-news,cnn,the-guardian-uk,associated-press,al-jazeera-english,politico,abc-news,the-washington-post,the-hindu,time,newsweek,independent',
  military: 'reuters,bbc-news,associated-press,the-guardian-uk,al-jazeera-english'
};

function normalizeSourceName(name) {
  const map = {
    'Bloomberg': 'Bloomberg','Reuters': 'Reuters','Financial Times': 'FT',
    'The Wall Street Journal': 'WSJ','The Economist': 'Economist','CNBC': 'CNBC',
    'Fortune': 'Fortune','Business Insider': 'Economist',
    'BBC News': 'BBC','CNN': 'CNN','The Guardian': 'Guardian',
    'Associated Press': 'AP','Al Jazeera English': 'AlJazeera','Politico': 'Politico',
    'ABC News': 'ABCNews','The Washington Post': 'WashingtonPost',
    'The Hindu': 'TheHindu','Time': 'Time','Newsweek': 'Newsweek','Independent': 'Independent'
  };
  return map[name] || name;
}

async function fetchNewsApi(category) {
  const sources = NEWSAPI_SOURCES[category];
  if (!sources) return [];
  const url = NEWSAPI_BASE + '/everything?sources=' + sources + '&pageSize=50&sortBy=publishedAt&from=' + TODAY + '&apiKey=' + NEWSAPI_KEY;
  try {
    const raw = await httpGet(url);
    const json = safeParseJSON(raw);
    if (!json || json.status !== 'ok' || !json.articles) return [];
    return json.articles.map((a, i) => ({
      title: a.title || 'Untitled',
      source: normalizeSourceName(a.source && a.source.name || ''),
      trust: 'A',
      heat: Math.max(30, 100 - i * 2),
      minsAgo: Math.round((Date.now() - new Date(a.publishedAt).getTime()) / 60000),
      url: a.url || '',
      cluster: detectCluster(a.title),
      debunk: false,
      sourceFull: getSrc(normalizeSourceName(a.source && a.source.name || '')).full,
      sourceColor: getSrc(normalizeSourceName(a.source && a.source.name || '')).color,
      sourceLabel: getSrc(normalizeSourceName(a.source && a.source.name || '')).label,
      hotScore: 0
    })).filter(function(a) { return a.minsAgo <= MAX_AGE_HOURS * 60; });
  } catch (e) {
    console.error('[fetchNewsApi] Error:', e.message);
    return [];
  }
}

const CCTV_ENDPOINTS = [
  { url: 'https://news.cctv.com/2019/07/gaiban/cmsdatainterface/page/economy_1.jsonp', type: 'economy' },
  { url: 'https://news.cctv.com/2019/07/gaiban/cmsdatainterface/page/china_1.jsonp', type: 'china' },
  { url: 'https://news.cctv.com/2019/07/gaiban/cmsdatainterface/page/world_1.jsonp', type: 'world' }
];

function extractJSONP(text) {
  var m = text.match(/^[^(]*\(([\s\S]*)\)[^)]*$/);
  if (m) return safeParseJSON(m[1]);
  return safeParseJSON(text);
}

function extractCCTVSource(title) {
  if (title.indexOf('新华社') >= 0) return 'Xinhua';
  if (title.indexOf('央视') >= 0) return 'CCTV';
  if (title.indexOf('人民日报') >= 0) return 'PeopleDaily';
  if (title.indexOf('环球') >= 0) return 'GTimes';
  if (title.indexOf('国防部') >= 0) return 'MOD';
  if (title.indexOf('解放军') >= 0) return 'PLADaily';
  if (title.indexOf('商务部') >= 0) return 'MOFCOM';
  if (title.indexOf('央行') >= 0 || title.indexOf('人民银行') >= 0) return 'PBOC';
  if (title.indexOf('证监会') >= 0 || title.indexOf('证券') >= 0) return 'CNStock';
  if (title.indexOf('财新') >= 0) return 'Caixin';
  return 'CCTV';
}

async function fetchCCTV() {
  var all = [];
  for (var i = 0; i < CCTV_ENDPOINTS.length; i++) {
    var ep = CCTV_ENDPOINTS[i];
    try {
      var raw = await httpGet(ep.url);
      var json = extractJSONP(raw);
      if (!json || !json.data || !json.data.list) continue;
      for (var j = 0; j < json.data.list.length; j++) {
        var item = json.data.list[j];
        var title = (item.title || '').replace(/<[^>]+>/g, '').trim();
        if (!title || title.length < 5) continue;
        var src = extractCCTVSource(title);
        var minsAgo = Math.floor(Math.random() * 120) + 5;
        if (item.focus_date) {
          var d = new Date(item.focus_date);
          if (!isNaN(d.getTime())) minsAgo = Math.round((Date.now() - d.getTime()) / 60000);
        }
        all.push({
          title: title,
          source: src,
          trust: 'A',
          heat: Math.max(40, 98 - Math.floor(Math.random() * 30)),
          minsAgo: Math.max(1, minsAgo),
          url: item.url || 'https://news.cctv.com',
          cluster: detectCluster(title),
          debunk: false,
          sourceFull: getSrc(src).full,
          sourceColor: getSrc(src).color,
          sourceLabel: getSrc(src).label,
          hotScore: 0
        });
      }
    } catch (e) {
      console.error('[fetchCCTV] Error:', e.message);
    }
  }
  return all.filter(function(a) { return a.minsAgo <= MAX_AGE_HOURS * 60; });
}

const rssParser = new RssParser({ timeout: 15000, headers: { 'User-Agent': 'GlobalHot50/3.0' } });

const RSS_FEEDS = [
  { url: 'https://en.yna.co.kr/RSS/news.xml', src: 'Yonhap', cat: 'politics' },
  { url: 'https://www3.nhk.or.jp/nhkworld/en/news/rss.xml', src: 'NHK', cat: 'politics' },
  { url: 'https://www.scmp.com/rss/91/news', src: 'SCMP', cat: 'politics' },
  { url: 'https://timesofindia.indiatimes.com/rssfeedstopstories.cms', src: 'TimesOfIndia', cat: 'politics' },
  { url: 'https://www.defensenews.com/arc/outboundfeeds/rss/?outputType=xml', src: 'DefenseNews', cat: 'military' },
  { url: 'https://www.twz.com/rss', src: 'WarZone', cat: 'military' },
  { url: 'https://www.al-monitor.com/feed', src: 'AlMonitor', cat: 'politics' },
  { url: 'https://www.straitstimes.com/news/asia/rss.xml', src: 'StraitsTimes', cat: 'politics' }
];

async function fetchRSSFeeds() {
  var all = [];
  for (var i = 0; i < RSS_FEEDS.length; i++) {
    var feed = RSS_FEEDS[i];
    try {
      var parsed = await rssParser.parseURL(feed.url);
      if (!parsed.items) continue;
      for (var j = 0; j < parsed.items.length; j++) {
        var item = parsed.items[j];
        var title = (item.title || '').replace(/<[^>]+>/g, '').trim();
        if (!title || title.length < 8) continue;
        var pubDate = item.pubDate ? new Date(item.pubDate) : (item.isoDate ? new Date(item.isoDate) : new Date());
        var minsAgo = Math.round((Date.now() - pubDate.getTime()) / 60000);
        if (minsAgo > MAX_AGE_HOURS * 60) continue;
        all.push({
          title: title,
          source: feed.src,
          trust: 'A',
          heat: Math.max(30, 95 - Math.floor(Math.random() * 40)),
          minsAgo: Math.max(1, minsAgo),
          url: item.link || '',
          cluster: detectCluster(title),
          debunk: false,
          sourceFull: getSrc(feed.src).full,
          sourceColor: getSrc(feed.src).color,
          sourceLabel: getSrc(feed.src).label,
          category: feed.cat,
          hotScore: 0
        });
      }
    } catch (e) {
      // skip failed RSS feeds silently
    }
  }
  return all;
}

function detectCluster(title) {
  var lower = title.toLowerCase();
  if (/tariff|tariffs|trade war|\u5173\u7a0e|\u8d38\u6613\u6218/.test(lower)) return '\u8d38\u6613\u6469\u64e6';
  if (/ai|artificial intelligence|\u4eba\u5de5\u667a\u80fd|openai|gpt|llm/.test(lower)) return 'AI\u4ea7\u4e1a';
  if (/fed|federal reserve|rate cut|rate hike|\u5229\u7387|\u964d\u606f|\u52a0\u606f/.test(lower)) return '\u8d27\u5e01\u653f\u7b56';
  if (/ukraine|russia|zelensky|putin|\u4e4c\u514b\u5170|\u4fc4\u7f57\u65af/.test(lower)) return '\u4fc4\u4e4c\u5c40\u52bf';
  if (/gaza|israel|hamas|palestin|\u52a0\u6c99|\u4ee5\u8272\u5217|\u54c8\u9a6c\u65af/.test(lower)) return '\u4e2d\u4e1c\u51b2\u7a81';
  if (/taiwan|strait|\u53f0\u6e7e|\u53f0\u6d77/.test(lower)) return '\u53f0\u6d77\u5c40\u52bf';
  if (/north korea|pyongyang|missile|\u671d\u9c9c|\u5bfc\u5f39/.test(lower)) return '\u671d\u9c9c\u534a\u5c9b';
  if (/oil|crude|opec|\u77f3\u6cb9|\u539f\u6cb9/.test(lower)) return '\u80fd\u6e90\u5e02\u573a';
  if (/chip|semiconductor|nvidia|tsmc|\u82af\u7247|\u534a\u5bfc\u4f53/.test(lower)) return '\u534a\u5bfc\u4f53';
  if (/crypto|bitcoin|ethereum|\u52a0\u5bc6\u8d27\u5e01|\u6bd4\u7279\u5e01/.test(lower)) return '\u52a0\u5bc6\u8d27\u5e01';
  if (/election|vote|poll|\u9009\u4e3e|\u5927\u9009/.test(lower)) return '\u9009\u4e3e\u52a8\u6001';
  return null;
}

async function translateArticles(articles) {
  var needsTranslation = articles.filter(function(a) { return !isChinese(a.source); });
  if (needsTranslation.length === 0) return;
  var titles = needsTranslation.map(function(a) { return a.title; });
  try {
    var translated = await translateBatch(titles, TRANSLATE_CONCURRENCY);
    needsTranslation.forEach(function(a, i) {
      if (translated[i] && translated[i] !== a.title) {
        a.title = translated[i];
      }
    });
  } catch (e) {
    console.error('[translateArticles] Batch failed:', e.message);
  }
}

const CATEGORY_KEYWORDS = {
  finance: [
    '\u592e\u884c','\u5229\u7387','\u80a1\u5e02','A\u80a1','\u57fa\u91d1','\u503a\u5238','\u6c47\u7387','\u4eba\u6c11\u5e01','\u7f8e\u5143','\u6b27\u5143','\u65e5\u5143',
    '\u9ec4\u91d1','\u77f3\u6cb9','\u80fd\u6e90','\u6bd4\u7279\u5e01','\u52a0\u5bc6\u8d27\u5e01','IPO','\u4e0a\u5e02','\u8d22\u62a5','\u8425\u6536','\u5229\u6da6',
    '\u6295\u8d44','\u878d\u8d44','\u503a\u52a1','\u8d64\u5b57','\u901a\u80c0','CPI','PPI','GDP','PMI','\u8d38\u6613','\u5173\u7a0e',
    '\u5236\u9020\u4e1a','\u623f\u5730\u4ea7','\u623f\u4ef7','\u6d88\u8d39','\u96f6\u552e','\u4f9b\u5e94\u94fe','\u534a\u5bfc\u4f53','\u82af\u7247','\u79d1\u6280\u80a1',
    'stock','market','bond','yield','rate','cut','hike','central bank','fed','ECB','BOJ',
    'inflation','growth','recession','merger','acquisition','earnings','revenue',
    'commodity','crude','OPEC','gold','silver','crypto','bitcoin'
  ],
  military: [
    '\u519b\u4e8b','\u56fd\u9632','\u519b\u961f','\u6d77\u519b','\u7a7a\u519b','\u9646\u519b','\u706b\u7bad\u519b','\u822a\u6bcd','\u6218\u6597\u673a','\u9a71\u9010\u8230',
    '\u6838\u6f5c\u8247','\u6d32\u9645\u5bfc\u5f39','\u519b\u6f14','\u6f14\u4e60','\u6218\u4e89','\u51b2\u7a81','\u7279\u79cd\u90e8\u961f','\u65e0\u4eba\u673a',
    '\u6b66\u5668','\u5f39\u836f','\u57fa\u5730','\u90e8\u7f72','\u60c5\u62a5','\u4fa6\u5bdf','\u96f7\u8fbe','\u536b\u661f','\u592a\u7a7a\u519b',
    'cyber','war','military','navy','air force','army','missile','drone',
    'nuclear','weapon','fighter','bomber','carrier','strike','defense',
    'NATO','AUKUS','tank','artillery','battle','combat',
    '\u671d\u9c9c','\u53f0\u6e7e\u6d77\u5ce1','\u53f0\u6d77','\u4e1c\u6d77','\u5357\u6d77','\u9493\u9c7c\u5c9b','\u4e2d\u5370\u8fb9\u5883'
  ]
};

function categorizeArticle(article) {
  var text = article.title.toLowerCase();
  var cats = Object.keys(CATEGORY_KEYWORDS);
  for (var c = 0; c < cats.length; c++) {
    var cat = cats[c];
    var keywords = CATEGORY_KEYWORDS[cat];
    for (var k = 0; k < keywords.length; k++) {
      if (text.indexOf(keywords[k].toLowerCase()) >= 0) return cat;
    }
  }
  return 'politics';
}

function filterByCategory(articles, category) {
  return articles.filter(function(a) { return categorizeArticle(a) === category; });
}

async function fetchTrending(domain, category) {
  var cacheKey = 'trending_' + domain + '_' + category;
  var cached = cache.get(cacheKey);
  if (cached) return cached;

  console.log('[fetchTrending] domain=' + domain + ' category=' + category);

  var articles = [];

  if (domain === 'domestic') {
    var cctvArticles = await fetchCCTV();
    articles = filterByCategory(cctvArticles, category);
  } else {
    var results = await Promise.all([
      fetchNewsApi(category),
      fetchRSSFeeds()
    ]);
    var newsApiArticles = results[0];
    var rssArticles = results[1];
    var rssFiltered = filterByCategory(rssArticles, category);
    articles = newsApiArticles.concat(rssFiltered);
    await translateArticles(articles);
  }

  var seen = new Set();
  articles = articles.filter(function(a) {
    var key = a.title.slice(0, 30).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  articles.forEach(function(a) { a.hotScore = calcHotScore(a.heat, a.minsAgo, a.trust); });
  articles.sort(function(a, b) { return b.hotScore - a.hotScore; });
  articles = articles.slice(0, TARGET_COUNT);
  articles.forEach(function(a, i) { a.rank = i + 1; });

  var result = {
    domain: domain,
    category: category,
    total: articles.length,
    items: articles,
    updatedAt: Date.now(),
    sourceCount: (new Set(articles.map(function(a) { return a.source; }))).size
  };

  cache.set(cacheKey, result, CACHE_TTL);
  console.log('[fetchTrending] Got ' + result.total + ' items from ' + result.sourceCount + ' sources');
  return result;
}

module.exports = { fetchTrending: fetchTrending, SOURCES: require('./sources').SOURCES };
