// PixelReveal — front. Source de vérité = serveur ; ce client n'est qu'une vue (cf. §4.2).
const $ = (id) => document.getElementById(id);
const UNREVEALED = 0xff;
const BG = [13, 13, 13]; // pixel non révélé = fond

// URL du worker WS. En local on tape le dev (8787) ; en prod, même host en wss.
// Override possible via ?ws=… pour les tests.
const WS_URL =
  new URLSearchParams(location.search).get("ws") ||
  (/^(localhost|127\.0\.0\.1)$/.test(location.hostname) || location.protocol === "file:"
    ? "ws://127.0.0.1:8787/ws"
    : `wss://${location.host}/ws`);

// --- Identité (sans auth) : pseudo + sessionId persistés (cf. §4.6) ---
const store = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
const load = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
function uuid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}
let sessionId = load("pixelreveal.sessionId");
if (!sessionId) { sessionId = uuid(); store("pixelreveal.sessionId", sessionId); }
let pseudo = load("pixelreveal.pseudo") || "";
$("pseudo").value = pseudo;

// --- État de rendu ---
let ws = null, ctx = null, fxCtx = null, img = null;
let W = 0, H = 0, total = 0, palette = [];
let cooldownUntil = 0;

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

function setPixel(i, c) {
  const [r, g, b] = c === UNREVEALED ? BG : (palette[c] ? hex(palette[c]) : BG);
  const o = i * 4;
  img.data[o] = r; img.data[o + 1] = g; img.data[o + 2] = b; img.data[o + 3] = 255;
}

function drawSnapshot(bytes) {
  img = ctx.createImageData(W, H);
  for (let i = 0; i < total; i++) setPixel(i, bytes[i]);
  ctx.putImageData(img, 0, 0);
}

function setProgress(rev, tot) {
  const pct = tot ? (rev / tot) * 100 : 0;
  $("fill").style.width = pct + "%";
  $("pct").textContent = (Math.round(pct * 10) / 10) + "%";
}

// --- Feedback sensoriel : flash transient sur le pixel déposé (couche fx) (cf. §8) ---
const flashes = [];
function flashPixel(i) {
  flashes.push({ x: i % W, y: (i / W) | 0, t: performance.now() });
  if (flashes.length === 1) requestAnimationFrame(renderFx);
}
function renderFx(now) {
  fxCtx.clearRect(0, 0, W, H);
  for (let k = flashes.length - 1; k >= 0; k--) {
    const f = flashes[k];
    const age = (now - f.t) / 320;
    if (age >= 1) { flashes.splice(k, 1); continue; }
    fxCtx.fillStyle = `rgba(255,255,255,${(1 - age) * 0.8})`;
    fxCtx.fillRect(f.x, f.y, 1, 1);
  }
  if (flashes.length) requestAnimationFrame(renderFx);
  else fxCtx.clearRect(0, 0, W, H);
}

// --- Cooldown visuel ---
function tickCooldown() {
  const left = cooldownUntil - Date.now();
  const cv = $("cv");
  if (left > 0) {
    $("cool").textContent = `⏳ ${(left / 1000).toFixed(1)}s`;
    cv.classList.add("cooling");
    requestAnimationFrame(tickCooldown);
  } else {
    $("cool").textContent = "";
    cv.classList.remove("cooling");
  }
}

// --- Connexion / cycle de vie ---
function connect() {
  ws = new WebSocket(WS_URL);
  ws.binaryType = "arraybuffer";
  ws.onopen = () => ws.send(JSON.stringify({ type: "hello", pseudo, sessionId }));
  ws.onmessage = onMessage;
  ws.onclose = () => { $("online").textContent = "0"; };
}

function onMessage(ev) {
  if (ev.data instanceof ArrayBuffer) { drawSnapshot(new Uint8Array(ev.data)); return; }
  const m = JSON.parse(ev.data);
  switch (m.type) {
    case "welcome": {
      W = m.width; H = m.height; total = W * H; palette = m.palette;
      for (const id of ["cv", "fx"]) { const c = $(id); c.width = W; c.height = H; }
      ctx = $("cv").getContext("2d");
      fxCtx = $("fx").getContext("2d");
      drawSnapshot(new Uint8Array(total).fill(UNREVEALED)); // noir en attendant le snapshot binaire
      setProgress(m.progress.revealed, m.progress.total);
      $("online").textContent = m.online;
      break;
    }
    case "painted":
      setPixel(m.i, m.c);
      ctx.putImageData(img, 0, 0); // delta : un seul pixel repeint (cf. §8)
      flashPixel(m.i);
      break;
    case "progress": setProgress(m.revealed, m.total); break;
    case "online": $("online").textContent = m.count; break;
    case "cooldown": cooldownUntil = m.until; tickCooldown(); break;
    case "completed": onCompleted(m.ranking || []); break;
  }
}

// --- Beat de complétion + bascule partagée (reconnexion) (cf. §4.7) ---
let beatTimer = null;
function onCompleted(ranking) {
  document.body.classList.add("flash");
  setTimeout(() => document.body.classList.remove("flash"), 600);
  $("ranking").innerHTML = ranking.map((r) => `<li><b>${esc(r.pseudo)}</b> — ${r.count}</li>`).join("");
  $("done").hidden = false;
  clearTimeout(beatTimer);
  beatTimer = setTimeout(advance, 6000); // timeout du beat → bascule auto
}
function advance() {
  clearTimeout(beatTimer);
  $("done").hidden = true;
  try { ws.close(); } catch {}
  connect(); // reconnexion → le coordinateur aiguille sur la frontière avancée
}
const esc = (s) => s.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));

// --- Interactions ---
$("loginForm").addEventListener("submit", (e) => {
  e.preventDefault();
  pseudo = $("pseudo").value.trim() || "anon";
  store("pixelreveal.pseudo", pseudo);
  $("login").hidden = true;
  $("hud").hidden = false;
  $("stage").hidden = false;
  connect();
});

$("next").addEventListener("click", advance);

$("cv").addEventListener("click", (e) => {
  if (!ws || ws.readyState !== 1 || Date.now() < cooldownUntil) return;
  const r = e.currentTarget.getBoundingClientRect();
  const x = Math.floor(((e.clientX - r.left) / r.width) * W);
  const y = Math.floor(((e.clientY - r.top) / r.height) * H);
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  ws.send(JSON.stringify({ type: "paint", i: y * W + x }));
});
