'use strict';

const https = require('https');
const http = require('http');
const cache = require('./cache');
const { SOURCES, isChinese, getSrc } = require('./sources');
const { translateBatch } = require('./translate');
const RssParser = require('rss-parser');
const iconv = require('iconv-lite');

const NEWSAPI_KEY = process.env.NEWSAPI_KEY || '480168630be8476bb441a241ae4e3780';
const NEWSAPI_BASE = 'https://newsapi.org/v2';
const TODAY = new Date().toISOString().split('T')[0];
const CACHE_TTL = 10 * 60 * 1000;
const TRANSLATE_CONCURRENCY = 4;
const TARGET_COUNT = 50;
const MAX_AGE_HOURS = 48;  // Extended to 48 hours for better coverage

// ─── HTTP helpers ───────────────────────────────────────────

function httpGet(url, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    var mod = url.startsWith('https') ? https : http;
    var reqOpts = { timeout: opts.timeout || 15000 };
    if (opts.headers) reqOpts.headers = opts.headers;
    var req = mod.get(url, reqOpts, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        httpGet(res.headers.location, opts).then(resolve).catch(reject);
        return;
      }
      var chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        var buf = Buffer.concat(chunks);
        if (opts.encoding === 'gb2312' || opts.encoding === 'gbk') {
          resolve(iconv.decode(buf, 'gb2312'));
        } else if (opts.binary) {
          resolve(buf);
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

// ─── Heat Score Algorithm ────────────────────────────────────

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

// ─── Source normalization ────────────────────────────────────

function normalizeSourceName(name) {
  var map = {
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

// ─── NewsAPI (international) ─────────────────────────────────

const NEWSAPI_SOURCES = {
  finance: 'bloomberg,reuters,financial-times,the-wall-street-journal,the-economist,cnbc,fortune,business-insider',
  politics: 'bbc-news,cnn,the-guardian-uk,associated-press,al-jazeera-english,politico,abc-news,the-washington-post,the-hindu,time,newsweek,independent',
  military: 'reuters,bbc-news,associated-press,the-guardian-uk,al-jazeera-english'
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
  } catch (e) {
    console.error('[fetchNewsApi] Error:', e.message);
    return [];
  }
}

// ─── CCTV JSONP ──────────────────────────────────────────────

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
          if (!isNaN(d.getTime())) minsAgo = Math.round((now() - d.getTime()) / 60000);
        }
        all.push(makeArticle(title, src, 'A', Math.max(40, 98 - Math.floor(Math.random() * 30)),
          Math.max(1, minsAgo), item.url || 'https://news.cctv.com'));
      }
    } catch (e) {
      console.error('[fetchCCTV] Error on ' + ep.url + ':', e.message);
    }
  }
  return all.filter(function(a) { return a.minsAgo <= MAX_AGE_HOURS * 60; });
}

// ─── Chinese RSS Feeds ───────────────────────────────────────

const CHINESE_RSS_FEEDS = [
  { url: 'https://www.chinanews.com/rss/scroll-news.xml', src: 'ChinaNews', cat: 'politics' },
  { url: 'http://www.people.com.cn/rss/politics.xml', src: 'PeopleDaily', cat: 'politics' },
  { url: 'http://www.people.com.cn/rss/finance.xml', src: 'PeopleDaily', cat: 'finance' },
  { url: 'http://www.chinadaily.com.cn/rss/world_rss.xml', src: 'ChinaDaily', cat: 'politics' },
  { url: 'http://www.chinadaily.com.cn/rss/china_rss.xml', src: 'ChinaDaily', cat: 'politics' }
];

const rssParser = new RssParser({
  timeout: 15000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
  }
});

async function fetchChineseRSS() {
  var all = [];
  for (var i = 0; i < CHINESE_RSS_FEEDS.length; i++) {
    var feed = CHINESE_RSS_FEEDS[i];
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
          Math.max(1, minsAgo), item.link || '',
          feed.cat));
      }
    } catch (e) {
      // console.error('[fetchChineseRSS] Failed on ' + feed.src + ':', e.message);
    }
  }
  return all;
}

// ─── Chinese Military Scrapers ───────────────────────────────

