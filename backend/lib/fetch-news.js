'use strict';

const https = require('https');
const http = require('http');
const cache = require('./cache');
const { SOURCES, isChinese, getSrc } = require('./sources');
const { translateBatch } = require('./translate');
const RssParser = require('rss-parser');
const iconv = require('iconv-lite');

// ─── Config ─────────────────────────────────────────────────

const NEWSAPI_KEY = process.env.NEWSAPI_KEY || '480168630be8476bb441a241ae4e3780';
const NEWSAPI_BASE = 'https://newsapi.org/v2';
const TODAY = new Date().toISOString().split('T')[0];
const CACHE_TTL = 30 * 60 * 1000;  // 30 minutes
const TRANSLATE_CONCURRENCY = 4;
const TARGET_COUNT = 50;
const MAX_AGE_HOURS = 48;

// ─── HTTP Helpers ───────────────────────────────────────────

function httpGet(url, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    var mod = url.startsWith('https') ? https : http;
    var reqOpts = { timeout: opts.timeout || 12000 };
    if (opts.headers) reqOpts.headers = opts.headers;
    var req = mod.get(url, reqOpts, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        var loc = res.headers.location;
        if (loc && !loc.startsWith('http')) {
          var u = new URL(url);
          loc = u.protocol + '//' + u.host + (loc.startsWith('/') ? '' : '/') + loc;
        }
        httpGet(loc, opts).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode >= 400) { reject(new Error('HTTP ' + res.statusCode)); return; }
      var chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        var buf = Buffer.concat(chunks);
        if (opts.encoding === 'gb2312' || opts.encoding === 'gbk') {
          resolve(iconv.decode(buf, 'gb2312'));
        } else {
          resolve(buf.toString('utf-8'));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', function() { this.destroy(); reject(new Error('timeout')); });
  });
}

function safeParseJSON(str, fallback) {
  try { return JSON.parse(str); } catch (e) { return fallback || null; }
}

function now() { return Date.now(); }

// ─── Heat Score Algorithm ───────────────────────────────────

function calcHotScore(base, minsAgo, trust) {
  var hoursSince = minsAgo / 60;
  var timeFresh = Math.max(0, (MAX_AGE_HOURS - hoursSince) / MAX_AGE_HOURS);
  var propagation = Math.min(1.0, (base || 50) / 120);
  var authorityMap = { A: 1.0, B: 0.85, C: 0.6 };
  var authority = authorityMap[trust] || 0.8;
  var srcWeight = 0.9;
  var raw = timeFresh * 30 + propagation * 40 + authority * 20 + srcWeight * 10;
  return Math.round(Math.min(100, Math.max(5, raw)));
}

function calcHotBreakdown(base, minsAgo, trust) {
  var hoursSince = minsAgo / 60;
  var timeFresh = Math.max(0, (MAX_AGE_HOURS - hoursSince) / MAX_AGE_HOURS);
  var propagation = Math.min(1.0, (base || 50) / 120);
  var authorityMap = { A: 1.0, B: 0.85, C: 0.6 };
  var authority = authorityMap[trust] || 0.8;
  return {
    timeFresh: Math.round(timeFresh * 100),
    propagation: Math.round(propagation * 100),
    authority: Math.round(authority * 100),
    srcWeight: 90
  };
}

// ─── Source normalization ───────────────────────────────────

const SOURCE_NORMALIZE = {
  'Bloomberg': 'Bloomberg','Reuters': 'Reuters','Financial Times': 'FT',
  'The Wall Street Journal': 'WSJ','The Economist': 'Economist','CNBC': 'CNBC',
  'Fortune': 'Fortune','Business Insider': 'Economist',
  'BBC News': 'BBC','CNN': 'CNN','The Guardian': 'Guardian',
  'Associated Press': 'AP','Al Jazeera English': 'AlJazeera','Politico': 'Politico',
  'ABC News': 'ABCNews','The Washington Post': 'WashingtonPost',
  'The Hindu': 'TheHindu','Time': 'Time','Newsweek': 'Newsweek','Independent': 'Independent'
};

function normalizeSourceName(name) {
  return SOURCE_NORMALIZE[name] || name;
}

// ─── Article Builder ────────────────────────────────────────

function makeArticle(title, source, trust, heat, minsAgo, url) {
  var src = getSrc(source);
  return {
    title: title.replace(/<[^>]+>/g, '').replace(/&[a-z]+;/g, '').trim(),
    source: source,
    trust: trust,
    heat: heat,
    minsAgo: Math.max(1, minsAgo),
    url: url || '',
    cluster: detectCluster(title),
    debunk: false,
    sourceFull: src.full,
    sourceColor: src.color,
    sourceLabel: src.label,
    hotScore: 0
  };
}

// ─── Cluster Detection ──────────────────────────────────────

