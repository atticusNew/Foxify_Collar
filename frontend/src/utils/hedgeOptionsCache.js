// Module-level cache for hedge options by eventTicker
// Persists across modal opens/closes

const hedgeOptionsCache = {};

export const getCachedOptions = (eventTicker) => {
  return hedgeOptionsCache[eventTicker] || null;
};

export const setCachedOptions = (eventTicker, options) => {
  hedgeOptionsCache[eventTicker] = options;
};

export const clearCache = () => {
  Object.keys(hedgeOptionsCache).forEach(key => delete hedgeOptionsCache[key]);
};