function extractHTMLTitles(html, minLen) {
  minLen = minLen || 8;
  var titles = [];
  // Strategy 1: <a title="..."> attributes
  var titleAttrs = html.match(/<a[^>]*title="([^"]{8,200})"[^>]*>/gi);
  if (titleAttrs) {
    titleAttrs.forEach(function(ta) {
      var m = ta.match(/title="([^"]+)"/);
      if (m) {
        var t = m[1].replace(/<[^>]+>/g, '').replace(/&[a-z]+;/g, '').trim();
        if (t.length >= minLen && t.indexOf('javascript') < 0 && t.indexOf('http') < 0) {
          titles.push(t);
        }
      }
    });
  }
  // Strategy 2: <a>text</a> plain text links
  if (titles.length < 5) {
    var linkMatches = html.match(/<a[^>]*>(.{8,200})<\/a>/gi);
    if (linkMatches) {
      linkMatches.forEach(function(lm) {
        var t = lm.replace(/<[^>]+>/g, '').replace(/&[a-z]+;/g, '').trim();
        if (t.length >= minLen && t.indexOf('javascript') < 0 && t.indexOf('http') < 0 && t.indexOf('<') < 0) {
          titles.push(t);
        }
      });
    }
  }
  return titles;
}

function extractHTMLLinks(html) {
  var links = [];
  var hrefMatches = html.match(/<a[^>]*href="([^"]+)"[^>]*>/gi);
  if (hrefMatches) {
    hrefMatches.forEach(function(hm) {
      var hm2 = hm.match(/href="([^"]+)"/);
      var ht = hm.match(/title="([^"]+)"/);
      if (hm2) {
        links.push({ url: hm2[1], title: ht ? ht[1].replace(/<[^>]+>/g, '').trim() : '' });
      }
    });
  }
  return links;
}

// 央广军事 scraper — GB2312 encoded
async function fetchCNRMilitary() {
  try {
    var html = await httpGet('http://military.cnr.cn/', { encoding: 'gb2312', timeout: 15000 });
    var links = extractHTMLLinks(html);
    var titles = extractHTMLTitles(html, 8);

    var articles = [];
    var seen = new Set();
    for (var i = 0; i < Math.min(titles.length, 50); i++) {
      var title = titles[i];
      if (seen.has(title.slice(0, 20))) continue;
      seen.add(title.slice(0, 20));

      // Find matching URL
      var url = 'http://military.cnr.cn/';
      for (var j = 0; j < links.length; j++) {
        if (links[j].title && links[j].title.indexOf(title.slice(0, 6)) >= 0) {
          url = links[j].url;
          if (!url.startsWith('http')) url = 'http://military.cnr.cn' + (url.startsWith('/') ? '' : '/') + url;
          break;
        }
      }

      articles.push(makeArticle(title, 'CNRMil', 'A',
        75 + Math.floor(Math.random() * 25),
        10 + Math.floor(Math.random() * 600), url, 'military'));
    }
    return articles;
  } catch (e) {
    console.error('[fetchCNRMilitary] Error:', e.message);
    return [];
  }
}

// 凤凰网军事 scraper
async function fetchIfengMilitary() {
  try {
    var html = await httpGet('https://mil.ifeng.com/', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      timeout: 15000
    });
    var links = extractHTMLLinks(html);
    var titles = extractHTMLTitles(html, 8);

    var articles = [];
    var seen = new Set();
    for (var i = 0; i < Math.min(titles.length, 50); i++) {
      var title = titles[i];
      if (seen.has(title.slice(0, 20))) continue;
      seen.add(title.slice(0, 20));

      var url = 'https://mil.ifeng.com/';
      for (var j = 0; j < links.length; j++) {
        if (links[j].title && title.indexOf(links[j].title.slice(0, 6)) >= 0) {
          url = links[j].url;
          if (!url.startsWith('http')) url = 'https:' + (url.startsWith('//') ? '' : '//') + url;
          break;
        }
      }
      articles.push(makeArticle(title, 'IfengMil', 'B',
        65 + Math.floor(Math.random() * 30),
        5 + Math.floor(Math.random() * 720), url, 'military'));
    }
    return articles;
  } catch (e) {
    console.error('[fetchIfengMilitary] Error:', e.message);
    return [];
  }
}

// ─── International RSS Feeds ─────────────────────────────────