function detectCluster(title) {
  var t = title.toLowerCase();
  if (/tariff|tariffs|trade war|\u5173\u7a0e|\u8d38\u6613\u6218/.test(t)) return '\u8d38\u6613\u6469\u64e6';
  if (/ai|artificial intelligence|\u4eba\u5de5\u667a\u80fd|openai|gpt/.test(t)) return 'AI\u4ea7\u4e1a';
  if (/fed|federal reserve|rate cut|rate hike|\u5229\u7387|\u964d\u606f|\u52a0\u606f/.test(t)) return '\u8d27\u5e01\u653f\u7b56';
  if (/ukraine|russia|zelensky|putin|\u4e4c\u514b\u5170|\u4fc4\u7f57\u65af/.test(t)) return '\u4fc4\u4e4c\u5c40\u52bf';
  if (/gaza|israel|hamas|palestin|\u52a0\u6c99|\u4ee5\u8272\u5217|\u54c8\u9a6c\u65af/.test(t)) return '\u4e2d\u4e1c\u51b2\u7a81';
  if (/taiwan|strait|\u53f0\u6e7e|\u53f0\u6d77/.test(t)) return '\u53f0\u6d77\u5c40\u52bf';
  if (/north korea|pyongyang|missile|\u671d\u9c9c|\u5bfc\u5f39/.test(t)) return '\u671d\u9c9c\u534a\u5c9b';
  if (/oil|crude|opec|\u77f3\u6cb9|\u539f\u6cb9/.test(t)) return '\u80fd\u6e90\u5e02\u573a';
  if (/chip|semiconductor|nvidia|tsmc|\u82af\u7247|\u534a\u5bfc\u4f53/.test(t)) return '\u534a\u5bfc\u4f53';
  if (/crypto|bitcoin|ethereum|\u52a0\u5bc6\u8d27\u5e01|\u6bd4\u7279\u5e01/.test(t)) return '\u52a0\u5bc6\u8d27\u5e01';
  if (/election|vote|poll|\u9009\u4e3e|\u5927\u9009/.test(t)) return '\u9009\u4e3e\u52a8\u6001';
  return null;
}

// ─── Generic HTML Scraper ───────────────────────────────────

function extractTitlesFromHTML(html, minLen) {
  minLen = minLen || 8;
  var titles = [];

  // Strategy 1: title="..." attributes in <a> tags
  var m;
  var re1 = /<a[^>]*title="([^"]{8,200})"[^>]*>/gi;
  while ((m = re1.exec(html)) !== null) {
    var t = m[1].replace(/<[^>]+>/g, '').replace(/&[a-z]+;/g, '').trim();
    if (t.length >= minLen && !/^(javascript|http|www\.|下一页|首页|登录|注册|更多|查看详情)/i.test(t)) {
      titles.push(t);
    }
  }

  // Strategy 2: <a href="...">text</a> where text is Chinese
  if (titles.length < 5) {
    var re2 = /<a[^>]*href="([^"]+)"[^>]*>\s*([^<]{10,200})\s*<\/a>/gi;
    while ((m = re2.exec(html)) !== null) {
      var t2 = m[2].replace(/<[^>]+>/g, '').replace(/&[a-z]+;/g, '').trim();
      if (t2.length >= minLen && /[\u4e00-\u9fff]/.test(t2) && !/^(javascript|http|\s*$)/i.test(t2)) {
        titles.push(t2);
      }
    }
  }

  // Strategy 3: Look for news list patterns in JSON/script tags
  if (titles.length < 5) {
    var re3 = /"title"\s*:\s*"([^"]{10,200})"/gi;
    while ((m = re3.exec(html)) !== null) {
      var t3 = m[1].replace(/\\"/g, '"').trim();
      if (t3.length >= minLen && /[\u4e00-\u9fff]/.test(t3)) {
        titles.push(t3);
      }
    }
  }

  return titles;
}

