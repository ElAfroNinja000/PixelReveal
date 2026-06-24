// Smoke-test du flux WebSocket de la room (phase 3), à lancer contre `wrangler dev`.
// Vérifie : welcome + snapshot binaire, paint -> painted/progress, cooldown serveur 2s,
// pixel figé (re-paint ignoré). Sort 0 si tout passe, 1 sinon.
//
// Usage : node tools/smoke-ws.mjs [ws://127.0.0.1:8787/ws]

import WebSocket from "ws";

const URL = process.argv[2] ?? "ws://127.0.0.1:8787/ws";
const SESSION = "smoke-" + Math.random().toString(36).slice(2);
const fail = (m) => {
  console.error("FAIL:", m);
  process.exit(1);
};

const ws = new WebSocket(URL);
ws.binaryType = "arraybuffer";

let welcome = null;
let snapshot = null;
const painted = [];
let progress = null;
let cooldownRejects = 0;
let total = 0;

const send = (o) => ws.send(JSON.stringify(o));

ws.on("open", () => send({ type: "hello", pseudo: "smoke", sessionId: SESSION }));

ws.on("message", (data, isBinary) => {
  if (isBinary) {
    snapshot = new Uint8Array(data);
    return;
  }
  const msg = JSON.parse(data.toString());
  if (msg.type === "welcome") {
    welcome = msg;
    total = msg.progress.total;
    // 1er clic sur un pixel non révélé
    send({ type: "paint", i: 0 });
    // 2e clic immédiat : doit être rejeté par le cooldown
    setTimeout(() => send({ type: "paint", i: 1 }), 50);
    // re-clic du pixel déjà révélé après cooldown : doit être ignoré (no painted)
    setTimeout(() => send({ type: "paint", i: 0 }), 2100);
    // fin du test
    setTimeout(() => finish(), 2600);
  } else if (msg.type === "painted") {
    painted.push(msg);
  } else if (msg.type === "progress") {
    progress = msg;
  } else if (msg.type === "cooldown") {
    if (msg.until > Date.now() + 1000) cooldownRejects++; // un rejet repousse ~2s
  }
});

ws.on("error", (e) => fail("ws error: " + e.message));

function finish() {
  if (!welcome) fail("pas de welcome");
  if (!snapshot || snapshot.length !== total) fail(`snapshot taille ${snapshot?.length} != ${total}`);
  if (welcome.palette?.length < 2) fail("palette vide");
  if (painted.length !== 1) fail(`painted attendu 1, reçu ${painted.length} (cooldown/figé KO)`);
  if (painted[0].i !== 0) fail("painted index inattendu");
  if (!progress || progress.revealed < 1) fail("progress KO");
  if (cooldownRejects < 1) fail("aucun rejet cooldown détecté");
  console.log(
    `OK — welcome ${welcome.width}x${welcome.height}, palette ${welcome.palette.length}, ` +
      `snapshot ${snapshot.length}, painted ${painted.length}, progress ${progress.revealed}/${progress.total}, ` +
      `rejets cooldown ${cooldownRejects}`,
  );
  ws.close();
  process.exit(0);
}

setTimeout(() => fail("timeout global"), 8000);