const INTL_RSS_FEEDS = [
  { url: 'https://www.scmp.com/rss/91/news', src: 'SCMP', cat: 'politics' },
  { url: 'https://www.defensenews.com/arc/outboundfeeds/rss/?outputType=xml', src: 'DefenseNews', cat: 'military' },
  { url: 'https://www.twz.com/rss', src: 'WarZone', cat: 'military' },
  { url: 'https://www.al-monitor.com/feed', src: 'AlMonitor', cat: 'politics' },
  { url: 'https://www.straitstimes.com/news/asia/rss.xml', src: 'StraitsTimes', cat: 'politics' },
  { url: 'https://en.yna.co.kr/RSS/news.xml', src: 'Yonhap', cat: 'politics' },
  { url: 'https://www3.nhk.or.jp/nhkworld/en/news/rss.xml', src: 'NHK', cat: 'politics' },
  { url: 'https://timesofindia.indiatimes.com/rssfeedstopstories.cms', src: 'TimesOfIndia', cat: 'politics' }
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
          Math.max(1, minsAgo), item.link || '', feed.cat));
      }
    } catch (e) {
      // skip silently
    }
  }
  return all;
}

// ─── Article builder ─────────────────────────────────────────

function makeArticle(title, source, trust, heat, minsAgo, url, category) {
  return {
    title: title,
    source: source,
    trust: trust,
    heat: heat,
    minsAgo: minsAgo,
    url: url,
    cluster: detectCluster(title),
    debunk: false,
    sourceFull: getSrc(source).full,
    sourceColor: getSrc(source).color,
    sourceLabel: getSrc(source).label,
    category: category || null,
    hotScore: 0
  };
}

// ─── Cluster detection ───────────────────────────────────────

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

// ─── SCORING-BASED Military Categorization ───────────────────

// Strong military keywords (score +4):  definite military content
const STRONG_MIL_KW = [
  '\u519b\u4e8b','\u56fd\u9632\u90e8','\u89e3\u653e\u519b','\u6d77\u519b','\u7a7a\u519b','\u9646\u519b','\u706b\u7bad\u519b',
  '\u6218\u7565\u652f\u63f4\u90e8\u961f','\u822a\u6bcd','\u6218\u6597\u673a','\u9a71\u9010\u8230','\u6838\u6f5c\u8247',
  '\u6d32\u9645\u5bfc\u5f39','\u519b\u6f14','\u5b9e\u6218\u5316\u6f14\u4e60','\u7279\u79cd\u90e8\u961f','\u519b\u4e8b\u884c\u52a8',
  '\u7a7a\u88ad','\u5bfc\u5f39\u88ad\u51fb','\u6218\u533a','\u6218\u7565\u8f70\u70b8\u673a',
  '\u5f39\u9053\u5bfc\u5f39','\u519b\u4e8b\u57fa\u5730','\u6b66\u88c5\u90e8\u961f','\u6d77\u519b\u9646\u6218\u961f',
  '\u519b\u4e8b\u8bad\u7ec3','\u6b66\u5668\u88c5\u5907','\u519b\u4e8b\u90e8\u7f72','\u6218\u6597\u7fa4',
  '\u519b\u4e8b\u5a01\u6151','\u53cd\u5bfc\u7cfb\u7edf','\u6218\u4e89','\u519b\u4e8b\u51b2\u7a81',
  '\u4f5c\u6218\u90e8\u961f','\u6218\u6597\u673a\u7f16\u961f','\u8230\u8247\u7f16\u961f',
  'missile','drone','fighter jet','bomber','aircraft carrier','submarine','nuclear weapon',
  'military exercise','air strike','special forces','combat','battle','war',
  '\u519b\u4e8b\u79d1\u6280','\u56fd\u9632\u79d1\u6280',
];

// Medium military keywords (score +2):  likely military content
const MEDIUM_MIL_KW = [
  '\u519b\u961f','\u519b\u4eba','\u5b98\u5175','\u6218\u58eb','\u519b\u7eaa','\u519b\u5a5a',
  '\u6218\u5907','\u6b66\u5668','\u5f39\u836f','\u88c5\u7532','\u5766\u514b','\u96f7\u8fbe','\u536b\u661f',
  '\u519b\u8230','\u6218\u8230','\u6218\u673a','\u76f4\u5347\u673a','\u65e0\u4eba\u6218\u6597\u673a',
  '\u519b\u7528','\u9632\u52a1','\u519b\u5de5','\u56fd\u9632\u5de5\u4e1a','\u519b\u8d38',
  '\u5de1\u822a','\u6218\u5de1','\u519b\u4e8b\u76f4\u64ad','\u6218\u7565',
  '\u9632\u7a7a','\u53cd\u6f5c','\u53cd\u6050','\u7ef4\u548c',
  '\u519b\u4e8b\u6cd5\u5ead','\u519b\u4e8b\u88c1\u519b',
  '\u62a4\u822a','\u62a4\u6d77','\u4f5c\u6218\u6307\u6325','\u6218\u7565\u8d44\u6e90',
  '\u519b\u4e8b\u901a\u4fe1','\u519b\u4e8b\u536b\u661f','\u519b\u4e8b\u822a\u5929',
  '\u592a\u7a7a\u519b','\u7f51\u7edc\u6218','\u7535\u5b50\u6218','\u4fe1\u606f\u6218',
  'military','defense','navy','army','air force','weapon','nuclear',
  'NATO','AUKUS','Pentagon','MOD','PLA','warship',
  '\u53f0\u6d77\u5ce1','\u53f0\u6d77','\u4e1c\u6d77\u9632\u8bc6\u8bc6\u522b\u533a',
  '\u5357\u6d77','\u9493\u9c7c\u5c9b','\u4e2d\u5370\u8fb9\u5883',
  '\u671d\u9c9c\u534a\u5c9b','\u671d\u9c9c\u5bfc\u5f39',
  '\u4fc4\u4e4c','\u4e2d\u4e1c\u5c40\u52bf','\u4ee5\u8272\u5217',
  '\u519b\u4e8b\u8d5b'
];