function extractLinksFromHTML(html) {
  var links = [];
  var m;
  var re = /<a[^>]*href="([^"]+)"[^>]*title="([^"]+)"[^>]*>/gi;
  while ((m = re.exec(html)) !== null) {
    links.push({ url: m[1], title: m[2].replace(/<[^>]+>/g, '').replace(/&[a-z]+;/g, '').trim() });
  }
  return links;
}

function htmlScrape(name, url, source, trust, maxArticles, baseUrl, opts) {
  opts = opts || {};
  maxArticles = maxArticles || 15;
  return httpGet(url, opts).then(function(html) {
    var titles = extractTitlesFromHTML(html, 8);
    var links = extractLinksFromHTML(html);
    var results = [];
    var seen = new Set();
    for (var i = 0; i < Math.min(titles.length, maxArticles); i++) {
      var title = titles[i];
      var key = title.slice(0, 25);
      if (seen.has(key)) continue;
      seen.add(key);

      var bestUrl = '';
      for (var j = 0; j < links.length; j++) {
        if (links[j].title && title.indexOf(links[j].title.slice(0, 5)) >= 0) {
          bestUrl = links[j].url;
          if (!bestUrl.startsWith('http')) bestUrl = baseUrl + (bestUrl.startsWith('/') ? '' : '/') + bestUrl;
          break;
        }
      }
      if (!bestUrl) bestUrl = baseUrl;

      results.push(makeArticle(title, source, trust,
        Math.max(50, 95 - i * 3),
        5 + Math.floor(Math.random() * 600), bestUrl));
    }
    console.log('  [' + name + '] got ' + results.length + ' articles');
    return results;
  }).catch(function(e) {
    console.log('  [' + name + '] failed: ' + e.message);
    return [];
  });
}

// ═══════════════════════════════════════════════════════════════
// DOMESTIC FINANCE — 原则1: 10 sources
// ═══════════════════════════════════════════════════════════════

const DOMESTIC_FINANCE_SOURCES = [
  {
    name: 'Caixin', url: 'https://www.caixin.com/', src: 'Caixin', trust: 'A',
    baseUrl: 'https://www.caixin.com', max: 15
  },
  {
    name: 'STCN', url: 'https://www.stcn.com/', src: 'STCN', trust: 'A',
    baseUrl: 'https://www.stcn.com', max: 15
  },
  {
    name: 'NBD', url: 'https://www.nbd.com.cn/', src: 'NBD', trust: 'A',
    baseUrl: 'https://www.nbd.com.cn', max: 15
  },
  {
    name: '21Jingji', url: 'https://www.21jingji.com/', src: '21Jingji', trust: 'A',
    baseUrl: 'https://www.21jingji.com', max: 15
  },
  {
    name: 'Yicai', url: 'https://www.yicai.com/', src: 'Yicai', trust: 'A',
    baseUrl: 'https://www.yicai.com', max: 15
  },
  {
    name: 'XinhuaFortune', url: 'https://www.xinhuanet.com/fortune/', src: 'XinhuaFin', trust: 'A',
    baseUrl: 'https://www.xinhuanet.com', max: 15
  },
  {
    name: 'CEWeekly', url: 'https://www.ceweekly.cn/', src: 'CEWeekly', trust: 'B',
    baseUrl: 'https://www.ceweekly.cn', max: 10
  }
];

async function fetchDomesticFinanceHTML() {
  var all = [];
  for (var i = 0; i < DOMESTIC_FINANCE_SOURCES.length; i++) {
    var s = DOMESTIC_FINANCE_SOURCES[i];
    var articles = await htmlScrape(s.name, s.url, s.src, s.trust, s.max, s.baseUrl);
    all = all.concat(articles);
  }
  return all;
}

// ═══════════════════════════════════════════════════════════════
// DOMESTIC POLITICS — 原则4: 7 sources
// ═══════════════════════════════════════════════════════════════

// CCTV JSONP
const CCTV_ENDPOINTS = [
  { url: 'https://news.cctv.com/2019/07/gaiban/cmsdatainterface/page/economy_1.jsonp', type: 'economy' },
  { url: 'https://news.cctv.com/2019/07/gaiban/cmsdatainterface/page/china_1.jsonp', type: 'china' },
  { url: 'https://news.cctv.com/2019/07/gaiban/cmsdatainterface/page/world_1.jsonp', type: 'world' },
  { url: 'https://news.cctv.com/2019/07/gaiban/cmsdatainterface/page/news_1.jsonp', type: 'news' }
];

function extractJSONP(text) {
  var m = text.match(/^[^(]*\(([\s\S]*)\)[^)]*$/);
  if (m) return safeParseJSON(m[1]);
  return safeParseJSON(text);
}

function extractCCTVSource(title) {
  if (title.indexOf('\u65b0\u534e\u793e') >= 0) return 'Xinhua';
  if (title.indexOf('\u592e\u89c6') >= 0) return 'CCTV';
  if (title.indexOf('\u4eba\u6c11\u65e5\u62a5') >= 0) return 'PeopleDaily';
  if (title.indexOf('\u73af\u7403') >= 0) return 'GTimes';
  if (title.indexOf('\u56fd\u9632\u90e8') >= 0) return 'MOD';
  if (title.indexOf('\u89e3\u653e\u519b') >= 0) return 'PLADaily';
  if (title.indexOf('\u5546\u52a1\u90e8') >= 0) return 'MOFCOM';
  if (title.indexOf('\u592e\u884c') >= 0 || title.indexOf('\u4eba\u6c11\u94f6\u884c') >= 0) return 'PBOC';
  if (title.indexOf('\u8bc1\u76d1\u4f1a') >= 0 || title.indexOf('\u8bc1\u5238') >= 0) return 'CNStock';
  if (title.indexOf('\u8d22\u65b0') >= 0) return 'Caixin';
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
          if (!isNaN(d.getTime())) minsAgo = Math.round((now() - d.getTime()) / 60000);
        }
        all.push(makeArticle(title, src, 'A', Math.max(40, 98 - Math.floor(Math.random() * 30)),
          Math.max(1, minsAgo), item.url || 'https://news.cctv.com'));
      }
    } catch (e) { /* skip */ }
  }
  return all.filter(function(a) { return a.minsAgo <= MAX_AGE_HOURS * 60; });
}

// Chinese RSS Feeds (人民日报, 中国新闻网)
const DOMESTIC_RSS_FEEDS = [
  { url: 'http://www.people.com.cn/rss/politics.xml', src: 'PeopleDaily', cat: 'politics' },
  { url: 'http://www.people.com.cn/rss/finance.xml', src: 'PeopleDaily', cat: 'finance' },
  { url: 'https://www.chinanews.com/rss/scroll-news.xml', src: 'ChinaNews', cat: 'politics' },
  { url: 'http://www.chinadaily.com.cn/rss/world_rss.xml', src: 'ChinaDaily', cat: 'politics' },
  { url: 'http://www.chinadaily.com.cn/rss/china_rss.xml', src: 'ChinaDaily', cat: 'politics' }
];

const rssParser = new RssParser({
  timeout: 12000,
  headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept': 'application/xml,text/xml,*/*' }
});

async function fetchDomesticRSS() {
  var all = [];
  for (var i = 0; i < DOMESTIC_RSS_FEEDS.length; i++) {
    var feed = DOMESTIC_RSS_FEEDS[i];
    try {
      var parsed = await rssParser.parseURL(feed.url);
      if (!parsed || !parsed.items) continue;
      for (var j = 0; j < parsed.items.length; j++) {
        var item = parsed.items[j];
        var title = (item.title || '').replace(/<[^>]+>/g, '').trim();
        if (!title || title.length < 8) continue;
        var pubDate = item.pubDate ? new Date(item.pubDate) : (item.isoDate ? new Date(item.isoDate) : new Date());
        var minsAgo = Math.round((now() - pubDate.getTime()) / 60000);
        if (minsAgo > MAX_AGE_HOURS * 60) continue;
        all.push(makeArticle(title, feed.src, 'A',
          Math.max(30, 95 - Math.floor(Math.random() * 40)),
          Math.max(1, minsAgo), item.link || ''));
      }
    } catch (e) { /* skip */ }
  }
  return all;
}

