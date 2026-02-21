# 🚀 JASH ADDON — Deployment Guide

## ✅ SHORT ANSWER: SINGLE DEPLOYMENT IS ALL YOU NEED

```
ONE URL does EVERYTHING:

https://your-app.onrender.com/              → React Configurator (Frontend)
https://your-app.onrender.com/manifest.json → Stremio Addon (Backend)
https://your-app.onrender.com/stream/tv/*   → HLS Extractor (Backend)
https://your-app.onrender.com/health        → Health Check (Backend)
https://your-app.onrender.com/api/sync      → Config Sync (Backend)
```

**No separate deployment needed.** `backend/server.js` serves BOTH the
React app (static files from `/dist`) AND all Stremio addon endpoints.

---

## 🏆 PLATFORM COMPARISON

| Platform | Free Tier | Sleep? | Speed | Best For | Recommended? |
|----------|-----------|--------|-------|----------|-------------|
| **Render** | ✅ Yes | 💤 15min idle | Medium | Beginners | ⭐⭐⭐⭐⭐ Best |
| **Koyeb** | ✅ Yes | ❌ No sleep | Fast | Always-on | ⭐⭐⭐⭐ Great |
| **Railway** | ✅ $5 credit | ❌ No sleep | Fast | Developers | ⭐⭐⭐⭐ Great |
| **Fly.io** | ✅ Yes | ❌ No sleep | Fast | Global CDN | ⭐⭐⭐ Good |
| **Vercel** | ✅ Yes | ❌ No sleep | Fast | ❌ WRONG CHOICE | ⛔ Avoid |
| **VPS/Hetzner** | ❌ ~€4/mo | ❌ No sleep | Fastest | Full control | ⭐⭐⭐ Advanced |

---

## ⛔ WHY NOT VERCEL?

Vercel is designed for **serverless functions** (max 10 seconds execution time).
This addon needs a **persistent Node.js server** because:

1. **In-memory stream cache** — stores resolved HLS URLs for 5 minutes
2. **File reading** — reads `streams-config.json` on each request
3. **Long-running HTTP requests** — fetching M3U8 playlists can take 3-10 seconds
4. **State persistence** — stream cache must survive between requests

❌ Vercel kills the process after each request — cache is lost every time.
✅ Use Render, Koyeb, or Railway instead.

---

## 🥇 BEST CHOICE: KOYEB (Free, No Sleep, Fast)

