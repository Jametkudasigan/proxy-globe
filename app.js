import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// ----------------------------------------------------------
// state
// ----------------------------------------------------------
const STATE = {
  data: null,
  filter: 'all',
  hovered: null,
  meshes: { ok: null, weak: null, dead: null },
  lookups: { ok: [], weak: [], dead: [] },
};

// ----------------------------------------------------------
// load dataset
// ----------------------------------------------------------
async function loadData() {
  try {
    const r = await fetch('data/proxies.json?t=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) throw new Error('no data');
    return await r.json();
  } catch {
    return {
      generated_at: Math.floor(Date.now() / 1000),
      total_collected: 0, alive: 0, ok: 0, weak: 0, dead: 0,
      proxies: [],
    };
  }
}

// ----------------------------------------------------------
// helpers
// ----------------------------------------------------------
function latLonToVec3(lat, lon, radius) {
  const phi = (90 - lat) * (Math.PI / 180);
  const theta = (lon + 180) * (Math.PI / 180);
  const x = -radius * Math.sin(phi) * Math.cos(theta);
  const z = radius * Math.sin(phi) * Math.sin(theta);
  const y = radius * Math.cos(phi);
  return new THREE.Vector3(x, y, z);
}

function fmtTimestamp(ts) {
  const d = new Date(ts * 1000);
  return d.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

function setText(id, val) { const el = document.getElementById(id); if (el) el.textContent = val; }

// ----------------------------------------------------------
// build scene
// ----------------------------------------------------------
const canvas = document.getElementById('globe');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
camera.position.set(0, 0, 3.4);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.rotateSpeed = 0.55;
controls.enablePan = false;
controls.minDistance = 2.4;
controls.maxDistance = 6.5;
controls.autoRotate = true;
controls.autoRotateSpeed = 0.35;

// stop auto-rotate as soon as user touches
canvas.addEventListener('pointerdown', () => { controls.autoRotate = false; });

// ----------------------------------------------------------
// globe: wireframe + gradient skin
// ----------------------------------------------------------
const RADIUS = 1.0;
const earthGroup = new THREE.Group();
scene.add(earthGroup);

// Procedural land/water canvas texture (no external assets)
function makeEarthTexture() {
  const W = 1024, H = 512;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');

  // ocean gradient
  const og = ctx.createLinearGradient(0, 0, 0, H);
  og.addColorStop(0, '#04162b');
  og.addColorStop(0.5, '#061a36');
  og.addColorStop(1, '#020912');
  ctx.fillStyle = og;
  ctx.fillRect(0, 0, W, H);

  // procedural "continents" — generate rough blobs of glow
  ctx.fillStyle = 'rgba(45, 212, 255, 0.08)';
  for (let i = 0; i < 120; i++) {
    const x = Math.random() * W;
    const y = Math.random() * H;
    const r = 18 + Math.random() * 80;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, 'rgba(45, 212, 255, 0.20)');
    g.addColorStop(1, 'rgba(45, 212, 255, 0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  }

  // longitude/latitude grid
  ctx.strokeStyle = 'rgba(120, 200, 255, 0.18)';
  ctx.lineWidth = 1;
  for (let lon = 0; lon < W; lon += W / 24) {
    ctx.beginPath(); ctx.moveTo(lon, 0); ctx.lineTo(lon, H); ctx.stroke();
  }
  for (let lat = 0; lat < H; lat += H / 12) {
    ctx.beginPath(); ctx.moveTo(0, lat); ctx.lineTo(W, lat); ctx.stroke();
  }

  return new THREE.CanvasTexture(c);
}

const earthMaterial = new THREE.MeshPhongMaterial({
  map: makeEarthTexture(),
  color: 0x0a1525,
  emissive: 0x041c33,
  emissiveIntensity: 0.6,
  shininess: 12,
  specular: 0x223a55,
  transparent: true,
  opacity: 0.92,
});
const earthMesh = new THREE.Mesh(new THREE.SphereGeometry(RADIUS, 96, 96), earthMaterial);
earthGroup.add(earthMesh);

// neon wireframe overlay
const wireMat = new THREE.LineBasicMaterial({ color: 0x2dd4ff, transparent: true, opacity: 0.18 });
const wireGeo = new THREE.WireframeGeometry(new THREE.SphereGeometry(RADIUS * 1.001, 32, 24));
earthGroup.add(new THREE.LineSegments(wireGeo, wireMat));

// ----------------------------------------------------------
// continent outlines from GeoJSON (Natural Earth 110m)
// ----------------------------------------------------------
async function buildContinents(radius) {
  let geo;
  try {
    const r = await fetch('data/world.json', { cache: 'force-cache' });
    geo = await r.json();
  } catch (e) { return; }

  const positions = [];

  function addRing(ring) {
    for (let i = 0; i < ring.length; i++) {
      const [lon, lat] = ring[i];
      const v = latLonToVec3(lat, lon, radius);
      if (i > 0) {
        // segment from previous point to current
        const [plon, plat] = ring[i - 1];
        const pv = latLonToVec3(plat, plon, radius);
        positions.push(pv.x, pv.y, pv.z, v.x, v.y, v.z);
      }
    }
  }

  for (const feat of geo.features || []) {
    const g = feat.geometry;
    if (!g) continue;
    if (g.type === 'Polygon') {
      g.coordinates.forEach(addRing);
    } else if (g.type === 'MultiPolygon') {
      g.coordinates.forEach(poly => poly.forEach(addRing));
    }
  }

  const lineGeo = new THREE.BufferGeometry();
  lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  const lineMat = new THREE.LineBasicMaterial({
    color: 0x6effd6,
    transparent: true,
    opacity: 0.55,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const lines = new THREE.LineSegments(lineGeo, lineMat);
  earthGroup.add(lines);
}
buildContinents(RADIUS * 1.005);

// outer glow (atmosphere)
const glowMat = new THREE.ShaderMaterial({
  uniforms: { c: { value: 0.55 }, p: { value: 4.5 }, glowColor: { value: new THREE.Color(0x2dd4ff) } },
  vertexShader: `
    varying vec3 vNormal;
    void main() { vNormal = normalize(normalMatrix * normal); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: `
    uniform float c; uniform float p; uniform vec3 glowColor; varying vec3 vNormal;
    void main() {
      float intensity = pow(c - dot(vNormal, vec3(0.0, 0.0, 1.0)), p);
      gl_FragColor = vec4(glowColor, 1.0) * intensity;
    }
  `,
  side: THREE.BackSide,
  blending: THREE.AdditiveBlending,
  transparent: true,
  depthWrite: false,
});
earthGroup.add(new THREE.Mesh(new THREE.SphereGeometry(RADIUS * 1.18, 64, 64), glowMat));

// rim highlight (front-side fresnel)
const rimMat = new THREE.ShaderMaterial({
  uniforms: { color: { value: new THREE.Color(0x8b5cff) } },
  vertexShader: `varying vec3 vNormal; void main(){ vNormal = normalize(normalMatrix * normal); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);} `,
  fragmentShader: `uniform vec3 color; varying vec3 vNormal; void main(){ float f = pow(1.0 - dot(vNormal, vec3(0,0,1)), 2.5); gl_FragColor = vec4(color * f, f); }`,
  side: THREE.FrontSide,
  blending: THREE.AdditiveBlending,
  transparent: true,
  depthWrite: false,
});
earthGroup.add(new THREE.Mesh(new THREE.SphereGeometry(RADIUS * 1.005, 64, 64), rimMat));

// stars / particles
const starGeo = new THREE.BufferGeometry();
const starCount = 1200;
const starPos = new Float32Array(starCount * 3);
for (let i = 0; i < starCount; i++) {
  const r = 30 + Math.random() * 60;
  const t = Math.random() * Math.PI * 2;
  const p = Math.acos(2 * Math.random() - 1);
  starPos[i * 3]     = r * Math.sin(p) * Math.cos(t);
  starPos[i * 3 + 1] = r * Math.cos(p);
  starPos[i * 3 + 2] = r * Math.sin(p) * Math.sin(t);
}
starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
scene.add(new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0xaaccff, size: 0.06, transparent: true, opacity: 0.6 })));

// lights
scene.add(new THREE.AmbientLight(0xffffff, 0.55));
const dl = new THREE.DirectionalLight(0xffffff, 0.95);
dl.position.set(5, 3, 5);
scene.add(dl);
const blueRim = new THREE.PointLight(0x2dd4ff, 1.2, 12);
blueRim.position.set(-3, 2, -3);
scene.add(blueRim);

// ----------------------------------------------------------
// proxy points (instanced for perf)
// ----------------------------------------------------------
const STATUS_COLORS = {
  ok:   new THREE.Color(0x00ff9c),
  weak: new THREE.Color(0xffd34d),
  dead: new THREE.Color(0xff3b6b),
};
const STATUS_GLOW = {
  ok:   new THREE.Color(0x00ff9c),
  weak: new THREE.Color(0xffd34d),
  dead: new THREE.Color(0xff3b6b),
};

function buildPoints(proxies) {
  // remove old
  ['ok','weak','dead'].forEach(s => {
    if (STATE.meshes[s]) {
      earthGroup.remove(STATE.meshes[s]);
      STATE.meshes[s].geometry.dispose();
      STATE.meshes[s].material.dispose();
      STATE.meshes[s] = null;
    }
  });
  STATE.lookups = { ok: [], weak: [], dead: [] };

  const grouped = { ok: [], weak: [], dead: [] };
  for (const p of proxies) {
    if (p.lat === undefined || p.lon === undefined) continue;
    grouped[p.status]?.push(p);
  }

  for (const s of ['ok','weak','dead']) {
    const arr = grouped[s];
    if (!arr.length) continue;
    const geo = new THREE.SphereGeometry(0.012, 8, 8);
    const mat = new THREE.MeshBasicMaterial({
      color: STATUS_COLORS[s],
      transparent: true,
      opacity: 0.95,
    });
    const mesh = new THREE.InstancedMesh(geo, mat, arr.length);
    const dummy = new THREE.Object3D();
    arr.forEach((p, i) => {
      const v = latLonToVec3(p.lat, p.lon, RADIUS * 1.012);
      dummy.position.copy(v);
      dummy.lookAt(v.clone().multiplyScalar(2));
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.userData.status = s;
    earthGroup.add(mesh);
    STATE.meshes[s] = mesh;
    STATE.lookups[s] = arr;
  }
}

// ----------------------------------------------------------
// raycaster (hover/click)
// ----------------------------------------------------------
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const sel = document.getElementById('selected');

function onPointer(e) {
  const rect = canvas.getBoundingClientRect();
  pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
}
canvas.addEventListener('pointermove', onPointer);

// ----------------------------------------------------------
// floating tooltip on hover
// ----------------------------------------------------------
const tooltip = document.createElement('div');
tooltip.id = 'tooltip';
tooltip.className = 'tooltip';
document.body.appendChild(tooltip);

function showTooltip(p, x, y) {
  if (!p) { tooltip.style.opacity = '0'; tooltip.style.pointerEvents = 'none'; return; }
  const proxy = `${p.ip}:${p.port}`;
  tooltip.innerHTML = `
    <div class="tt-row tt-ip">
      <span class="tt-status tt-${p.status}"></span>
      <span class="tt-proxy">${proxy}</span>
    </div>
    <div class="tt-row tt-meta">
      <span>${p.city || '—'}, ${p.cc || '—'}</span>
      <span>${p.alive ? p.latency_ms.toFixed(0) + 'ms' : 'dead'}</span>
    </div>
    <div class="tt-hint">click to copy</div>
  `;
  tooltip.style.opacity = '1';
  tooltip.style.left = (x + 14) + 'px';
  tooltip.style.top = (y + 14) + 'px';
}

let lastClientX = 0, lastClientY = 0;
canvas.addEventListener('pointermove', (e) => { lastClientX = e.clientX; lastClientY = e.clientY; });

function pickProxy() {
  raycaster.setFromCamera(pointer, camera);
  const hits = [];
  for (const s of ['ok','weak','dead']) {
    const m = STATE.meshes[s];
    if (!m || !m.visible) continue;
    const r = raycaster.intersectObject(m);
    for (const h of r) hits.push({ status: s, instanceId: h.instanceId, distance: h.distance });
  }
  hits.sort((a, b) => a.distance - b.distance);
  return hits[0] || null;
}

function renderSelected(p) {
  if (!p) {
    sel.innerHTML = '<div class="sel-empty">hover or tap a proxy dot</div>';
    return;
  }
  const proxy = `${p.ip}:${p.port}`;
  const cls = `sel-status ${p.status}`;
  sel.innerHTML = `
    <div class="sel-row"><span class="lbl">endpoint</span><span class="val copy" title="click to copy" data-copy="${proxy}">${proxy}</span></div>
    <div class="sel-row"><span class="lbl">status</span><span class="${cls}">${p.status}</span></div>
    <div class="sel-row"><span class="lbl">latency</span><span class="val">${p.alive ? p.latency_ms.toFixed(0) + ' ms' : '—'}</span></div>
    <div class="sel-row"><span class="lbl">city</span><span class="val">${p.city || '—'}</span></div>
    <div class="sel-row"><span class="lbl">country</span><span class="val">${p.country || '—'} ${p.cc ? '(' + p.cc + ')' : ''}</span></div>
    <div class="sel-row"><span class="lbl">coords</span><span class="val">${p.lat.toFixed(2)}, ${p.lon.toFixed(2)}</span></div>
  `;
  sel.querySelector('.copy')?.addEventListener('click', (ev) => {
    const v = ev.currentTarget.dataset.copy;
    navigator.clipboard?.writeText(v);
    ev.currentTarget.textContent = 'copied';
    setTimeout(() => { ev.currentTarget.textContent = v; }, 900);
  });
}

canvas.addEventListener('click', (e) => {
  const hit = pickProxy();
  if (!hit) return;
  const p = STATE.lookups[hit.status][hit.instanceId];
  STATE.hovered = p;
  renderSelected(p);
  // copy IP:port to clipboard on click directly
  const proxy = `${p.ip}:${p.port}`;
  navigator.clipboard?.writeText(proxy);
  // briefly indicate via tooltip
  tooltip.innerHTML = `
    <div class="tt-row tt-ip">
      <span class="tt-status tt-${p.status}"></span>
      <span class="tt-proxy">${proxy}</span>
    </div>
    <div class="tt-row tt-meta"><span style="color:var(--neon-cyan);font-weight:600;">copied to clipboard</span></div>
  `;
  tooltip.style.opacity = '1';
  tooltip.style.left = (e.clientX + 14) + 'px';
  tooltip.style.top = (e.clientY + 14) + 'px';
});

// pulse hovered point + tooltip-like update on hover only when over a dot
let lastTipFrame = 0;
function maybeHoverTooltip(now) {
  if (now - lastTipFrame < 60) return;
  lastTipFrame = now;
  const hit = pickProxy();
  if (hit) {
    const p = STATE.lookups[hit.status][hit.instanceId];
    if (p) {
      showTooltip(p, lastClientX, lastClientY);
      if (!STATE.hovered || STATE.hovered.ip !== p.ip || STATE.hovered.port !== p.port) {
        STATE.hovered = p;
        renderSelected(p);
      }
    }
  } else {
    showTooltip(null);
  }
}

// ----------------------------------------------------------
// filter chips
// ----------------------------------------------------------
document.querySelectorAll('.chip').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.chip').forEach(b => b.classList.remove('on'));
    btn.classList.add('on');
    STATE.filter = btn.dataset.filter;
    applyFilter();
  });
});

function applyFilter() {
  const f = STATE.filter;
  for (const s of ['ok','weak','dead']) {
    const m = STATE.meshes[s];
    if (!m) continue;
    m.visible = (f === 'all') || (f === s);
  }
}

// ----------------------------------------------------------
// stats render
// ----------------------------------------------------------
function renderStats(d) {
  setText('ts', fmtTimestamp(d.generated_at));
  setText('total', `${d.proxies?.length ?? 0}`);
  setText('stat-ok', d.ok ?? 0);
  setText('stat-weak', d.weak ?? 0);
  setText('stat-dead', d.dead ?? 0);
  const byCC = {};
  for (const p of d.proxies || []) {
    if (!p.cc) continue;
    byCC[p.cc] = byCC[p.cc] || { name: p.country, n: 0 };
    byCC[p.cc].n += (p.status !== 'dead') ? 1 : 0;
  }
  const sortedCC = Object.entries(byCC)
    .filter(([_, v]) => v.n > 0)
    .sort((a, b) => b[1].n - a[1].n)
    .slice(0, 12);
  setText('stat-cc', sortedCC.length);
  const ol = document.getElementById('top-cc');
  ol.innerHTML = sortedCC.map(([cc, v]) =>
    `<li><span class="cc-name">${v.name} <span style="opacity:.55">${cc}</span></span><span class="cc-num">${v.n}</span></li>`
  ).join('');
}

// ----------------------------------------------------------
// resize handling — globe area only
// ----------------------------------------------------------
function resize() {
  const rect = canvas.parentElement.getBoundingClientRect();
  const w = Math.max(1, rect.width);
  const h = Math.max(1, rect.height);
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);

// ----------------------------------------------------------
// animation loop
// ----------------------------------------------------------
let t0 = performance.now();
function animate(now) {
  const dt = (now - t0) / 1000;
  t0 = now;
  controls.update();
  // pulsate dots
  for (const s of ['ok','weak','dead']) {
    const m = STATE.meshes[s];
    if (!m) continue;
    const k = s === 'ok' ? 1.0 : s === 'weak' ? 0.85 : 0.7;
    m.material.opacity = 0.65 + 0.35 * Math.abs(Math.sin(now / 600 * k));
  }
  maybeHoverTooltip(now);
  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}

// ----------------------------------------------------------
// boot
// ----------------------------------------------------------
let lastGeneratedAt = 0;

async function refreshData(initial = false) {
  const data = await loadData();
  if (!initial && data.generated_at === lastGeneratedAt) {
    return false;
  }
  lastGeneratedAt = data.generated_at;
  STATE.data = data;
  buildPoints(data.proxies || []);
  applyFilter();
  renderStats(data);
  // pulse the live indicator
  const dot = document.querySelector('.logo-dot');
  if (dot && !initial) {
    dot.style.animation = 'none';
    void dot.offsetWidth; // restart animation
    dot.style.animation = '';
    dot.style.background = 'var(--ok)';
    dot.style.boxShadow = '0 0 14px var(--ok), 0 0 28px var(--ok)';
    setTimeout(() => {
      dot.style.background = '';
      dot.style.boxShadow = '';
    }, 1100);
  }
  return true;
}

(async () => {
  resize();
  await refreshData(true);
  requestAnimationFrame(animate);
  // poll for fresh dataset every 60s — GitHub Actions refreshes data every 30 min
  setInterval(() => refreshData(false), 60 * 1000);
})();
