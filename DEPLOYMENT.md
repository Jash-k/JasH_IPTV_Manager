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

## ⚠️ MOST COMMON ERROR — "vite: not found"

```
sh: 1: vite: not found
==> Build failed 😞
```

**Why it happens:**
Cloud platforms (Render, Koyeb, Railway) set `NODE_ENV=production` automatically.
This causes `npm install` to skip `devDependencies` — which includes `vite`, 
`@vitejs/plugin-react`, and `tailwindcss`. Without `vite`, the build command 
`npm run build` fails because `vite build` isn't available.

**Fix — use `npm install --include=dev`:**

| Platform | Build Command |
|----------|--------------|
| **Render** | `npm install --include=dev && npm run build` |
| **Koyeb** | `npm install --include=dev && npm run build` |
| **Railway** | `npm install --include=dev && npm run build` |
| **Fly.io** | Uses Dockerfile — automatically handled |
| **VPS** | `npm install && npm run build` (no NODE_ENV restriction) |

> ✅ The `.npmrc` file in this repo sets `include=dev` automatically, but
> always set the explicit build command on your platform as a safety net.

---

## 🏆 PLATFORM COMPARISON

| Platform | Free Tier | Sleep? | Speed | Fix Needed | Recommended? |
|----------|-----------|--------|-------|-----------|-------------|
| **Render** | ✅ Yes | 💤 15min idle | Medium | `--include=dev` in build | ⭐⭐⭐⭐⭐ Best |
| **Koyeb** | ✅ Yes | ❌ No sleep | Fast | `--include=dev` in build | ⭐⭐⭐⭐ Great |
| **Railway** | ✅ $5 credit | ❌ No sleep | Fast | `--include=dev` in build | ⭐⭐⭐⭐ Great |
| **Fly.io** | ✅ Yes | ❌ No sleep | Fast | Uses Dockerfile ✅ | ⭐⭐⭐ Good |
| **Docker/VPS** | ❌ ~€4/mo | ❌ No sleep | Fastest | Dockerfile ✅ | ⭐⭐⭐ Advanced |
| **Vercel** | ✅ Yes | ❌ No sleep | Fast | ❌ WRONG CHOICE | ⛔ Avoid |

---

## ⛔ WHY NOT VERCEL?

Vercel is designed for **serverless functions** (max 10–60 seconds execution time).
This addon needs a **persistent Node.js server** because:

1. **In-memory stream cache** — stores resolved HLS URLs for 5 minutes
2. **File reading** — reads `streams-config.json` on each request
3. **Long-running HTTP requests** — fetching M3U8 playlists can take 3–10 seconds
4. **State persistence** — stream cache must survive between requests

❌ Vercel kills the process after each request — cache is lost every time.
✅ Use Render, Koyeb, or Railway instead.

---

## 🥇 OPTION 1: RENDER (Recommended for Beginners)

### Step 1 — Push to GitHub

```bash
git init
git add .
git commit -m "Initial commit — Jash Addon"
git remote add origin https://github.com/YOUR_USERNAME/jash-addon.git
git push -u origin main
```

### Step 2 — Create Render Account
→ Go to https://render.com and sign up with GitHub (free, no credit card)

### Step 3 — Create Web Service
1. Click **"New +"** → **"Web Service"**
2. Select **"Connect a repository"**
3. Choose your `jash-addon` repo
4. Click **"Connect"**

### Step 4 — Configure (EXACT settings)

| Field | Value |
|-------|-------|
| **Name** | `jash-addon` |
| **Region** | Closest to you |
| **Branch** | `main` |
| **Runtime** | `Node` |
| **Build Command** | `npm install --include=dev && npm run build` |
| **Start Command** | `node backend/server.js` |
| **Instance Type** | `Free` |

### Step 5 — Environment Variables

In the **"Advanced"** section, add:

| Key | Value |
|-----|-------|
| `PORT` | `10000` |
| `NODE_ENV` | `production` |

> Leave `PUBLIC_URL` empty for now — you'll add it after first deploy.

### Step 6 — Deploy

Click **"Create Web Service"**. Watch the build log:

```
==> Running build command: npm install --include=dev && npm run build
✓ Installing dependencies (including devDependencies)...
✓ vite build...
✓ dist/ created
==> Build successful 🎉
==> Running: node backend/server.js
[JASH] 🚀 Jash Addon Server started!
```

### Step 7 — Set PUBLIC_URL

After deploy, get your URL (e.g. `https://jash-addon.onrender.com`).
Go to **Environment** tab → Add:

| Key | Value |
|-----|-------|
| `PUBLIC_URL` | `https://jash-addon.onrender.com` |

Click **"Save Changes"** → Render redeploys automatically.

### Step 8 — Verify

```bash
curl https://jash-addon.onrender.com/health
# {"status":"ok","addon":"Jash IPTV","streams":0,...}

curl https://jash-addon.onrender.com/manifest.json
# {"id":"jash-iptv-addon","name":"Jash IPTV",...}
```

