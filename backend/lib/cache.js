'use strict';
// In-memory cache with per-key TTL (milliseconds)
const store = new Map();

function get(key) {
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > entry.ttl) {
    store.delete(key);
    return null;
  }
  return entry.data;
}

function set(key, data, ttl) {
  store.set(key, { data, timestamp: Date.now(), ttl });
}

function clear() {
  store.clear();
}

module.exports = { get, set, clear };