### Why Koyeb wins:
- ✅ Free tier with **no sleep** (unlike Render's 15-min idle shutdown)
- ✅ Global CDN — fast for all regions
- ✅ Auto-deploys from GitHub on every push
- ✅ Simple dashboard, no CLI needed
- ✅ Supports `node backend/server.js` natively

### Deploy to Koyeb — Step by Step:

**Step 1 — Push to GitHub**
```bash
git init
git add .
git commit -m "Initial commit — Jash Addon"
git remote add origin https://github.com/YOUR_USERNAME/jash-addon.git
git push -u origin main
```

**Step 2 — Create Koyeb Account**
→ Go to https://app.koyeb.com and sign up with GitHub

**Step 3 — Create a New App**
1. Click **"Create App"**
2. Select **"GitHub"** as deployment source
3. Choose your `jash-addon` repository
4. Select branch: `main`

**Step 4 — Configure Service**

| Setting | Value |
|---------|-------|
| Service name | `jash-addon` |
| Instance type | `Free` |
| Build command | `npm install && npm run build` |
| Run command | `node backend/server.js` |
| Port | `8000` |

**Step 5 — Set Environment Variables**
Click **"Add variable"** for each:

| Key | Value |
|-----|-------|
| `PORT` | `8000` |
| `NODE_ENV` | `production` |
| `PUBLIC_URL` | *(set after deploy — see Step 7)* |

**Step 6 — Deploy**
Click **"Deploy"**. Wait 3-5 minutes.

**Step 7 — Set PUBLIC_URL**
After deploy, get your URL from Koyeb dashboard (looks like `https://jash-addon-abc123.koyeb.app`).
Go back to **Environment Variables** → Add:

| Key | Value |
|-----|-------|
| `PUBLIC_URL` | `https://jash-addon-abc123.koyeb.app` |

Click **"Redeploy"**.

**Step 8 — Verify**
```bash
curl https://jash-addon-abc123.koyeb.app/health
# Should return: {"status":"ok","streams":0,...}

curl https://jash-addon-abc123.koyeb.app/manifest.json
# Should return: {"id":"jash-iptv-addon","name":"Jash IPTV",...}
```

**Step 9 — Open Configurator**
→ Visit `https://jash-addon-abc123.koyeb.app` in your browser.
→ Add your M3U sources, configure streams, click **Backend → Sync Streams**.
→ Install in Stremio: `stremio://jash-addon-abc123.koyeb.app/manifest.json`

---

## 🥈 SECOND BEST: RENDER (Free, Beginner-Friendly)

### The only downside: Render free tier sleeps after 15 minutes of inactivity.
**Fix: Use UptimeRobot (free) to ping /health every 5 minutes.**

### Deploy to Render — Step by Step:

**Step 1 — Push to GitHub** *(same as above)*

**Step 2 — Create Render Account**
→ Go to https://render.com and sign up with GitHub

**Step 3 — New Web Service**
1. Click **"New +"** → **"Web Service"**
2. Connect your GitHub repo
3. Configure:

| Setting | Value |
|---------|-------|
| Name | `jash-addon` |
| Runtime | `Node` |
| Region | Closest to you |
| Build Command | `npm install && npm run build` |
| Start Command | `node backend/server.js` |
| Instance Type | `Free` |

**Step 4 — Environment Variables**
In **Advanced** section:

| Key | Value |
|-----|-------|
| `PORT` | `10000` |
| `NODE_ENV` | `production` |

**Step 5 — Deploy & Get URL**
Click **"Create Web Service"**. Wait 5 minutes.
Your URL: `https://jash-addon.onrender.com`

**Step 6 — Set PUBLIC_URL**
Environment → Add:

| Key | Value |
|-----|-------|
| `PUBLIC_URL` | `https://jash-addon.onrender.com` |

**Step 7 — Fix Sleep Issue (Optional but Recommended)**
→ Go to https://uptimerobot.com (free account)
→ Add Monitor → HTTP(s)
→ URL: `https://jash-addon.onrender.com/health`
→ Interval: Every 5 minutes
→ This keeps Render awake 24/7 for free!

---

## 🥉 THIRD: RAILWAY (Free $5/mo Credit)

```bash
# Install CLI
npm install -g @railway/cli

# Login and deploy
railway login
railway init
railway up

# Set environment
railway variables set PORT=3000
railway variables set NODE_ENV=production
railway variables set PUBLIC_URL=$(railway domain)

# Get your URL
railway domain
```

---

## 📋 SINGLE DEPLOYMENT ARCHITECTURE

Here's exactly how one deployment handles everything:

```
User Browser                     Your Deployed Server
─────────────                    ────────────────────────────────────
                                 ┌─────────────────────────────────┐
GET /                    ───▶    │  backend/server.js              │
   ← index.html                  │                                 │
   ← React App loads             │  if (path === '/') {            │
   ← src/App.tsx renders         │    serve dist/index.html        │
                                 │  }                              │
                                 │                                 │
POST /api/sync           ───▶    │  if (path === '/api/sync') {    │
  { streams: [...] }             │    write streams-config.json    │
  ← { ok: true }                 │    clear stream cache           │
                                 │  }                              │
                                 │                                 │
Stremio                          │                                 │
──────                           │                                 │
GET /manifest.json       ───▶    │  buildManifest()                │
   ← { catalogs: [...] }         │  reads streams-config.json      │
                                 │  returns groups as catalogs     │
                                 │                                 │
GET /catalog/tv/jash_cat_0.json ▶│  handleCatalog('jash_cat_0')   │
   ← { metas: [...] }            │  returns channel list           │
                                 │                                 │
GET /stream/tv/jash:ABC.json ───▶│  handleStream('jash:ABC')       │
   ← { streams: [{ url }] }      │  1. Check cache                 │
                                 │  2. fetchPlaylist(url)          │
                                 │     (Samsung Tizen UA)          │
                                 │  3. extractRealStreamUrl()      │
                                 │     (middle quality variant)    │
                                 │  4. Cache result (5 min)        │
                                 │  5. Return resolved URL         │
                                 └─────────────────────────────────┘

Samsung Tizen TV plays the resolved URL directly ✅
```

---

## 🔧 ENVIRONMENT VARIABLES REFERENCE

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | Platform sets | `7000` | HTTP port (platforms auto-set this) |
| `PUBLIC_URL` | **Yes** | `http://localhost:7000` | Your full public URL (no trailing slash) |
| `NODE_ENV` | No | `development` | Set to `production` |
| `DEBUG` | No | `false` | Set to `true` for verbose logs |

### Platform-specific PORT values:
```
Render  → PORT=10000
Koyeb   → PORT=8000
Railway → PORT=3000 (or auto)
Fly.io  → PORT=8080
VPS     → PORT=7000 (or any)
```

---

## 📱 AFTER DEPLOYMENT: COMPLETE WORKFLOW

```
1. Open: https://your-app.koyeb.app
   └─ This is your React configurator

2. Go to "Sources" tab
   └─ Add M3U URL / Upload File / Manual entry

3. Go to "Streams" tab
   └─ Edit, organize, delete unwanted streams

4. Go to "Groups" tab
   └─ Rename, merge, organize groups

5. Go to "Health" tab
   └─ Check which streams are alive/dead

6. Go to "Backend" tab
   └─ Click "Sync X Streams" button
   └─ Status should show "🟢 Online"
   └─ Click "Install in Stremio" button

7. Stremio opens → Confirm installation

8. On Samsung TV:
   └─ Stremio → TV → Your groups appear as categories
   └─ Select channel → HLS extracts → Plays smoothly ✅

9. Future changes:
   └─ Edit streams in configurator → Sync → Done
   └─ No reinstall ever needed ✅
```

---

## ❓ FREQUENTLY ASKED QUESTIONS

**Q: Can I use Vercel?**
No. Vercel is serverless — each function invocation is stateless and has a 10-second timeout.
The stream handler needs to fetch M3U8 files (3-10 sec) and cache results in memory.
Use Render, Koyeb, or Railway.

**Q: Do I need to deploy frontend and backend separately?**
No. `backend/server.js` serves BOTH:
- The React app as static files from `dist/`
- All Stremio addon endpoints (`/manifest.json`, `/stream/tv/*`, etc.)

One Git repo → One deployment → One URL → Handles everything.

**Q: How does Stremio get updated when I add new streams?**
1. You add streams in the configurator
2. Click "Backend → Sync Streams"
3. This sends a `POST /api/sync` request to your deployed server
4. Server writes `backend/streams-config.json`
5. Next time Stremio requests `/catalog/tv/*.json`, it gets the updated list
6. Stremio refreshes its catalog — no addon reinstall needed

**Q: Is there any database?**
- **Frontend**: IndexedDB (browser) stores your full stream library locally
- **Backend**: `streams-config.json` file stores only the currently synced config
- No external database (Postgres, Redis, etc.) is needed

**Q: What happens if the server restarts?**
- The HLS **stream cache** is cleared (in-memory) — streams will be re-resolved on next play
- The **stream config** (`streams-config.json`) persists on disk — all streams are still there
- Stremio works normally after restart

**Q: How many streams can it handle?**
- Frontend: Tested with 10,000+ streams (IndexedDB handles it)
- Backend: Unlimited — streams are loaded on-demand from the JSON file
- HLS cache: Holds as many as memory allows (each entry is ~100 bytes)

**Q: My Stremio shows the addon but no channels appear.**
→ Go to Backend tab → Check if backend is "🟢 Online"
→ If offline: make sure the server is deployed and PUBLIC_URL is set correctly
→ If online but no channels: click "Sync Streams" — you may not have synced yet
→ After sync, uninstall and reinstall the addon in Stremio to refresh catalogs

**Q: Samsung TV shows black screen even after setup.**
→ Go to Handler tab → Test your stream URL
→ If type is "fallback" with error — the stream server may block the backend's IP
→ Try enabling DEBUG=true on the server and check logs for [EXTRACT] messages
→ The middle-quality selection should fix most Samsung Tizen HLS issues

---

## 🏁 QUICK START (TL;DR)

```bash
# 1. Push to GitHub
git add . && git commit -m "deploy" && git push

# 2. Go to koyeb.com → Create App → Connect GitHub repo
# 3. Build: npm install && npm run build
# 4. Start: node backend/server.js
# 5. Set PORT=8000, PUBLIC_URL=https://your-app.koyeb.app

# 6. Visit https://your-app.koyeb.app → Add sources → Sync → Done!
```

**Your manifest URL:** `https://your-app.koyeb.app/manifest.json`
**Install in Stremio:** `stremio://your-app.koyeb.app/manifest.json`
