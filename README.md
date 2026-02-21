# 📡 JASH ADDON — Stremio IPTV Configurator

> **Samsung Tizen OS Optimized · HLS Segment Extraction · Multi-Source IPTV Manager**

A complete, production-ready Stremio IPTV addon with a web-based configurator. Manage thousands of streams, organize groups, run health checks, and deploy to the cloud — all from one interface. Built specifically to fix HLS playback issues on Samsung Tizen OS.

---

## 📋 Table of Contents

1. [What Is This?](#what-is-this)
2. [How It Works](#how-it-works)
3. [Features](#features)
4. [Prerequisites](#prerequisites)
5. [Local Development Setup](#local-development-setup)
6. [Build for Production](#build-for-production)
7. [Deploy to Render.com](#deploy-to-rendercom) ⭐ Recommended
8. [Deploy to Koyeb.com](#deploy-to-koyebcom)
9. [Deploy to Railway.app](#deploy-to-railwayapp)
10. [Deploy to Fly.io](#deploy-to-flyio)
11. [Self-Host on VPS / Ubuntu](#self-host-on-vps--ubuntu)
12. [Install Addon in Stremio](#install-addon-in-stremio)
13. [Install on Samsung Tizen TV](#install-on-samsung-tizen-tv)
14. [Using the Configurator](#using-the-configurator)
15. [HLS Extraction Explained](#hls-extraction-explained)
16. [Environment Variables](#environment-variables)
17. [API Reference](#api-reference)
18. [Troubleshooting](#troubleshooting)
19. [FAQ](#faq)

---

## What Is This?

**Jash Addon** is two things in one deployment:

| Component | What it does |
|-----------|-------------|
| **React Configurator** (frontend) | Web UI to add M3U sources, edit streams, organize groups, run health checks, download M3U files |
| **Stremio Addon Server** (backend) | Node.js HTTP server that serves your streams to Stremio with real-time HLS extraction |

**One deployment URL gives you:**
- `https://your-app.com/` → Configurator web UI
- `https://your-app.com/manifest.json` → Stremio addon manifest
- `https://your-app.com/stream/tv/:id.json` → HLS-extracted stream URLs

---

## How It Works

```
┌─────────────────────────────────────────────────────────────┐
│                     YOUR DEPLOYED SERVER                     │
│                  (Render / Koyeb / Railway)                  │
├──────────────────────┬──────────────────────────────────────┤
│   React Frontend     │        Node.js Backend               │
│   (Configurator)     │        (Stremio Addon)               │
│                      │                                      │
│  Add M3U Sources ────┼──► POST /api/sync                    │
│  Edit Streams        │         │                            │
│  Organize Groups     │         ▼                            │
│  Health Check        │   streams-config.json                │
│  Download M3U        │         │                            │
│                      │         ▼                            │
│                      │   GET /manifest.json ◄── Stremio     │
│                      │   GET /catalog/tv/*  ◄── Stremio     │
│                      │   GET /stream/tv/*   ◄── Stremio     │
│                      │         │                            │
│                      │    extractRealStreamUrl()            │
│                      │    (Samsung Tizen fix)               │
│                      │         │                            │
│                      │         ▼                            │
│                      │   Resolved HLS URL ──► Samsung TV   │
└──────────────────────┴──────────────────────────────────────┘
```

**Samsung HLS Fix:**
Samsung Stremio cannot handle HLS master playlists directly. The backend fetches the M3U8 playlist, selects the **middle-quality variant** (stability sweet spot for Samsung TVs), and returns the resolved segment URL — bypassing the HLS issue entirely.

---

## Features

| Feature | Description |
|---------|-------------|
| 🌐 Multi-Source | Add unlimited M3U sources via URL, file upload, or manual entry |
| 📺 Stream Editor | Edit name, logo, group; bulk delete, enable/disable |
| 📂 Group Manager | Create, rename, merge custom groups |
| ❤️ Health Checker | Test stream availability with live progress |
| ⬇️ M3U Export | Download full playlist or per-group M3U files |
| 🧩 HLS Extractor | Resolve master→variant→segment URLs in-browser |
| 🖥️ Backend Sync | Push config to server with one click or auto-sync |
| 📡 Stremio Addon | Real addon endpoints with CORS, catalog, meta, stream |
| 📺 Samsung Tizen | Middle-quality HLS variant selection for Samsung stability |
| 💾 IndexedDB | All data stored locally — survives page refreshes |

---

## Prerequisites

Before you start, make sure you have:

- **Node.js** v18 or higher — [Download](https://nodejs.org)
- **npm** v8 or higher (comes with Node.js)
- **Git** — [Download](https://git-scm.com)
- A **GitHub account** (for cloud deployment)
- A cloud platform account (Render / Koyeb / Railway — all have free tiers)

Check your versions:
```bash
node --version    # Should be v18+
npm --version     # Should be v8+
git --version
```

---

## Local Development Setup

### Step 1 — Clone the repository

```bash
git clone https://github.com/YOUR_USERNAME/jash-addon.git
cd jash-addon
```

### Step 2 — Install dependencies

```bash
npm install
```

### Step 3 — Start the React dev server (frontend only)

```bash
npm run dev
```

Open `http://localhost:5173` in your browser.

> ⚠️ In dev mode, only the React configurator runs. The Stremio addon backend is NOT active. To test the full addon, do a production build first (see below).

### Step 4 — Run the backend server (in a separate terminal)

```bash
# First build the frontend
npm run build

# Then start the backend (serves both the app AND the addon endpoints)
node backend/server.js
```

Open `http://localhost:7000` — you'll see the configurator.
Open `http://localhost:7000/manifest.json` — you'll see the addon manifest.

### Step 5 — Test addon locally in Stremio

1. Make sure `node backend/server.js` is running
2. Open Stremio on your computer
3. Go to **Settings → Addons**
4. Click **Install from URL**
5. Paste: `http://localhost:7000/manifest.json`
6. Click **Install**

---

## Build for Production

```bash
# Install dependencies
npm install

# Build the React app (outputs to /dist)
npm run build

# Start the production server
node backend/server.js
```

The backend serves:
- `GET /` → React configurator (`dist/index.html`)
- `GET /manifest.json` → Stremio addon manifest
- `GET /stream/tv/:id.json` → HLS-extracted stream URLs
- `POST /api/sync` → Receive config from frontend

---

## Deploy to Render.com

⭐ **Recommended for beginners** — Free tier available, no credit card required.

### Step 1 — Push your code to GitHub

```bash
# Initialize git (if not already done)
git init
git add .
git commit -m "Initial commit"

# Create a new repo on GitHub, then:
git remote add origin https://github.com/YOUR_USERNAME/jash-addon.git
git push -u origin main
```

### Step 2 — Create a Render account

Go to [render.com](https://render.com) and sign up with your GitHub account.

### Step 3 — Create a new Web Service

1. Click **"New +"** in the top-right corner
2. Select **"Web Service"**
3. Choose **"Connect a repository"**
4. Select your `jash-addon` repository
5. Click **"Connect"**

### Step 4 — Configure the service

Fill in these exact settings:

| Field | Value |
|-------|-------|
| **Name** | `jash-addon` (or any name you want) |
| **Region** | Choose closest to you |
| **Branch** | `main` |
| **Root Directory** | *(leave empty)* |
| **Runtime** | `Node` |
| **Build Command** | `npm install && npm run build` |
| **Start Command** | `node backend/server.js` |
| **Instance Type** | `Free` |

### Step 5 — Set environment variables

In the **"Advanced"** section, add:

| Key | Value |
|-----|-------|
| `PORT` | `10000` |
| `NODE_ENV` | `production` |

> ℹ️ `PUBLIC_URL` will be set automatically by Render after deploy. You can update it after you get your URL.

### Step 6 — Deploy

Click **"Create Web Service"**. Render will:
1. Clone your repo
2. Run `npm install && npm run build`
3. Start `node backend/server.js`

Wait 3–5 minutes. You'll see logs in the dashboard.

### Step 7 — Get your URL and set PUBLIC_URL

Once deployed, Render gives you a URL like:
```
https://jash-addon.onrender.com
```

Go back to your service → **Environment** → Add:

| Key | Value |
|-----|-------|
| `PUBLIC_URL` | `https://jash-addon.onrender.com` |

Click **"Save Changes"** — Render will redeploy automatically.

### Step 8 — Verify deployment

```bash
# Check health
curl https://jash-addon.onrender.com/health

# Check manifest
curl https://jash-addon.onrender.com/manifest.json
```

You should see JSON responses. ✅

### Step 9 — Open the configurator

Visit `https://jash-addon.onrender.com` in your browser. The configurator is live!

### Render Troubleshooting

```bash
# If build fails — check logs in Render dashboard
# Common issues:

# 1. Node version mismatch — add to package.json engines:
#    "engines": { "node": ">=18.0.0" }

# 2. Port issue — Render uses PORT env var automatically
#    Our server already reads process.env.PORT ✅

# 3. Build timeout — free tier builds can be slow, wait 10 mins
```

---

## Deploy to Koyeb.com

Koyeb offers a generous free tier with fast global CDN.

### Step 1 — Push code to GitHub

*(Same as Render Step 1 above)*

### Step 2 — Create Koyeb account

Go to [koyeb.com](https://koyeb.com) and sign up.

### Step 3 — Create a new App

1. Click **"Create App"**
2. Select **"GitHub"** as source
3. Connect your GitHub account
4. Select your `jash-addon` repository

### Step 4 — Configure the deployment

| Field | Value |
|-------|-------|
| **App name** | `jash-addon` |
| **Service name** | `web` |
| **Branch** | `main` |
| **Build command** | `npm install && npm run build` |
| **Run command** | `node backend/server.js` |
| **Port** | `8000` |

### Step 5 — Set environment variables

Click **"Add variable"** for each:

| Key | Value |
|-----|-------|
| `PORT` | `8000` |
| `NODE_ENV` | `production` |
| `PUBLIC_URL` | `https://jash-addon-YOUR_APP.koyeb.app` |

> ℹ️ You'll get the exact URL after first deploy. Update `PUBLIC_URL` and redeploy.

### Step 6 — Deploy

Click **"Deploy"**. Koyeb builds and deploys automatically.

### Step 7 — Get your URL

After deploy, find your URL in the Koyeb dashboard under **Domains**. It looks like:
```
https://jash-addon-yourname.koyeb.app
```

### Step 8 — Verify

```bash
curl https://jash-addon-yourname.koyeb.app/health
curl https://jash-addon-yourname.koyeb.app/manifest.json
```

---

## Deploy to Railway.app

Railway is developer-friendly with a simple CLI.

### Step 1 — Install Railway CLI

```bash
npm install -g @railway/cli
```

### Step 2 — Login to Railway

```bash
railway login
```

This opens your browser for GitHub OAuth.

### Step 3 — Initialize Railway project

```bash
# In your project directory
railway init
```

Select **"Create new project"** when prompted.

### Step 4 — Set the start command

Create a `railway.toml` file in your project root:

```toml
[build]
builder = "NIXPACKS"
buildCommand = "npm install && npm run build"

[deploy]
startCommand = "node backend/server.js"
healthcheckPath = "/health"
restartPolicyType = "ON_FAILURE"
```

### Step 5 — Set environment variables

```bash
railway variables set PORT=3000
railway variables set NODE_ENV=production
```

### Step 6 — Deploy

```bash
railway up
```

Railway will build and deploy. Watch the logs:

```bash
railway logs
```

### Step 7 — Get your public URL

```bash
railway domain
```

Or go to the Railway dashboard → your project → **Settings** → **Domains**.

### Step 8 — Set PUBLIC_URL

```bash
railway variables set PUBLIC_URL=https://jash-addon.up.railway.app
```

Then redeploy:

```bash
railway up
```

### Step 9 — Verify

```bash
curl https://jash-addon.up.railway.app/health
```

---

## Deploy to Fly.io

Fly.io offers fast global deployment with a free tier.

### Step 1 — Install Fly CLI

```bash
# macOS
brew install flyctl

# Linux
curl -L https://fly.io/install.sh | sh

# Windows
pwsh -Command "iwr https://fly.io/install.ps1 -useb | iex"
```

### Step 2 — Login

```bash
fly auth login
```

### Step 3 — Create `fly.toml`

Create this file in your project root:

```toml
app = "jash-addon"
primary_region = "iad"

[build]
  [build.args]
    NODE_VERSION = "18"

[env]
  PORT = "8080"
  NODE_ENV = "production"

[[services]]
  http_checks = []
  internal_port = 8080
  protocol = "tcp"

  [[services.ports]]
    handlers = ["http"]
    port = 80

  [[services.ports]]
    handlers = ["tls", "http"]
    port = 443

  [[services.http_checks]]
    interval = "10s"
    grace_period = "5s"
    method = "get"
    path = "/health"
    protocol = "http"
    timeout = "2s"
```

### Step 4 — Create a `Dockerfile`

```dockerfile
FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build

EXPOSE 8080

CMD ["node", "backend/server.js"]
```

### Step 5 — Launch

```bash
fly launch --name jash-addon
```

When asked about Postgres/Redis, say **No**.

### Step 6 — Set PUBLIC_URL

```bash
fly secrets set PUBLIC_URL=https://jash-addon.fly.dev
```

### Step 7 — Deploy

```bash
fly deploy
```

### Step 8 — Verify

```bash
fly status
curl https://jash-addon.fly.dev/health
```

---

## Self-Host on VPS / Ubuntu

For a DigitalOcean Droplet, Hetzner, Linode, or any Ubuntu VPS.

### Step 1 — Set up your server

```bash
# Connect to your VPS
ssh root@YOUR_SERVER_IP

# Update system
apt update && apt upgrade -y

# Install Node.js 18
curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
apt install -y nodejs

# Install git
apt install -y git

# Install PM2 (process manager)
npm install -g pm2
```

### Step 2 — Clone and build

```bash
# Clone your repo
git clone https://github.com/YOUR_USERNAME/jash-addon.git
cd jash-addon

# Install dependencies and build
npm install
npm run build
```

### Step 3 — Set environment variables

```bash
# Create environment file
cat > .env << EOF
PORT=7000
PUBLIC_URL=https://your-domain.com
NODE_ENV=production
DEBUG=false
EOF
```

### Step 4 — Start with PM2

```bash
# Start the server
PORT=7000 PUBLIC_URL=https://your-domain.com pm2 start backend/server.js --name jash-addon

# Save PM2 config (survives reboots)
pm2 save
pm2 startup
```

### Step 5 — Set up Nginx reverse proxy (recommended)

```bash
# Install Nginx
apt install -y nginx

# Create config
cat > /etc/nginx/sites-available/jash-addon << 'EOF'
server {
    listen 80;
    server_name your-domain.com www.your-domain.com;

    location / {
        proxy_pass http://localhost:7000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        
        # CORS headers (required for Stremio)
        add_header Access-Control-Allow-Origin *;
        add_header Access-Control-Allow-Methods 'GET, POST, OPTIONS';
        add_header Access-Control-Allow-Headers 'Content-Type, Authorization';
    }
}
EOF

# Enable site
ln -s /etc/nginx/sites-available/jash-addon /etc/nginx/sites-enabled/
nginx -t
systemctl restart nginx
```

### Step 6 — Set up SSL with Let's Encrypt

```bash
# Install Certbot
apt install -y certbot python3-certbot-nginx

# Get SSL certificate
certbot --nginx -d your-domain.com -d www.your-domain.com

# Auto-renew
certbot renew --dry-run
```

### Step 7 — Verify

```bash
curl https://your-domain.com/health
curl https://your-domain.com/manifest.json
```

### Managing the server

```bash
# View logs
pm2 logs jash-addon

# Restart
pm2 restart jash-addon

# Stop
pm2 stop jash-addon

# Update code
cd jash-addon
git pull
npm install
npm run build
pm2 restart jash-addon
```

---

## Install Addon in Stremio

### Method 1 — Direct URL (Easiest)

1. Open **Stremio** on any device (PC, Mac, Android, etc.)
2. Go to **Settings** (gear icon, top right)
3. Click **"Addons"** in the left sidebar
4. Click **"Install from URL"** button
5. Paste your manifest URL:
   ```
   https://your-app.onrender.com/manifest.json
   ```
6. Click **"Install"**
7. Confirm the installation prompt

### Method 2 — Stremio Deep Link

1. Open your browser
2. Go to your configurator: `https://your-app.onrender.com`
3. Click the **"Backend"** tab (🖥️)
4. Click **"Install in Stremio"** button
5. If Stremio is installed, it opens automatically and shows the install prompt

### Method 3 — Samsung TV (Tizen)

See the [Install on Samsung Tizen TV](#install-on-samsung-tizen-tv) section below.

### After Installation

- Your channels appear in Stremio under **"TV"** category
- Each group becomes a separate catalog/category
- Browse → TV → you'll see your groups as separate sections

### Updating Streams (No Reinstall Needed!)

1. Open your configurator URL
2. Add/edit/delete streams as needed
3. Click **Backend → Sync Streams** button
4. Changes appear in Stremio immediately ✅

---

## Install on Samsung Tizen TV

### Step 1 — Install Stremio on Samsung TV

1. Turn on your Samsung TV
2. Press **Home** button on remote
3. Go to **Apps** (bottom of screen)
4. Click the **magnifying glass** (search)
5. Search for **"Stremio"**
6. Click **Install**
7. Wait for installation to complete

> If Stremio is not available in your region's Samsung Store, you may need to enable developer mode or use a different method. See [Stremio TV docs](https://www.stremio.com/tv).

### Step 2 — Log in to Stremio

1. Open Stremio on the TV
2. Either log in with your account or use a QR code to log in from your phone

### Step 3 — Install the Addon

**Option A — From TV:**
1. Press the remote's **Menu** button or navigate to **Settings**
2. Go to **Addons**
3. Select **"Install from URL"**
4. Using the on-screen keyboard, type your manifest URL:
   ```
   https://your-app.onrender.com/manifest.json
   ```
5. Press **OK/Enter**
6. Confirm installation

**Option B — From Browser (easier):**
1. On your phone/PC, open the Stremio app or web
2. Go to Settings → Addons → Install from URL
3. Paste your manifest URL
4. Install — it syncs to your TV automatically (same Stremio account)

### Step 4 — Find Your Channels

1. In Stremio on TV, go to the **Discover** section
2. Select **TV** category
3. Your groups appear as separate categories
4. Use the D-pad remote to navigate
5. Select a channel → it plays!

### Samsung TV Tips

- **Remote Navigation:** Use D-pad (arrow keys) to navigate the grid
- **Back:** Use the back button to go up a level
- **Large buttons:** The configurator UI is designed for TV — buttons are oversized
- **HLS Fix:** The middle-quality variant is automatically selected for Samsung stability
- **Buffering:** If you experience buffering, the backend auto-caches resolved URLs (5 min TTL)

---

## Using the Configurator

Open your configurator URL (`https://your-app.com`) and explore the tabs:

### 📡 Sources Tab

Add your M3U sources:

1. **Add M3U URL** — Paste any M3U playlist URL (GitHub raw, Pastebin, direct links)
   ```
   https://raw.githubusercontent.com/user/repo/main/playlist.m3u
   ```
2. **Upload File** — Upload a local `.m3u` file from your device
3. **Single Stream** — Add one `.m3u8` stream URL directly
4. **Manual Entry** — Type in name, URL, and group manually

After adding, streams are automatically parsed and added to your library.

### 📺 Streams Tab

Manage individual streams:
- **Search** by name or URL
- **Filter** by group, source, or health status
- **Select multiple** streams with checkboxes
- **Bulk delete** unwanted streams
- **Bulk move** to different groups
- **Edit** individual stream (name, URL, logo, group)

### 📂 Groups Tab

Organize your channels:
- Create custom groups
- Rename existing groups
- Delete groups (streams move to "Uncategorized")
- See stream counts and health stats per group

### ❤️ Health Tab

Test stream availability:
- **Check All** — Tests every enabled stream
- **Check Unchecked** — Only tests never-checked streams
- **Remove Dead** — Bulk delete failed streams
- Progress bar shows real-time results

### 📊 Statistics Tab

See your library at a glance:
- Total streams, groups, sources
- Alive/dead stream counts
- Top 10 groups by stream count
- Source breakdown
- **Download M3U** directly from here

### 🧩 Handler Tab

Test and debug HLS extraction:
- **Single URL Test** — Paste any `.m3u8` URL and see the resolved stream URL
- **Batch Resolver** — Resolve all HLS streams in your library
- **Server Code Generator** — Download the standalone Node.js addon server

### ⬇️ Export Tab

Download your playlist:
- Choose specific group or all groups
- Include/exclude disabled streams
- Set custom playlist name and filename
- Generate a blob URL for external players
- Preview the M3U content

### 🖥️ Backend Tab

Connect to your deployed server:
- See live backend status (streams, groups, cache, uptime)
- **Sync Streams** — Push all data to the backend
- **Auto-sync** — Automatically sync on every change
- Copy manifest URL for Stremio installation
- One-click **Install in Stremio** button
- Step-by-step deploy guides for Render, Koyeb, Railway

---

## HLS Extraction Explained

### The Problem

Samsung Stremio (Tizen OS) cannot properly handle **HLS master playlists**. When Stremio receives a `.m3u8` URL that is a master playlist (contains multiple quality variants), the Samsung player often shows a black screen or errors.

### The Solution

The backend's `extractRealStreamUrl()` function runs **server-side** before Stremio gets the URL:

```
Stremio Request
     │
     ▼
/stream/tv/:id.json
     │
     ▼
1. Decode stream ID → get playlist URL
2. Check 5-minute cache
3. Detect: is this HLS? (.m3u8 / /playlist / play.m3u8)
4. Fetch M3U8 with Samsung Tizen User-Agent
5. Parse playlist:
   ├── Master playlist? → find all variants
   │   ├── Sort by BANDWIDTH descending
   │   └── Pick index = Math.floor(variants.length / 2)
   │       ★ MIDDLE quality = Samsung stability sweet spot
   │       (not highest = buffers, not lowest = bad quality)
   └── Media playlist? → find first .ts/.m4s segment URL
6. Make URL absolute (resolve relative paths)
7. Cache result for 5 minutes
8. Return { url: resolvedUrl, behaviorHints: { notWebReady: true } }
     │
     ▼
Stremio plays the direct URL ✅
```

### Why Middle Quality?

- **Highest quality** (e.g. 1080p @ 8Mbps): Samsung TVs often buffer at max bitrate
- **Lowest quality** (e.g. 360p @ 500kbps): Poor viewing experience  
- **Middle quality** (e.g. 720p @ 3Mbps): Stable playback + good quality

This is the same logic that works in your existing Tamil addon.

### Caching

Resolved URLs are cached in memory for **5 minutes**. This means:
- First request: ~1-3 seconds (fetch + parse)
- Subsequent requests: ~0ms (cache hit)
- Cache is cleared on config sync or explicit clear

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | `7000` | HTTP server port. Cloud platforms set this automatically |
| `PUBLIC_URL` | Yes (production) | `http://localhost:7000` | Your full public URL. Used in manifest links and CORS |
| `NODE_ENV` | No | `development` | Set to `production` for deployment |
| `DEBUG` | No | `false` | Set to `true` for verbose request logging |

### Examples by Platform

**Render:**
```
PORT=10000
PUBLIC_URL=https://jash-addon.onrender.com
NODE_ENV=production
```

**Koyeb:**
```
PORT=8000
PUBLIC_URL=https://jash-addon-yourname.koyeb.app
NODE_ENV=production
```

**Railway:**
```
PORT=3000
PUBLIC_URL=https://jash-addon.up.railway.app
NODE_ENV=production
```

**VPS:**
```
PORT=7000
PUBLIC_URL=https://your-domain.com
NODE_ENV=production
DEBUG=false
```

---

## API Reference

All endpoints return JSON with CORS headers (`Access-Control-Allow-Origin: *`).

### Health Check

```http
GET /health
```

Response:
```json
{
  "status": "ok",
  "addon": "Jash IPTV",
  "streams": 1500,
  "groups": 25,
  "cache": 3,
  "uptime": 3600,
  "publicUrl": "https://jash-addon.onrender.com",
  "manifestUrl": "https://jash-addon.onrender.com/manifest.json"
}
```

### Stremio Manifest

```http
GET /manifest.json
```

Returns the addon manifest. Install this URL in Stremio.

### Stream Catalog

```http
GET /catalog/tv/jash_cat_0.json
GET /catalog/tv/jash_cat_0.json?extra=search%3Dcnn
```

Returns channel list for a group. Each group gets a catalog entry.

### Stream Meta

```http
GET /meta/tv/jash:BASE64URL_ENCODED_STREAM_URL.json
```

Returns metadata for a single channel.

### Stream URL (Core Endpoint)

```http
GET /stream/tv/jash:BASE64URL_ENCODED_STREAM_URL.json
```

Returns the resolved, playable stream URL after HLS extraction.

Response:
```json
{
  "streams": [
    {
      "url": "https://resolved-segment-url.com/segment.ts",
      "title": "🔴 Channel Name",
      "name": "Jash IPTV",
      "behaviorHints": {
        "notWebReady": true
      }
    }
  ]
}
```

### Sync Configuration

```http
POST /api/sync
Content-Type: application/json

{
  "streams": [...],
  "groups": [...],
  "sources": [...],
  "settings": {...}
}
```

Called by the configurator frontend. Writes `backend/streams-config.json`.

### Clear Cache

```http
DELETE /api/cache
```

Clears the in-memory HLS resolution cache.

### Get Current Config

```http
GET /api/config
```

Returns the current loaded configuration.

---

## Troubleshooting

### ❌ Backend Offline (red dot in configurator)

**Cause:** Backend server is not running or not reachable.

**Fix for local dev:**
```bash
# Terminal 1
npm run build

# Terminal 2  
node backend/server.js
```

**Fix for production:**
```bash
# Check your platform's logs
# Render: Dashboard → Logs
# Railway: railway logs
# Koyeb: Dashboard → Service → Logs
```

**Common causes:**
- Wrong `PORT` env var (must match platform's port)
- `PUBLIC_URL` not set correctly
- Build failed — check build logs

---

### ❌ Stremio Shows No Channels

**Cause:** Config not synced to backend, or manifest URL wrong.

**Fix:**
1. Open configurator → **Backend tab**
2. Check backend status (should be green)
3. Click **"Sync Streams"**
4. Reinstall the addon in Stremio with the correct manifest URL

---

### ❌ Black Screen on Samsung TV

**Cause:** HLS master playlist not being resolved, or stream URL returned to Stremio is a playlist.

**Fix:**
1. Open configurator → **Handler tab (🧩)**
2. Paste your problematic stream URL in the tester
3. Check what type is detected (master/media/direct)
4. If `fallback` type with error, the stream server may be blocking the backend UA

**Advanced fix:**
```bash
# Enable debug logging
DEBUG=true node backend/server.js

# Watch for [EXTRACT] log lines
# They show exactly what variant was selected
```

---

### ❌ M3U Source Not Loading

**Cause:** CORS issue when fetching the M3U URL from browser.

**Fix:**
1. Go to **Settings tab**
2. Change CORS Proxy to `https://corsproxy.io/?`
3. Try re-adding the source
4. If still failing, test the URL directly in your browser

**Alternative:** Download the M3U file manually and upload it via **"Upload File"** option.

---

### ❌ Streams Not Updating in Stremio After Sync

**Cause:** Stremio caches catalog data for a while.

**Fix:**
1. In Stremio, go to **Settings → Addons**
2. Find your addon and click **Uninstall**
3. Reinstall with the same manifest URL
4. Your channels will refresh

Or wait ~30 minutes for Stremio's cache to expire.

---

### ❌ Render Free Tier Spins Down

**Cause:** Render free tier services sleep after 15 minutes of inactivity.

**Fix — Keep alive with a cron job (free):**
Use [UptimeRobot](https://uptimerobot.com) (free):
1. Sign up at uptimerobot.com
2. Add monitor → HTTP(S)
3. URL: `https://your-app.onrender.com/health`
4. Interval: every 5 minutes

This pings your server every 5 minutes to keep it awake.

---

### ❌ Port Already in Use

```
Error: Port 7000 is already in use
```

**Fix:**
```bash
# Use a different port
PORT=8080 node backend/server.js

# Or find and kill the process using port 7000
lsof -ti:7000 | xargs kill -9   # Mac/Linux
netstat -ano | findstr :7000     # Windows (then Task Manager to kill)
```

---

### ❌ Build Fails on Deploy

**Fix:**
```bash
# Test build locally first
npm run build

# Common issues:
# 1. TypeScript errors — check console output
# 2. Missing dependencies — ensure package.json is complete
# 3. Node version too old — add to package.json:
#    "engines": { "node": ">=18.0.0" }
```

---

## FAQ

**Q: Do I need to reinstall the addon in Stremio when I change streams?**

No! That's the whole point. Just sync from the configurator → Backend tab → Sync Streams. Stremio picks up changes automatically (may take a few minutes for cache to clear).

---

**Q: Can I use this on multiple devices?**

Yes. Deploy once to the cloud. Install the same manifest URL on all your Stremio devices (TV, phone, PC). They all connect to the same backend.

---

**Q: Is the configurator public? Can anyone see my streams?**

The configurator has no authentication by default. If you want to protect it, add Basic Auth in your Nginx config or use a platform-level access control. The stream data itself is served via the addon endpoints which are always public (required for Stremio).

---

**Q: How many streams can this handle?**

The configurator is tested with 10,000+ streams. The IndexedDB storage handles large datasets. The backend serves streams on-demand (one fetch per play request), so server load is minimal.

---

**Q: What M3U formats are supported?**

- Standard `#EXTM3U` + `#EXTINF` format
- Extended M3U with `tvg-id`, `tvg-name`, `tvg-logo`, `group-title` attributes
- Both `"quoted"` and `unquoted` attribute values
- Windows (`\r\n`) and Unix (`\n`) line endings
- Single `.m3u8` URLs

---

**Q: Why does the health checker show streams as "alive" even if they don't play?**

Browser-based health checking uses `fetch()` in `no-cors` mode which can only verify reachability, not actual stream validity. For accurate checking, use the **Handler tab** to test HLS resolution.

---

**Q: The backend server code in the Handler tab — what's it for?**

It generates a standalone `server.js` file with your streams baked in. This is useful if you want to run the addon without the configurator frontend — just a pure, minimal Stremio addon server.

---

**Q: Can I use Vercel?**

Vercel is designed for serverless functions, not persistent Node.js servers. The backend needs to be a long-running process (for the in-memory cache and file reading). Use Render, Koyeb, or Railway instead. If you must use Vercel, you'd need to rewrite the backend as serverless API routes (complex).

---

**Q: How does the Samsung TV remote navigation work in the configurator?**

The configurator is designed with large buttons and proper `focus-visible` styles. On Samsung Tizen browser, D-pad navigation cycles through focusable elements. Tab key on keyboard does the same. All interactive elements have visible focus rings (purple outline).

---

## Project Structure

```
jash-addon/
├── backend/
│   ├── server.js              # Node.js Stremio addon + static file server
│   └── streams-config.json    # Stream config (written by /api/sync)
├── src/
│   ├── App.tsx                # Main React app — wires all tabs
│   ├── main.tsx               # React entry point
│   ├── index.css              # Tailwind CSS + custom animations
│   ├── components/
│   │   ├── Header.tsx         # Navigation tabs
│   │   ├── Notification.tsx   # Toast notifications
│   │   ├── SourcesTab.tsx     # Add/manage M3U sources
│   │   ├── StreamsTab.tsx     # Browse/edit/bulk-manage streams
│   │   ├── GroupsTab.tsx      # Create/rename/delete groups
│   │   ├── HealthTab.tsx      # Health check runner
│   │   ├── StatisticsTab.tsx  # Stats dashboard + backup
│   │   ├── SettingsTab.tsx    # Addon settings
│   │   ├── InstallTab.tsx     # Stremio install guide
│   │   ├── ExportPanel.tsx    # M3U download/URL/preview
│   │   ├── StreamHandlerTab.tsx # HLS tester + code generator
│   │   └── BackendPanel.tsx   # Backend sync + deploy guide
│   ├── store/
│   │   └── useAppStore.ts     # React state + all CRUD operations
│   ├── types/
│   │   └── index.ts           # TypeScript interfaces
│   └── utils/
│       ├── db.ts              # IndexedDB operations
│       ├── m3uParser.ts       # M3U/M3U8 parser
│       ├── m3uExporter.ts     # M3U generator + download
│       ├── healthCheck.ts     # Stream health checking
│       ├── streamExtractor.ts # HLS extraction (browser)
│       ├── backendSync.ts     # Sync to backend server
│       └── cn.ts              # Tailwind class utility
├── render.yaml                # Render.com one-click deploy config
├── Procfile                   # Heroku/Railway compatible
├── index.html                 # HTML entry point
├── vite.config.ts             # Vite build config
├── tailwind.config.js         # Tailwind CSS config
└── README.md                  # This file
```

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Frontend** | React 19, TypeScript, Tailwind CSS 4, Vite 7 |
| **State** | React hooks (`useState`, `useEffect`, `useCallback`) |
| **Storage** | IndexedDB (streams), localStorage (settings) |
| **Backend** | Pure Node.js (no framework) — `http`, `https`, `fs`, `path` |
| **Addon Protocol** | Stremio Addon SDK compatible REST API |
| **HLS** | Custom `extractRealStreamUrl()` parser |
| **Deploy** | Render / Koyeb / Railway / Fly.io / VPS |

---

## License

MIT License — free to use, modify, and distribute.

---

## Credits

- HLS extraction algorithm inspired by real-world Samsung Tizen Stremio debugging
- Built with [React](https://react.dev), [Vite](https://vitejs.dev), [Tailwind CSS](https://tailwindcss.com)
- Stremio addon protocol: [Stremio Addon SDK](https://github.com/Stremio/stremio-addon-sdk)

---

*Made with ❤️ for the Samsung Tizen IPTV community*