// 环球时报 Politics
async function fetchHuanqiu() {
  return htmlScrape('Huanqiu', 'https://www.huanqiu.com/', 'GTimes', 'A', 15, 'https://www.huanqiu.com');
}

// 外交部发言人
async function fetchFMPRC() {
  return htmlScrape('FMPRC', 'https://www.fmprc.gov.cn/web/wjdt_674879/fyrbt_674889/', 'FMPRC', 'A', 15, 'https://www.fmprc.gov.cn');
}

// ═══════════════════════════════════════════════════════════════
// DOMESTIC MILITARY — 原则7: 16 sources
// ═══════════════════════════════════════════════════════════════

// 国防部
async function fetchMOD() {
  return htmlScrape('MOD', 'http://www.mod.gov.cn/', 'MOD', 'A', 15, 'http://www.mod.gov.cn');
}

// 中国军网 (81.cn)
async function fetch81cn() {
  return httpGet('http://www.81.cn/jwzx/node_8000970.htm', {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    timeout: 12000
  }).then(function(html) {
    var titles = [];
    var m;
    var re = /<a[^>]*href="([^"]+)"[^>]*target="_blank"[^>]*>([^<]{8,120})<\/a>/gi;
    while ((m = re.exec(html)) !== null) {
      var t = m[2].replace(/<[^>]+>/g, '').replace(/&[a-z]+;/g, '').trim();
      if (t.length >= 8) titles.push({ title: t, url: m[1] });
    }
    return titles.map(function(item, i) {
      var url = item.url;
      if (!url.startsWith('http')) url = 'http://www.81.cn' + (url.startsWith('/') ? '' : '/') + url;
      return makeArticle(item.title, 'PLAOnline', 'A',
        Math.max(60, 95 - i * 3), 10 + Math.floor(Math.random() * 600), url);
    });
  }).catch(function() { return []; });
}

// 新华网军事
async function fetchXinhuaMil() {
  return htmlScrape('XinhuaMil', 'http://www.xinhuanet.com/mil/', 'XinhuaMil', 'A', 15, 'http://www.xinhuanet.com');
}

// 环球时报军事
async function fetchHuanqiuMil() {
  return htmlScrape('HuanqiuMil', 'https://mil.huanqiu.com/', 'GTimesMil', 'A', 15, 'https://mil.huanqiu.com');
}

// 参考消息
async function fetchCankaoxiaoxi() {
  return htmlScrape('CKXX', 'https://www.cankaoxiaoxi.com/', 'Cankaoxiaoxi', 'A', 15, 'https://www.cankaoxiaoxi.com');
}

// 澎湃防务
async function fetchThePaperDefense() {
  return htmlScrape('ThePaperDef', 'https://www.thepaper.cn/list_25423', 'ThePaper', 'B', 15, 'https://www.thepaper.cn');
}

// 观察者网军事
async function fetchGuanchaMil() {
  return htmlScrape('GuanchaMil', 'https://www.guancha.cn/military-affairs', 'GuanchaMil', 'B', 15, 'https://www.guancha.cn');
}

// 腾讯军事
async function fetchQQMil() {
  return htmlScrape('QQMil', 'https://new.qq.com/ch/milite/', 'QQMil', 'B', 15, 'https://new.qq.com');
}

// 央广军事 — GB2312 encoded
async function fetchCNRMil() {
  try {
    var html = await httpGet('http://military.cnr.cn/', { encoding: 'gb2312', timeout: 12000 });
    var titles = extractTitlesFromHTML(html, 8);
    var links = extractLinksFromHTML(html);
    var results = [];
    var seen = new Set();
    for (var i = 0; i < Math.min(titles.length, 20); i++) {
      var title = titles[i];
      var key = title.slice(0, 25);
      if (seen.has(key)) continue;
      seen.add(key);
      var url = 'http://military.cnr.cn/';
      for (var j = 0; j < links.length; j++) {
        if (links[j].title && title.indexOf(links[j].title.slice(0, 5)) >= 0) {
          url = links[j].url;
          if (!url.startsWith('http')) url = 'http://military.cnr.cn' + (url.startsWith('/') ? '' : '/') + url;
          break;
        }
      }
      results.push(makeArticle(title, 'CNRMil', 'A', Math.max(70, 95 - i * 2), 5 + Math.floor(Math.random() * 600), url));
    }
    return results;
  } catch (e) { return []; }
}

// 凤凰网军事
async function fetchIfengMil() {
  return htmlScrape('IfengMil', 'https://mil.ifeng.com/', 'IfengMil', 'B', 20, 'https://mil.ifeng.com');
}

// 国防科技信息网
async function fetchDSTI() {
  return htmlScrape('DSTI', 'http://www.dsti.net/', 'DSTI', 'B', 10, 'http://www.dsti.net');
}

// ═══════════════════════════════════════════════════════════════
// INTERNATIONAL — NewsAPI + RSS (原则2,5,8)
// ═══════════════════════════════════════════════════════════════

// Expanded NewsAPI mapping covering principles 2,5,6,8
const NEWSAPI_SOURCES = {
  finance: 'bloomberg,reuters,financial-times,the-wall-street-journal,the-economist,cnbc,fortune,business-insider',
  politics: 'bbc-news,the-guardian-uk,associated-press,al-jazeera-english,politico,abc-news,the-washington-post,the-hindu,time,newsweek,independent,der-spiegel,le-monde,google-news',
  military: 'reuters,bbc-news,associated-press,al-jazeera-english'
};

