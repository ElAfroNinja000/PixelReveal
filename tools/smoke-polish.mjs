// Teste les features post-MVP : contribution perso (mine), curseurs relayés, mode spectateur
// (paint ignoré), galerie (sauvegarde à la complétion + lecture). Routes dev /__ws.

import WebSocket from "ws";

const HTTP = process.argv[2] ?? "http://127.0.0.1:8787";
const WSB = HTTP.replace(/^http/, "ws");
const fail = (m) => { console.error("FAIL:", m); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const room = (k) => `${WSB}/__ws?room=${encodeURIComponent(k)}`;
const send = (ws, o) => ws.send(JSON.stringify(o));

async function partA() {
  const KEY = "artwork-001#pol-" + Date.now();
  const painted = new Set();
  let cursorFrom = null;
  let mine = 0;

  const o = new WebSocket(room(KEY)); o.binaryType = "arraybuffer";
  o.on("open", () => send(o, { type: "hello", pseudo: "obs", sessionId: "obs1" }));
  o.on("message", (d, bin) => {
    if (bin) return;
    const m = JSON.parse(d.toString());
    if (m.type === "painted") painted.add(m.i);
    else if (m.type === "cursor") cursorFrom = m.pseudo;
  });

  const s = new WebSocket(room(KEY)); s.binaryType = "arraybuffer";
  s.on("open", () => send(s, { type: "hello", pseudo: "sammy", sessionId: "sam1" }));
  s.on("message", (d, bin) => { if (!bin) { const m = JSON.parse(d.toString()); if (m.type === "mine") mine = m.count; } });

  const v = new WebSocket(room(KEY)); v.binaryType = "arraybuffer";
  v.on("open", () => send(v, { type: "hello", pseudo: "spec", sessionId: "spec1", spectate: true }));

  await sleep(500);
  send(s, { type: "paint", i: 0 });      // joueur : révèle
  await sleep(300);
  send(v, { type: "paint", i: 1 });      // spectateur : doit être ignoré
  await sleep(300);
  send(s, { type: "cursor", x: 0.5, y: 0.5 }); // curseur relayé à o
  await sleep(400);

  if (mine < 1) fail(`mine attendu >=1, vu ${mine}`);
  if (!painted.has(0)) fail("painted i0 manquant");
  if (painted.has(1)) fail("spectateur a peint (i1 révélé) — guard KO");
  if (cursorFrom !== "sammy") fail(`curseur non relayé (vu ${cursorFrom})`);
  for (const w of [o, s, v]) w.close();
  console.log(`  partA OK — mine=${mine}, spectateur bloqué, curseur relayé`);
}

async function partB() {
  const KEY = "artwork-test#g" + Date.now();
  await new Promise((resolve) => {
    const ws = new WebSocket(room(KEY)); ws.binaryType = "arraybuffer";
    let total = 0, next = 0;
    ws.on("open", () => send(ws, { type: "hello", pseudo: "painter", sessionId: "paint-g" }));
    ws.on("message", (d, bin) => {
      if (bin) return;
      const m = JSON.parse(d.toString());
      if (m.type === "welcome") { total = m.progress.total; send(ws, { type: "paint", i: next++ }); }
      else if (m.type === "cooldown") { if (next < total) setTimeout(() => send(ws, { type: "paint", i: next++ }), Math.max(0, m.until - Date.now()) + 60); }
      else if (m.type === "completed") { ws.close(); resolve(); }
    });
  });

  const list = await (await fetch(`${HTTP}/gallery`)).json();
  if (!list.some((e) => e.key === KEY)) fail("œuvre absente de /gallery");
  const item = await (await fetch(`${HTTP}/gallery/item?key=${encodeURIComponent(KEY)}`)).json();
  if (item.width !== 2 || item.height !== 2 || item.answer.length !== 4) fail("image galerie incorrecte");
  console.log(`  partB OK — galerie contient ${KEY} (${item.width}x${item.height})`);
}

(async () => {
  await partA();
  await partB();
  console.log("OK — polish (mine, curseurs, spectateur, galerie)");
  process.exit(0);
})().catch((e) => fail(e.message));

setTimeout(() => fail("timeout global"), 25000);
