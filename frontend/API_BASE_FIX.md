# API_BASE Fix Instructions

## Issue
Frontend is making relative requests (`top-volume?limit=10`) instead of absolute requests (`http://localhost:8000/events/btc/top-volume`)

## Root Cause
`import.meta.env.PROD` wasn't evaluating correctly, causing `API_BASE` to be empty string

## Fix Applied
Changed from `import.meta.env.PROD` to `import.meta.env.MODE === 'production'`

## Steps to Fix in Browser

### Option 1: Hard Refresh (Recommended)
1. Open browser DevTools (F12)
2. Right-click the refresh button
3. Select "Empty Cache and Hard Reload"
   - OR use keyboard shortcut:
   - Mac: `Cmd + Shift + R`
   - Windows/Linux: `Ctrl + Shift + F5`

### Option 2: Clear Browser Cache
1. Open DevTools (F12)
2. Go to Application tab (Chrome) or Storage tab (Firefox)
3. Click "Clear storage" or "Clear site data"
4. Check all boxes
5. Click "Clear site data"
6. Refresh page

### Option 3: Restart Dev Server
```bash
# Stop current dev server (Ctrl+C)
cd kalshi_demo_v2/frontend
npm run dev
```

Then hard refresh browser

## Verification

After fix, check Network tab:
- ✅ Should see: `http://localhost:8000/events/btc/top-volume?limit=10`
- ❌ Should NOT see: `top-volume?limit=10` (relative URL)

## If Still Not Working

1. Check browser console for `API_BASE` value:
   ```javascript
   console.log('API_BASE:', import.meta.env.VITE_API_URL || (import.meta.env.MODE === 'production' ? '' : 'http://localhost:8000'))
   ```

2. Verify backend is running:
   ```bash
   curl http://localhost:8000/events/btc/top-volume?limit=10
   ```

3. Check CORS headers (backend should allow localhost:3000)

