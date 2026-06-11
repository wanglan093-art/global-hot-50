'use strict';
const https = require('https');

// Batch translate via MyMemory (free tier, 1000 chars/req max)
function translateSingle(text) {
  return new Promise((resolve) => {
    if (!text || typeof text !== 'string') return resolve(text);
    const q = encodeURIComponent(text.slice(0, 500));
    const url = 'https://api.mymemory.translated.net/get?q=' + q + '&langpair=en|zh&de=tech@globalhot50';
    https.get(url, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const translated = json.responseData?.translatedText;
          resolve(translated && translated !== text ? translated : text);
        } catch (e) { resolve(text); }
      });
    }).on('error', () => resolve(text));
  });
}

async function translateBatch(texts, concurrency) {
  const limit = concurrency || 4;
  const results = new Array(texts.length);
  for (let i = 0; i < texts.length; i += limit) {
    const batch = texts.slice(i, i + limit).map(t => translateSingle(t));
    const translated = await Promise.all(batch);
    for (let j = 0; j < translated.length; j++) {
      results[i + j] = translated[j];
    }
    if (i + limit < texts.length) {
      await new Promise(r => setTimeout(r, 300));
    }
  }
  return results;
}

module.exports = { translateSingle, translateBatch };