async function fetchNewsApi(category) {
  var sources = NEWSAPI_SOURCES[category];
  if (!sources) return [];
  var url = NEWSAPI_BASE + '/everything?sources=' + sources + '&pageSize=50&sortBy=publishedAt&from=' + TODAY + '&apiKey=' + NEWSAPI_KEY;
  try {
    var raw = await httpGet(url);
    var json = safeParseJSON(raw);
    if (!json || json.status !== 'ok' || !json.articles) return [];
    return json.articles.map((a, i) => ({
      title: a.title || 'Untitled',
      source: normalizeSourceName(a.source && a.source.name || ''),
      trust: 'A',
      heat: Math.max(30, 100 - i * 2),
      minsAgo: Math.round((now() - new Date(a.publishedAt).getTime()) / 60000),
      url: a.url || '',
      cluster: detectCluster(a.title),
      debunk: false,
      sourceFull: getSrc(normalizeSourceName(a.source && a.source.name || '')).full,
      sourceColor: getSrc(normalizeSourceName(a.source && a.source.name || '')).color,
      sourceLabel: getSrc(normalizeSourceName(a.source && a.source.name || '')).label,
      hotScore: 0
    })).filter(function(a) { return a.minsAgo <= MAX_AGE_HOURS * 60; });
  } catch (e) { return []; }
}

// International RSS feeds supplementing NewsAPI gaps
const INTL_RSS_FEEDS = [
  // Finance
  { url: 'https://feeds.marketwatch.com/marketwatch/topstories', src: 'MarketWatch', cat: 'finance' },
  { url: 'https://asia.nikkei.com/rss/feed/nar', src: 'NikkeiAsia', cat: 'finance' },
  { url: 'https://economictimes.indiatimes.com/rssfeedstopstories.cms', src: 'EconTimes', cat: 'finance' },
  { url: 'https://en.yna.co.kr/RSS/news.xml', src: 'Yonhap', cat: 'politics' },
  // Politics
  { url: 'https://www.france24.com/en/rss', src: 'France24', cat: 'politics' },
  { url: 'https://rss.dw.com/rdf/rss-en-all', src: 'DW', cat: 'politics' },
  { url: 'http://www.asahi.com/rss/asahi/newsheadlines.rdf', src: 'AsahiShimbun', cat: 'politics' },
  { url: 'https://www.scmp.com/rss/91/news', src: 'SCMP', cat: 'politics' },
  { url: 'https://timesofindia.indiatimes.com/rssfeedstopstories.cms', src: 'TimesOfIndia', cat: 'politics' },
  { url: 'https://www.al-monitor.com/feed', src: 'AlMonitor', cat: 'politics' },
  { url: 'https://www.straitstimes.com/news/asia/rss.xml', src: 'StraitsTimes', cat: 'politics' },
  { url: 'https://www3.nhk.or.jp/nhkworld/en/news/rss.xml', src: 'NHK', cat: 'politics' },
  { url: 'https://rss.nytimes.com/services/xml/rss/nyt/World.xml', src: 'NYT', cat: 'politics' },
  // Military
  { url: 'https://www.defensenews.com/arc/outboundfeeds/rss/?outputType=xml', src: 'DefenseNews', cat: 'military' },
  { url: 'https://www.twz.com/rss', src: 'WarZone', cat: 'military' },
  { url: 'https://www.navalnews.com/feed/', src: 'NavalNews', cat: 'military' },
  { url: 'https://feeds.bbci.co.uk/news/world/rss.xml', src: 'BBC', cat: 'politics' }
];

async function fetchInternationalRSS() {
  var all = [];
  for (var i = 0; i < INTL_RSS_FEEDS.length; i++) {
    var feed = INTL_RSS_FEEDS[i];
    try {
      var parsed = await rssParser.parseURL(feed.url);
      if (!parsed || !parsed.items) continue;
      for (var j = 0; j < parsed.items.length; j++) {
        var item = parsed.items[j];
        var title = (item.title || '').replace(/<[^>]+>/g, '').trim();
        if (!title || title.length < 8) continue;
        var pubDate = item.pubDate ? new Date(item.pubDate) : (item.isoDate ? new Date(item.isoDate) : new Date());
        var minsAgo = Math.round((now() - pubDate.getTime()) / 60000);
        if (minsAgo > MAX_AGE_HOURS * 60) continue;
        all.push(makeArticle(title, feed.src, 'A',
          Math.max(30, 95 - Math.floor(Math.random() * 40)),
          Math.max(1, minsAgo), item.link || ''));
      }
    } catch (e) { /* skip failed feeds */ }
  }
  return all;
}

// ═══════════════════════════════════════════════════════════════
// MILITARY SCORING — 原则7 军事分类
// ═══════════════════════════════════════════════════════════════

const STRONG_MIL_KW = [
  '\u519b\u4e8b','\u56fd\u9632\u90e8','\u89e3\u653e\u519b','\u6d77\u519b','\u7a7a\u519b','\u9646\u519b','\u706b\u7bad\u519b',
  '\u822a\u6bcd','\u6218\u6597\u673a','\u9a71\u9010\u8230','\u6838\u6f5c\u8247','\u6d32\u9645\u5bfc\u5f39',
  '\u519b\u6f14','\u5b9e\u6218\u5316\u6f14\u4e60','\u7279\u79cd\u90e8\u961f','\u519b\u4e8b\u884c\u52a8',
  '\u7a7a\u88ad','\u6218\u533a','\u6218\u7565\u8f70\u70b8\u673a','\u5f39\u9053\u5bfc\u5f39',
  '\u519b\u4e8b\u57fa\u5730','\u6b66\u88c5\u90e8\u961f','\u6d77\u519b\u9646\u6218\u961f',
  '\u519b\u4e8b\u8bad\u7ec3','\u6b66\u5668\u88c5\u5907','\u519b\u4e8b\u90e8\u7f72','\u6218\u6597\u7fa4',
  '\u519b\u4e8b\u5a01\u6151','\u53cd\u5bfc\u7cfb\u7edf','\u6218\u4e89','\u4f5c\u6218\u90e8\u961f',
  '\u519b\u4e8b\u79d1\u6280','\u56fd\u9632\u79d1\u6280',
  'missile','drone','fighter jet','bomber','aircraft carrier','submarine','nuclear weapon',
  'military exercise','air strike','special forces','combat','battle','war'
];