// Weak military keywords (score +1):  borderline / context-dependent
const WEAK_MIL_KW = [
  '\u519b','\u6218','\u5c04\u51fb','\u88c5\u5907','\u90e8\u961f','\u6218\u7565',
  '\u884c\u52a8','\u51b2\u7a81','\u5a01\u80c1','\u5b89\u5168','\u8fb9\u5883','\u6d77\u57df',
  '\u519b\u54c1','\u519b\u5de5\u4f01\u4e1a','\u822a\u7a7a\u6bcd\u8230',
  '\u6218\u6597','\u4f5c\u6218','\u5b9e\u6218','\u6f14\u7ec3','\u9a7e\u9a76\u5458',
  '\u98de\u884c\u5458','\u8230\u957f','\u519b\u4e8b\u533b\u5b66','\u519b\u4e8b\u9662\u6821',
  '\u58eb\u5175','\u6307\u6218\u5458','\u519b\u4e8b\u8d5b\u4e8b','\u519b\u4e8b\u535a\u7269\u9986',
  '\u519b\u4e8b\u6237\u5916'
];

// Anti-military keywords:  these are DEFINITELY NOT military, score -10
const ANTI_MIL_KW = [
  '\u5929\u6c14','\u964d\u96e8','\u66b4\u96e8','\u53f0\u98ce','\u6d2a\u6c34','\u5730\u9707',
  '\u623f\u4ef7','\u623f\u5730\u4ea7','\u4f4f\u623f','\u4fdd\u969c\u623f','\u516c\u79df\u623f',
  '\u6559\u80b2','\u5b66\u751f','\u5b66\u6821','\u8003\u8bd5','\u9ad8\u8003','\u5c31\u4e1a',
  '\u65c5\u6e38','\u666f\u533a','\u65c5\u5ba2','\u9152\u5e97','\u6c11\u5bbf',
  '\u82b1\u5349','\u52a8\u7269','\u9e1f\u7c7b','\u72d7','\u732b','\u718a\u732b',
  '\u5065\u5eb7','\u517b\u751f','\u996e\u98df','\u5065\u8eab','\u51cf\u80a5',
  '\u5a31\u4e50','\u660e\u661f','\u7535\u5f71','\u97f3\u4e50','\u6b4c\u624b','\u6f14\u5458',
  '\u4f53\u80b2','\u7403\u8d5b','\u6bd4\u8d5b','\u8db3\u7403','\u7bee\u7403','\u5965\u8fd0',
  '\u7f8e\u98df','\u5c0f\u5403','\u706b\u9505','\u8336','\u5496\u5561',
  '\u82b1\u5f00','\u82b1\u671f','\u76db\u5f00','\u6807\u672c',
  '\u9886\u5bfc\u4eba\u51fa\u8bbf','\u5916\u4ea4\u8bbf\u95ee',
  '\u793e\u4fdd','\u533b\u7597','\u517b\u8001','\u517b\u8001\u91d1',
  '\u5730\u65b9\u4e24\u4f1a','\u653f\u534f','\u4eba\u5927',
  'pet','animal','bird','flower','garden','travel','tourist','hotel',
  'recipe','food','restaurant','wine','coffee',
  'health','fitness','diet','exercise',
  'movie','music','celebrity','sport','game','football',
  'weather','rain','storm','hurricane','earthquake'
];

