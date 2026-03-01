# 📺 IPTV Playlist Manager

Full-stack IPTV manager with playlist generation, stream proxy, DRM bypass, and Tamil channel filtering.

## 🚀 Quick Deploy to Render.com

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com)

1. Push this repo to GitHub
2. Go to [render.com](https://render.com) → **New Web Service**
3. Connect your GitHub repo
4. Render auto-detects `render.yaml` and deploys!

## ✨ Features

- **Source Parsing**: M3U, M3U8, JSON (JioTV, generic), PHP APIs, GitHub raw, Pastebin
- **Auto-Detection**: Format detected automatically from content
- **Tamil Filter**: Auto-detects and tags Tamil channels from 30+ keywords
- **Stream Proxy**: `/proxy/redirect/:id` — hides original URLs, forwards UA/Referer/Cookie
- **DRM Bypass**: ClearKey (kid:key) + Widevine license forwarding
- **Live Playlists**: `/api/playlist/:id.m3u` — updates instantly when sources change
- **Auto-Sync**: Every change in UI auto-syncs to server
- **Auto-Refresh**: Sources refresh on configurable intervals
- **Full CRUD**: Channels, Groups, Sources, Playlists, DRM Proxies

## 📡 Key API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/playlist/:id.m3u` | 🔴 Live M3U playlist (add to any IPTV player) |
| GET | `/api/playlists` | All playlists with M3U URLs |
| GET | `/proxy/redirect/:id` | Stream proxy (hides original URL) |
| GET | `/proxy/drm/:id` | DRM stream proxy |
| POST | `/proxy/drm-license/:id` | ClearKey license endpoint |
| GET | `/proxy/cors?url=...` | CORS proxy for source fetching |
| POST | `/api/sync` | Sync full database from frontend |
| GET | `/api/stats` | Server status and channel counts |

## 🔧 Local Development

```bash
npm install
npm run build   # Build React frontend
node server.js  # Start server on port 3000
```

## 🔐 DRM Support

- **ClearKey**: Parses `kid:key` pairs, serves W3C ClearKey JSON license
- **Widevine**: Forwards binary license requests to real license server  
- **JioTV**: Auto-parses `drmScheme` + `drmLicense` from JSON sources
- **KODIPROP**: Extracts `inputstream.adaptive.license_type/key` from M3U
- **Multi-key**: Comma-separated `kid1:key1,kid2:key2` format supported

## 🎬 Tamil Channel Detection

Auto-detected from: Sun TV, Vijay TV, Zee Tamil, Kalaignar, Polimer, Jaya TV, Raj TV, Captain TV, Vendhar, Vasanth, Adithya, Mega TV, Thanthi, Sathiyam, Sirippoli, Chutti TV, Star Vijay, Colors Tamil, News7 Tamil, News18 Tamil, DD Tamil, and more.