const MEDIUM_MIL_KW = [
  '\u519b\u961f','\u519b\u4eba','\u5b98\u5175','\u6218\u58eb','\u519b\u7eaa','\u519b\u5a5a',
  '\u6218\u5907','\u6b66\u5668','\u5f39\u836f','\u88c5\u7532','\u5766\u514b','\u96f7\u8fbe','\u536b\u661f',
  '\u519b\u8230','\u6218\u8230','\u6218\u673a','\u76f4\u5347\u673a','\u65e0\u4eba\u6218\u6597\u673a',
  '\u519b\u7528','\u9632\u52a1','\u519b\u5de5','\u56fd\u9632\u5de5\u4e1a','\u519b\u8d38',
  '\u5de1\u822a','\u6218\u5de1','\u6218\u7565','\u9632\u7a7a','\u53cd\u6f5c','\u53cd\u6050','\u7ef4\u548c',
  '\u62a4\u822a','\u62a4\u6d77','\u4f5c\u6218\u6307\u6325','\u592a\u7a7a\u519b',
  '\u7f51\u7edc\u6218','\u7535\u5b50\u6218','\u4fe1\u606f\u6218',
  'military','defense','navy','army','air force','weapon','nuclear',
  'NATO','AUKUS','Pentagon','MOD','PLA','warship',
  '\u53f0\u6d77\u5ce1','\u53f0\u6d77','\u5357\u6d77','\u9493\u9c7c\u5c9b','\u4e2d\u5370\u8fb9\u5883',
  '\u671d\u9c9c\u534a\u5c9b','\u671d\u9c9c\u5bfc\u5f39','\u4fc4\u4e4c','\u4e2d\u4e1c\u5c40\u52bf'
];

const WEAK_MIL_KW = [
  '\u519b','\u6218','\u5c04\u51fb','\u88c5\u5907','\u90e8\u961f',
  '\u884c\u52a8','\u51b2\u7a81','\u5a01\u80c1','\u5b89\u5168','\u8fb9\u5883','\u6d77\u57df',
  '\u519b\u54c1','\u98de\u884c\u5458','\u8230\u957f','\u58eb\u5175','\u6307\u6218\u5458'
];

const ANTI_MIL_KW = [
  '\u5929\u6c14','\u964d\u96e8','\u66b4\u96e8','\u53f0\u98ce','\u6d2a\u6c34','\u5730\u9707',
  '\u623f\u4ef7','\u623f\u5730\u4ea7','\u4f4f\u623f','\u4fdd\u969c\u623f','\u516c\u79df\u623f',
  '\u6559\u80b2','\u5b66\u751f','\u5b66\u6821','\u8003\u8bd5','\u9ad8\u8003',
  '\u65c5\u6e38','\u666f\u533a','\u65c5\u5ba2','\u9152\u5e97',
  '\u82b1\u5349','\u52a8\u7269','\u9e1f\u7c7b','\u718a\u732b',
  '\u5065\u5eb7','\u517b\u751f','\u996e\u98df','\u5065\u8eab','\u51cf\u80a5',
  '\u5a31\u4e50','\u660e\u661f','\u7535\u5f71','\u97f3\u4e50','\u6b4c\u624b',
  '\u4f53\u80b2','\u7403\u8d5b','\u6bd4\u8d5b','\u8db3\u7403','\u7bee\u7403','\u5965\u8fd0',
  '\u7f8e\u98df','\u5c0f\u5403','\u706b\u9505',
  '\u82b1\u5f00','\u82b1\u671f','\u76db\u5f00',
  'pet','animal','bird','flower','garden','travel','tourist','hotel',
  'recipe','food','restaurant','wine','coffee',
  'health','fitness','diet','exercise',
  'movie','music','celebrity','sport','game','football',
  'weather','rain','storm','hurricane','earthquake'
];

function militaryScore(title) {
  var text = title.toLowerCase();
  var score = 0;
  for (var i = 0; i < ANTI_MIL_KW.length; i++) {
    if (text.indexOf(ANTI_MIL_KW[i].toLowerCase()) >= 0) return -10;
  }
  for (var i2 = 0; i2 < STRONG_MIL_KW.length; i2++) {
    if (text.indexOf(STRONG_MIL_KW[i2].toLowerCase()) >= 0) score += 4;
  }
  for (var i3 = 0; i3 < MEDIUM_MIL_KW.length; i3++) {
    if (text.indexOf(MEDIUM_MIL_KW[i3].toLowerCase()) >= 0) score += 2;
  }
  for (var i4 = 0; i4 < WEAK_MIL_KW.length; i4++) {
    if (text.indexOf(WEAK_MIL_KW[i4].toLowerCase()) >= 0) score += 1;
  }
  return score;
}

function isMilitaryArticle(title) {
  return militaryScore(title) >= 4;
}

// ─── Category Classification ────────────────────────────────