function militaryScore(title) {
  var text = title.toLowerCase();
  var score = 0;

  // Anti-keywords first — if any match, immediately disqualify
  for (var i = 0; i < ANTI_MIL_KW.length; i++) {
    if (text.indexOf(ANTI_MIL_KW[i].toLowerCase()) >= 0) return -10;
  }

  // Strong keywords (+4 each)
  var strongHits = 0;
  for (var i2 = 0; i2 < STRONG_MIL_KW.length; i2++) {
    if (text.indexOf(STRONG_MIL_KW[i2].toLowerCase()) >= 0) {
      score += 4;
      strongHits++;
    }
  }

  // Medium keywords (+2 each)
  var mediumHits = 0;
  for (var i3 = 0; i3 < MEDIUM_MIL_KW.length; i3++) {
    if (text.indexOf(MEDIUM_MIL_KW[i3].toLowerCase()) >= 0) {
      score += 2;
      mediumHits++;
    }
  }

  // Weak keywords (+1 each)
  for (var i4 = 0; i4 < WEAK_MIL_KW.length; i4++) {
    if (text.indexOf(WEAK_MIL_KW[i4].toLowerCase()) >= 0) {
      score += 1;
    }
  }

  return score;
}

function isMilitaryArticle(title) {
  // Explicitly set as military by source scraper
  return militaryScore(title) >= 4;
}

// ─── Category classification ─────────────────────────────────

const CATEGORY_KEYWORDS = {
  finance: [
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
    '\u548c\u540c\u9886\u57df','\u7ecf\u6d4e\u5408\u4f5c','\u7ecf\u8d38',
    '\u8de8\u5883','\u6570\u5b57\u7ecf\u6d4e','\u5e73\u53f0\u7ecf\u6d4e',
    '\u65b0\u80fd\u6e90\u6c7d\u8f66','\u65b0\u8d28\u751f\u4ea7\u529b',
    '\u94f6\u884c','\u4fdd\u9669','\u8bc1\u5238',
    'stock','market','bond','yield','rate','cut','hike','central bank','fed','ECB','BOJ',
    'inflation','growth','recession','merger','acquisition','earnings','revenue',
    'commodity','crude','OPEC','gold','silver','crypto','bitcoin'
  ],
  politics: [
    '\u4e60\u8fd1\u5e73','\u603b\u4e66\u8bb0','\u56fd\u5bb6\u4e3b\u5e2d','\u603b\u7406',
    '\u5916\u4ea4\u90e8','\u53d1\u8a00\u4eba','\u56fd\u52a1\u9662','\u5168\u56fd\u4eba\u5927',
    '\u653f\u5e9c','\u653f\u7b56','\u6cd5\u89c4','\u7acb\u6cd5','\u884c\u653f',
    '\u515a','\u515a\u5efa','\u515a\u7eaa','\u515a\u53f2','\u515a\u5458',
    '\u53cd\u8150','\u5ec9\u6d01','\u5de1\u89c6','\u7763\u5bfc',
    '\u5916\u4ea4','\u8bbf\u95ee','\u4f1a\u89c1','\u4f1a\u665e','\u8c08\u5224',
    '\u8054\u5408\u56fd','\u5b89\u7406\u4f1a','WHO','WTO','IMF','G20','G7',
    '\u6cbb\u7406','\u793e\u4f1a\u6cbb\u7406','\u793e\u533a\u6cbb\u7406',
    '\u56fd\u9645\u5173\u7cfb','\u53cc\u8fb9\u5173\u7cfb','\u591a\u8fb9',
    '\u534f\u8bae','\u5408\u4f5c','\u6218\u7565\u5bf9\u8bdd',
    '\u53d1\u5c55\u6218\u7565','\u6539\u9769','\u89c4\u5212',
    '\u516c\u5b89\u90e8','\u516c\u5b89','\u6cbb\u5b89',
    '\u6d89\u5916','\u9886\u4e8b','\u62a4\u7167',
    '\u5236\u88c1','\u7981\u8fd0','\u5236\u7ea6',
    'president','prime minister','congress','parliament','senate',
    'diplomat','sanction','embassy','consulate',
    'summit','conference','treaty','accord'
  ]
};

