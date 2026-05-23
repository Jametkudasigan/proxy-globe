# Proxy Globe

Interactive 3D dashboard plotting free SOCKS5 proxies on a draggable Earth, color-coded by health (green = healthy, yellow = weak, red = dead). Static deploy via GitHub Pages — no backend.

## Live

`https://jametkudasigan.github.io/proxy-globe/`

## How it works

1. `scripts/fetch_proxies.py` pulls public SOCKS5 lists, dedupes, samples 600 endpoints, then runs raw `SOCKS5` handshake + CONNECT health-checks in parallel.
2. Geolocation via `ip-api.com` batch (free tier, 100 IPs / call).
3. Dataset written to `data/proxies.json`. The frontend (Three.js) reads that snapshot and renders instanced spheres on the globe.

## Tech

- Three.js (ESM via importmap, no bundler).
- Procedural canvas-textured Earth, additive atmosphere shader, neon HUD.
- OrbitControls for cursor rotate / scroll zoom.
- InstancedMesh for performance on hundreds of points.

## Refresh data

```sh
python3 scripts/fetch_proxies.py 600
```

Commit the regenerated `data/proxies.json` and push — GitHub Pages redeploys.

## Local dev

```sh
python3 -m http.server 8080
# open http://localhost:8080
```