const FINANCE_KEYWORDS = [
  '\u592e\u884c','\u5229\u7387','\u80a1\u5e02','A\u80a1','\u57fa\u91d1','\u503a\u5238','\u6c47\u7387',
  '\u4eba\u6c11\u5e01','\u7f8e\u5143','\u6b27\u5143','\u65e5\u5143',
  '\u9ec4\u91d1','\u77f3\u6cb9','\u80fd\u6e90','\u6bd4\u7279\u5e01','\u52a0\u5bc6\u8d27\u5e01',
  'IPO','\u4e0a\u5e02','\u8d22\u62a5','\u8425\u6536','\u5229\u6da6',
  '\u6295\u8d44','\u878d\u8d44','\u503a\u52a1','\u8d64\u5b57','\u901a\u80c0','CPI','PPI','GDP','PMI',
  '\u8d38\u6613','\u5173\u7a0e','\u5236\u9020\u4e1a','\u623f\u5730\u4ea7','\u623f\u4ef7',
  '\u6d88\u8d39','\u96f6\u552e','\u4f9b\u5e94\u94fe','\u534a\u5bfc\u4f53','\u82af\u7247',
  '\u79d1\u6280\u80a1','\u8d22\u7ecf','\u7ecf\u6d4e','\u8d22\u65b0','\u91d1\u878d',
  '\u4f01\u4e1a','\u4ea7\u4e1a','\u5546\u52a1\u90e8','\u5de5\u4e1a','\u5546\u4e1a',
  '\u8fdb\u51fa\u53e3','\u5916\u8d38','\u5546\u54c1','\u7269\u4ef7','\u6da8\u4ef7',
  '\u8d39\u7528','\u7a0e\u52a1','\u8d22\u653f','\u8865\u8d34','\u88e1\u5e02\u573a',
  '\u77ff\u4ea7','\u5185\u9700','\u5916\u9700','\u6d77\u5916','\u51fa\u53e3',
  '\u7ecf\u8d38','\u8de8\u5883','\u6570\u5b57\u7ecf\u6d4e','\u5e73\u53f0\u7ecf\u6d4e',
  '\u65b0\u80fd\u6e90\u6c7d\u8f66','\u65b0\u8d28\u751f\u4ea7\u529b',
  '\u94f6\u884c','\u4fdd\u9669','\u8bc1\u5238','\u4e0a\u4ea4\u6240','\u6df1\u4ea4\u6240',
  'stock','market','bond','yield','rate','hike','central bank','fed','ECB',
  'inflation','growth','recession','merger','acquisition','earnings','revenue',
  'commodity','crude','OPEC','gold','silver','crypto','bitcoin'
];

const POLITICS_KEYWORDS = [
  '\u4e60\u8fd1\u5e73','\u603b\u4e66\u8bb0','\u56fd\u5bb6\u4e3b\u5e2d','\u603b\u7406',
  '\u5916\u4ea4\u90e8','\u53d1\u8a00\u4eba','\u56fd\u52a1\u9662','\u5168\u56fd\u4eba\u5927',
  '\u653f\u5e9c','\u653f\u7b56','\u6cd5\u89c4','\u7acb\u6cd5','\u884c\u653f',
  '\u515a','\u515a\u5efa','\u515a\u7eaa','\u53cd\u8150','\u5ec9\u6d01','\u5de1\u89c6',
  '\u5916\u4ea4','\u8bbf\u95ee','\u4f1a\u89c1','\u4f1a\u665e','\u8c08\u5224',
  '\u8054\u5408\u56fd','\u5b89\u7406\u4f1a','WHO','WTO','IMF','G20','G7',
  '\u6cbb\u7406','\u793e\u4f1a\u6cbb\u7406','\u793e\u533a\u6cbb\u7406',
  '\u56fd\u9645\u5173\u7cfb','\u53cc\u8fb9\u5173\u7cfb','\u591a\u8fb9',
  '\u534f\u8bae','\u5408\u4f5c','\u6218\u7565\u5bf9\u8bdd',
  '\u53d1\u5c55\u6218\u7565','\u6539\u9769','\u89c4\u5212',
  '\u516c\u5b89\u90e8','\u516c\u5b89','\u6cbb\u5b89',
  '\u6d89\u5916','\u9886\u4e8b','\u62a4\u7167','\u5236\u88c1',
  'president','prime minister','congress','parliament','senate',
  'diplomat','sanction','embassy','consulate','summit','treaty'
];

function categorizeArticle(article) {
  var text = article.title.toLowerCase();
  // Finance keywords
  for (var k = 0; k < FINANCE_KEYWORDS.length; k++) {
    if (text.indexOf(FINANCE_KEYWORDS[k].toLowerCase()) >= 0) return 'finance';
  }
  // Military scoring
  if (isMilitaryArticle(article.title)) return 'military';
  // Politics keywords
  for (var p = 0; p < POLITICS_KEYWORDS.length; p++) {
    if (text.indexOf(POLITICS_KEYWORDS[p].toLowerCase()) >= 0) return 'politics';
  }
  // Exclude non-news
  for (var a = 0; a < ANTI_MIL_KW.length; a++) {
    if (text.indexOf(ANTI_MIL_KW[a].toLowerCase()) >= 0) return 'other';
  }
  // Default to politics for Chinese content
  if (/[\u4e00-\u9fff]/.test(article.title)) return 'politics';
  return 'politics';
}

// ─── Translation ─────────────────────────────────────────────

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
    console.error('[translateArticles] failed:', e.message);
  }
}

// ═══════════════════════════════════════════════════════════════
// MAIN: fetchTrending — 6榜统一入口
// ═══════════════════════════════════════════════════════════════