function categorizeArticle(article) {
  // Check explicit category from source
  if (article.category) return article.category;

  var text = article.title.toLowerCase();

  // Check finance keywords (check first for better precision)
  for (var k = 0; k < CATEGORY_KEYWORDS.finance.length; k++) {
    if (text.indexOf(CATEGORY_KEYWORDS.finance[k].toLowerCase()) >= 0) return 'finance';
  }

  // Check military with scoring system
  if (isMilitaryArticle(article.title)) return 'military';

  // Check politics keywords
  for (var p = 0; p < CATEGORY_KEYWORDS.politics.length; p++) {
    if (text.indexOf(CATEGORY_KEYWORDS.politics[p].toLowerCase()) >= 0) return 'politics';
  }

  // Exclude articles that clearly don't belong to any category
  // (weather, animals, entertainment, health, etc. - anti-military keywords already cover many)
  for (var a = 0; a < ANTI_MIL_KW.length; a++) {
    if (text.indexOf(ANTI_MIL_KW[a].toLowerCase()) >= 0) return 'other';
  }

  // Default to politics for Chinese-language general news
  if (/[\u4e00-\u9fff]/.test(article.title)) return 'politics';

  return 'politics';
}

function filterByCategory(articles, category) {
  return articles.filter(function(a) {
    var cat = categorizeArticle(a);
    // Exclude "other" (weather, animals, etc.)
    if (cat === 'other') return false;
    // Explicit category takes priority
    if (a.category === category) return true;
    // For explicit category that differs, skip
    if (a.category && a.category !== category) return false;
    return cat === category;
  });
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
    console.error('[translateArticles] Batch failed:', e.message);
  }
}

// ─── Main Trending Fetcher ───────────────────────────────────

async function fetchTrending(domain, category) {
  var cacheKey = 'trending_' + domain + '_' + category;
  var cached = cache.get(cacheKey);
  if (cached) return cached;

  console.log('[fetchTrending] domain=' + domain + ' category=' + category);

  var articles = [];

  if (domain === 'domestic') {
    // Run all domestic sources in parallel
    var results = await Promise.all([
      fetchCCTV(),
      fetchChineseRSS(),
      fetchCNRMilitary(),
      fetchIfengMilitary()
    ]);

    var cctvArticles = results[0];
    var chineseRssArticles = results[1];
    var cnrMilArticles = results[2];
    var ifengMilArticles = results[3];

    console.log('[fetchTrending domestic] CCTV: ' + cctvArticles.length +
      ', Chinese RSS: ' + chineseRssArticles.length +
      ', CNR Mil: ' + cnrMilArticles.length +
      ', Ifeng Mil: ' + ifengMilArticles.length);

    // Combine all domestic sources
    articles = cctvArticles.concat(chineseRssArticles).concat(cnrMilArticles).concat(ifengMilArticles);

    // For military: prefer explicit military sources, then filter rest
    if (category === 'military') {
      // Military-specific sources always included
      var explicitMil = cnrMilArticles.concat(ifengMilArticles);
      var generalArticles = cctvArticles.concat(chineseRssArticles);

      // Score and filter general articles for military content
      var scoredGen = generalArticles.map(function(a) {
        a._milScore = militaryScore(a.title);
        return a;
      }).filter(function(a) { return a._milScore >= 4; })
      .sort(function(a, b) { return b._milScore - a._milScore; });

      articles = explicitMil.concat(scoredGen);
      console.log('[fetchTrending domestic-military] Explicit: ' + explicitMil.length +
        ', General filtered: ' + scoredGen.length);
    } else {
      articles = filterByCategory(articles, category);
    }
  } else {
    // International: NewsAPI + RSS
    var intlResults = await Promise.all([
      fetchNewsApi(category),
      fetchInternationalRSS()
    ]);
    var newsApiArticles = intlResults[0];
    var intlRssArticles = intlResults[1];
    var rssFiltered = filterByCategory(intlRssArticles, category);
    articles = newsApiArticles.concat(rssFiltered);
    await translateArticles(articles);
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

  // Sort by hotScore descending
  articles.sort(function(a, b) { return b.hotScore - a.hotScore; });

  // Limit to target count
  articles = articles.slice(0, TARGET_COUNT);
  articles.forEach(function(a, i) { a.rank = i + 1; });

  // Clean up internal fields
  articles.forEach(function(a) { delete a._milScore; delete a.category; });

  var result = {
    domain: domain,
    category: category,
    total: articles.length,
    items: articles,
    updatedAt: now(),
    sourceCount: (new Set(articles.map(function(a) { return a.source; }))).size
  };

  cache.set(cacheKey, result, CACHE_TTL);
  console.log('[fetchTrending] ' + domain + '/' + category + ': ' + result.total + ' items from ' + result.sourceCount + ' sources');
  return result;
}

module.exports = { fetchTrending: fetchTrending, SOURCES: require('./sources').SOURCES };
