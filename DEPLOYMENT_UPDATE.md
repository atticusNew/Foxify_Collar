# Deployment Update - kalshi_demo_v2

**Date:** January 2025  
**Status:** Ready for GitHub push and Render deployment

## Changes Made

### 1. Updated `render.yaml`
**File:** `render.yaml` (root directory)

**Changes:**
- Updated `buildCommand`: Changed from `kalshi_demo/requirements.txt` → `kalshi_demo_v2/requirements.txt`
- Updated `buildCommand`: Changed from `cd kalshi_demo/frontend` → `cd kalshi_demo_v2/frontend`
- Updated `startCommand`: Changed from `cd kalshi_demo` → `cd kalshi_demo_v2`
- Updated `PYTHONPATH`: Changed from `/opt/render/project/src/kalshi_demo` → `/opt/render/project/src/kalshi_demo_v2`
- Updated `KALSHI_DEMO_FRONTEND_ROOT`: Changed from `/opt/render/project/src/kalshi_demo/frontend/dist` → `/opt/render/project/src/kalshi_demo_v2/frontend/dist`

**Service Name:** `kalshi-demo` (unchanged - keeps same domains)

### 2. Added Static File Serving
**File:** `kalshi_demo_v2/api/main.py`

**Changes:**
- Added static file serving for frontend assets
- Serves `/assets/*` from `frontend/dist/assets/`
- Serves `index.html` for root route and SPA routing
- Uses `KALSHI_DEMO_FRONTEND_ROOT` environment variable (set in render.yaml)

### 3. Updated Root Route
**File:** `kalshi_demo_v2/api/main.py`

**Changes:**
- Root route (`/`) now serves frontend `index.html` if frontend exists
- Added `/api` endpoint for API-only access
- Fallback to JSON response if frontend not found

## Deployment Steps

1. **Commit changes:**
   ```bash
   git add render.yaml kalshi_demo_v2/
   git commit -m "Update deployment to use kalshi_demo_v2"
   git push origin main
   ```

2. **Render will auto-deploy** (if auto-deploy is enabled)

3. **Verify deployment:**
   - Check Render build logs
   - Test `https://kalshi-demo.atticustrade.com`
   - Test `https://kalshi.atticustrade.com`
   - Verify frontend loads correctly
   - Test hedge quote endpoints

## Environment Variables (Render Dashboard)

These should already be set, but verify:
- `KALSHI_API_KEY` (if needed)
- `KALSHI_PRIVATE_KEY_PATH` (if needed)
- `KALSHI_DEMO_FRONTEND_ROOT` (set in render.yaml, but can override)

## Rollback Plan

If issues occur, revert `render.yaml` changes:
```yaml
buildCommand: pip install -r kalshi_demo/requirements.txt && cd kalshi_demo/frontend && npm ci && npm run build
startCommand: cd kalshi_demo && PYTHONPATH=/opt/render/project/src/kalshi_demo python3 -m uvicorn api.main:app --host 0.0.0.0 --port $PORT
PYTHONPATH: /opt/render/project/src/kalshi_demo
KALSHI_DEMO_FRONTEND_ROOT: /opt/render/project/src/kalshi_demo/frontend/dist
```

## Notes

- Old `kalshi_demo/` folder remains in repo but won't be deployed
- Service name `kalshi-demo` unchanged (domains remain the same)
- All environment variables remain the same
- Frontend is built during deployment and served by backend