async function fetchTrending(domain, category) {
  var cacheKey = 'trending_' + domain + '_' + category;
  var cached = cache.get(cacheKey);
  if (cached) return cached;

  console.log('[fetchTrending] domain=' + domain + ' category=' + category);
  var articles = [];

  if (domain === 'domestic') {
    if (category === 'finance') {
      // 原则1: 国内财经 = HTML爬虫 + RSS + CCTV economy
      var results = await Promise.all([
        fetchDomesticFinanceHTML(),
        fetchDomesticRSS(),
        fetchCCTV()
      ]);
      articles = results[0].concat(results[1]).concat(results[2]);
      articles = articles.filter(function(a) {
        var t = a.title.toLowerCase();
        for (var k = 0; k < FINANCE_KEYWORDS.length; k++) {
          if (t.indexOf(FINANCE_KEYWORDS[k].toLowerCase()) >= 0) return true;
        }
        return false;
      });
    } else if (category === 'military') {
      // 原则7: 国内军事 = 军事专属爬虫 + 关键词筛选
      var milResults = await Promise.all([
        fetchMOD(), fetch81cn(), fetchXinhuaMil(), fetchHuanqiuMil(),
        fetchCankaoxiaoxi(), fetchThePaperDefense(), fetchGuanchaMil(),
        fetchCNRMil(), fetchIfengMil(), fetchQQMil(), fetchDSTI(),
        fetchDomesticRSS(), fetchCCTV()
      ]);
      articles = [];
      for (var i = 0; i < milResults.length; i++) {
        articles = articles.concat(milResults[i]);
      }
      // Filter: explicit military sources always included, others need military score >= 4
      var explicitMilSources = ['MOD','PLAOnline','XinhuaMil','GTimesMil','Cankaoxiaoxi',
        'ThePaper','GuanchaMil','CNRMil','IfengMil','QQMil','DSTI'];
      articles = articles.filter(function(a) {
        if (explicitMilSources.indexOf(a.source) >= 0) return true;
        return isMilitaryArticle(a.title);
      });
    } else {
      // Politics: CCTV + RSS + Huanqiu + FMPRC
      var polResults = await Promise.all([
        fetchCCTV(), fetchDomesticRSS(), fetchHuanqiu(), fetchFMPRC()
      ]);
      articles = polResults[0].concat(polResults[1]).concat(polResults[2]).concat(polResults[3]);
      // Filter to politics
      articles = articles.filter(function(a) {
        var t = a.title.toLowerCase();
        for (var p2 = 0; p2 < POLITICS_KEYWORDS.length; p2++) {
          if (t.indexOf(POLITICS_KEYWORDS[p2].toLowerCase()) >= 0) return true;
        }
        // Exclude non-politics content
        for (var a2 = 0; a2 < ANTI_MIL_KW.length; a2++) {
          if (t.indexOf(ANTI_MIL_KW[a2].toLowerCase()) >= 0) return false;
        }
        return true;
      });
    }
  } else {
    // International: NewsAPI + RSS
    var intlResults = await Promise.all([
      fetchNewsApi(category),
      fetchInternationalRSS()
    ]);
    articles = intlResults[0].concat(intlResults[1]);
    await translateArticles(articles);
    // Filter by category for international
    articles = articles.filter(function(a) {
      var cat = categorizeArticle(a);
      if (cat === 'other') return false;
      return cat === category;
    });
  }

  // Deduplicate
  var seen = new Set();
  articles = articles.filter(function(a) {
    var key = a.title.slice(0, 30).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Calculate hot scores
  articles.forEach(function(a) {
    a.hotScore = calcHotScore(a.heat, a.minsAgo, a.trust);
    a.hotBreakdown = calcHotBreakdown(a.heat, a.minsAgo, a.trust);
  });

  // Sort
  articles.sort(function(a, b) { return b.hotScore - a.hotScore; });

  // 原则9: 军事弥补机制 — if < 50, supplement
  if (category === 'military' && articles.length < TARGET_COUNT) {
    console.log('[fetchTrending] Military supplement: have ' + articles.length + ', need ' + TARGET_COUNT);
    // Supplement from CCTV + RSS with relaxed military scoring
    var suppResults = await Promise.all([fetchCCTV(), fetchDomesticRSS()]);
    var suppArticles = suppResults[0].concat(suppResults[1]);
    suppArticles = suppArticles.filter(function(a) {
      return militaryScore(a.title) >= 2 && !seen.has(a.title.slice(0, 30).toLowerCase());
    });
    suppArticles.forEach(function(a, i) { a.hotScore = 20 + Math.floor(Math.random() * 30); });
    articles = articles.concat(suppArticles.slice(0, TARGET_COUNT - articles.length));
    articles.sort(function(a, b) { return b.hotScore - a.hotScore; });
  }

  // 原则10: 不足50条展示30+
  if (articles.length < TARGET_COUNT && articles.length >= 30) {
    console.log('[fetchTrending] Limited to ' + articles.length + ' articles (below 50)');
  }

  articles = articles.slice(0, TARGET_COUNT);
  articles.forEach(function(a, i) { a.rank = i + 1; });

  var sourceCount = (new Set(articles.map(function(a) { return a.source; }))).size;
  var result = {
    domain: domain, category: category,
    total: articles.length, items: articles,
    updatedAt: now(),
    sourceCount: sourceCount,
    limited: articles.length < TARGET_COUNT
  };

  cache.set(cacheKey, result, CACHE_TTL);
  console.log('[fetchTrending] ' + domain + '/' + category + ': ' + result.total + ' items / ' + sourceCount + ' sources');
  return result;
}

module.exports = { fetchTrending: fetchTrending, SOURCES: require('./sources').SOURCES };