### Step 9 — Fix Sleep Issue (Optional but Recommended)

Render free tier sleeps after 15 minutes of inactivity.
**Fix with UptimeRobot (free):**
1. Go to https://uptimerobot.com
2. Add Monitor → HTTP(s)
3. URL: `https://jash-addon.onrender.com/health`
4. Interval: Every 5 minutes
5. ✅ Server stays awake 24/7!

---

## 🥈 OPTION 2: KOYEB (No Sleep, Always On)

### Step 1 — Push to GitHub *(same as Render Step 1)*

### Step 2 — Create Koyeb Account
→ Go to https://app.koyeb.com and sign up with GitHub (free)

### Step 3 — Create New App
1. Click **"Create App"**
2. Select **"GitHub"** as deployment source
3. Choose your `jash-addon` repository
4. Select branch: `main`

### Step 4 — Configure Service (EXACT settings)

| Setting | Value |
|---------|-------|
| **Service name** | `jash-addon` |
| **Instance type** | `Free` |
| **Build command** | `npm install --include=dev && npm run build` |
| **Run command** | `node backend/server.js` |
| **Port** | `8000` |

### Step 5 — Environment Variables

| Key | Value |
|-----|-------|
| `PORT` | `8000` |
| `NODE_ENV` | `production` |
| `PUBLIC_URL` | *(set after deploy — see Step 7)* |

### Step 6 — Deploy
Click **"Deploy"**. Build log should show:

```
Running: npm install --include=dev && npm run build
✓ Installed vite, react, tailwindcss...
✓ vite build completed
✓ dist/ created
```

### Step 7 — Set PUBLIC_URL
After deploy, get your URL from Koyeb dashboard under **Domains**.
It looks like: `https://jash-addon-abc123.koyeb.app`

Go back to **Environment Variables** → Add:

| Key | Value |
|-----|-------|
| `PUBLIC_URL` | `https://jash-addon-abc123.koyeb.app` |

Click **"Redeploy"**.

### Step 8 — Verify

```bash
curl https://jash-addon-abc123.koyeb.app/health
curl https://jash-addon-abc123.koyeb.app/manifest.json
```

---

## 🥉 OPTION 3: RAILWAY

### Step 1 — Install CLI & Login

```bash
npm install -g @railway/cli
railway login
```

### Step 2 — Deploy

```bash
cd jash-addon
railway init
railway up
```

### Step 3 — Set Environment Variables

```bash
railway variables set NODE_ENV=production
railway variables set PORT=3000
```

### Step 4 — Get URL & Set PUBLIC_URL

```bash
railway domain
# e.g.: jash-addon.up.railway.app

railway variables set PUBLIC_URL=https://jash-addon.up.railway.app
railway up
```

### Step 5 — Verify

```bash
curl https://jash-addon.up.railway.app/health
```

> ℹ️ Railway uses `railway.toml` in this repo which sets the correct build command automatically.

---

## 🐳 OPTION 4: DOCKER (Most Reliable, Any Platform)

The included `Dockerfile` uses a multi-stage build — no `--include=dev` needed because
Stage 1 (builder) installs everything including devDeps, Stage 2 (production) only copies
the built `dist/` folder and production dependencies.

### Build & Run Locally

```bash
docker build -t jash-addon .
docker run -p 7000:7000 -e PUBLIC_URL=http://localhost:7000 jash-addon
```

### Deploy to Fly.io

```bash
# Install flyctl: https://fly.io/docs/hands-on/install-flyctl/
fly auth login
fly launch --name jash-addon
fly secrets set PUBLIC_URL=https://jash-addon.fly.dev
fly deploy
```

### Deploy to any Docker host

```bash
# Build
docker build -t jash-addon .

# Push to registry
docker tag jash-addon ghcr.io/YOUR_USERNAME/jash-addon:latest
docker push ghcr.io/YOUR_USERNAME/jash-addon:latest

# Run on server
docker run -d \
  --name jash-addon \
  --restart unless-stopped \
  -p 7000:7000 \
  -e PORT=7000 \
  -e PUBLIC_URL=https://your-domain.com \
  ghcr.io/YOUR_USERNAME/jash-addon:latest
```

---

## 🖥️ OPTION 5: VPS / UBUNTU SERVER

```bash
# Connect to your server
ssh root@YOUR_IP

# Install Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs git

# Install PM2
npm install -g pm2

# Clone repo
git clone https://github.com/YOUR_USERNAME/jash-addon.git
cd jash-addon

# Install all deps + build (no NODE_ENV restriction on VPS)
npm install
npm run build

# Start with PM2
PORT=7000 PUBLIC_URL=https://your-domain.com pm2 start backend/server.js --name jash-addon
pm2 save
pm2 startup

# Check logs
pm2 logs jash-addon
```

**With Nginx + SSL:**

```bash
# Install nginx + certbot
apt install -y nginx certbot python3-certbot-nginx

# Create nginx config
cat > /etc/nginx/sites-available/jash-addon << 'EOF'
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://localhost:7000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        add_header Access-Control-Allow-Origin *;
    }
}
EOF

ln -s /etc/nginx/sites-available/jash-addon /etc/nginx/sites-enabled/
nginx -t && systemctl restart nginx

# Get SSL
certbot --nginx -d your-domain.com
```

