# How to View Console Logs in Browser

## Steps to See Debug Logs

### 1. Open Browser Developer Tools
- **Chrome/Edge**: Press `F12` or `Ctrl+Shift+I` (Windows/Linux) or `Cmd+Option+I` (Mac)
- **Firefox**: Press `F12` or `Ctrl+Shift+I` (Windows/Linux) or `Cmd+Option+I` (Mac)
- **Safari**: Enable Developer menu first: Preferences → Advanced → "Show Develop menu", then `Cmd+Option+I`

### 2. Go to Console Tab
- Click on the **"Console"** tab in the developer tools

### 3. Clear Console and Set Filter
- Click the **clear button** (🚫) or press `Ctrl+L` / `Cmd+K` to clear
- Make sure filter shows **"All levels"** or **"Verbose"** (not just "Errors")
- Look for the filter dropdown and select "All levels" or uncheck "Hide network"

### 4. Trigger the Logs
The logs will appear when you:
1. **Open the Hedge Modal**: Click "Hedge" button on any event
   - You should see: `🔵 MODAL OPENED - Fetching preview counts for: [ticker]`
   
2. **Select Yes or No**: Click either "Yes" or "No" button
   - You should see: `🔵 FETCHING HEDGE OPTIONS: { eventTicker, selectedPosition, url }`
   - Then: `🟢 HEDGE QUOTE RESPONSE: { status, candidates_count, ... }`
   - Then: `✅ PROCESSED HEDGE OPTIONS: [...]` (if options found)

### 5. Check Network Tab (Alternative)
If console logs aren't showing, check the **Network** tab:
1. Go to **Network** tab in developer tools
2. Clear it (🚫 button)
3. Click "Hedge" → Select "Yes" or "No"
4. Look for request to `/kalshi/hedge-quote`
5. Click on it → Go to **"Response"** tab to see what backend returned

## What to Look For

### When Modal Opens:
```
🔵 MODAL OPENED - Fetching preview counts for: KXBTCMAXY-25
```

### When You Click Yes/No:
```
🔵 FETCHING HEDGE OPTIONS: {
  eventTicker: "KXBTCMAXY-25",
  selectedPosition: "yes",
  url: "http://localhost:8000/kalshi/hedge-quote?event_id=KXBTCMAXY-25&direction=yes&stake=100"
}
```

### Response Received:
```
🟢 HEDGE QUOTE RESPONSE: {
  status: "available" or "hedge_unavailable",
  candidates_count: 0 or 3,
  candidates: [...],
  rejection_reasons: {...}
}
```

### If Options Found:
```
✅ PROCESSED HEDGE OPTIONS: [
  { tier: "Light protection", premium_usd: 10, ... },
  { tier: "Standard protection", premium_usd: 20, ... },
  { tier: "Max protection", premium_usd: 30, ... }
]
✅ OPTIONS COUNT: 3
```

## Troubleshooting

### If you don't see any logs:
1. **Check console filter**: Make sure it's set to "All levels" not just "Errors"
2. **Clear console**: Press `Ctrl+L` or `Cmd+K`
3. **Refresh page**: Hard refresh with `Ctrl+Shift+R` or `Cmd+Shift+R`
4. **Check if modal opened**: The logs only appear when you interact with the hedge modal

### If you see errors:
- Look for red error messages
- Check Network tab for failed requests (status 404, 500, etc.)
- Check if backend is running on `http://localhost:8000`

### If logs show but options don't appear:
- Check `candidates_count` - if it's 0, backend isn't finding options
- Check `status` - if it's "hedge_unavailable", backend rejected the request
- Check `rejection_reasons` - this will tell you why options weren't found