---

## 🔧 ENVIRONMENT VARIABLES REFERENCE

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | Platform sets | `7000` | HTTP port |
| `PUBLIC_URL` | **Yes** | `http://localhost:7000` | Your full public URL (no trailing slash) |
| `NODE_ENV` | No | `development` | Set to `production` |
| `DEBUG` | No | `false` | Set to `true` for verbose logs |

### Platform-Specific Values

```
Render  → PORT=10000, PUBLIC_URL=https://jash-addon.onrender.com
Koyeb   → PORT=8000,  PUBLIC_URL=https://jash-addon-xxx.koyeb.app
Railway → PORT=3000,  PUBLIC_URL=https://jash-addon.up.railway.app
Fly.io  → PORT=8080,  PUBLIC_URL=https://jash-addon.fly.dev
VPS     → PORT=7000,  PUBLIC_URL=https://your-domain.com
```

---

## 🔍 TROUBLESHOOTING BUILD ERRORS

### "vite: not found" / "sh: 1: vite: not found"

```
✅ Fix: Change build command to:
   npm install --include=dev && npm run build

   The .npmrc file in this repo also sets include=dev globally.
   If your platform ignores .npmrc, use the explicit build command above.
```

### "Cannot find module 'express'"

```
✅ Fix: express is in dependencies (not devDependencies), so this
   shouldn't happen. If it does, check that package.json wasn't modified.
```

### Build succeeds but /manifest.json returns 404

```
✅ Check: Is backend/server.js running? (not vite preview)
   Start command must be: node backend/server.js
   NOT: npm run dev
   NOT: vite preview
```

### Backend shows "Backend Offline" in configurator

```
✅ Check 1: Is the server deployed and running? Visit /health
✅ Check 2: Is PUBLIC_URL set correctly? Wrong URL breaks CORS
✅ Check 3: Is PORT matching what your platform expects?
            Render: 10000, Koyeb: 8000, Railway: auto
```

### Streams not showing in Stremio after sync

```
✅ Step 1: Open configurator → Backend tab
✅ Step 2: Check backend is "🟢 Online"
✅ Step 3: Click "Sync X Streams"
✅ Step 4: In Stremio: uninstall addon → reinstall with manifest URL
✅ Step 5: Wait 60 seconds for Stremio catalog to refresh
```

### Samsung TV black screen

```
✅ Check 1: Stream is HLS (.m3u8)? Backend extracts real URL.
✅ Check 2: Test in Handler tab — paste stream URL → see resolved URL
✅ Check 3: Enable DEBUG=true on server → check logs for [EXTRACT]
✅ Check 4: The middle-quality variant selection should fix 95% of cases
```

---

## 📋 COMPLETE WORKFLOW AFTER DEPLOYMENT

```
1. Open: https://your-app.onrender.com
   → This is your React configurator (bookmark it!)

2. Go to "Sources" tab
   → Add M3U URL / Upload File / Manual entry

3. Go to "Streams" tab
   → Edit, delete, organize streams

4. Go to "Groups" tab
   → Rename, merge groups

5. Go to "Health" tab
   → Check alive/dead streams

6. Go to "Backend" tab
   → Check: backend shows "🟢 Online"
   → Click "Sync X Streams"
   → Copy manifest URL
   → Click "Install in Stremio"

7. Stremio opens → Confirm installation

8. On Samsung TV:
   → Stremio → TV → Your groups appear as categories
   → Select channel → Backend extracts HLS → Plays! ✅

9. Future changes:
   → Edit in configurator → Sync → Done ✅
   → Never reinstall the addon!
```

---

## ❓ FAQ

**Q: Why does the build fail with "vite: not found"?**  
A: Cloud platforms skip devDependencies in production. Use `npm install --include=dev && npm run build` as your build command. The `.npmrc` file in this repo also helps.

**Q: Do I need separate frontend and backend deployments?**  
A: No. `backend/server.js` serves both. One deployment = one URL = everything works.

**Q: Can I use Vercel?**  
A: No. Vercel is serverless — can't cache HLS URLs between requests. Use Render, Koyeb, or Railway.

**Q: How many streams can it handle?**  
A: Frontend: 10,000+ (IndexedDB). Backend: unlimited (streams loaded on-demand from JSON file).

**Q: What happens when Render free tier sleeps?**  
A: Use UptimeRobot to ping `/health` every 5 minutes. Free at uptimerobot.com.

**Q: Do I need to reinstall Stremio addon when I add streams?**  
A: No! Just sync from configurator → Backend tab → "Sync Streams". Stremio picks up changes automatically.

**Q: Samsung TV still shows black screen after setup?**  
A: Go to Handler tab → paste your stream URL → test it → check what type is detected. Enable `DEBUG=true` on server and check logs for `[EXTRACT]` messages.
