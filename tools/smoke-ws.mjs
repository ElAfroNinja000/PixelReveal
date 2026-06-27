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

let pxA = -1, pxB = -1;

ws.on("message", (data, isBinary) => {
  if (isBinary) {
    snapshot = new Uint8Array(data);
    // Choisit deux pixels NON révélés (robuste à l'état déjà entamé de la room).
    for (let i = 0; i < snapshot.length && (pxA < 0 || pxB < 0); i++) {
      if (snapshot[i] === 0xff) {
        if (pxA < 0) pxA = i;
        else pxB = i;
      }
    }
    if (pxA < 0) return fail("aucun pixel non révélé (room déjà à 100%)");
    send({ type: "paint", i: pxA }); // 1er clic : doit révéler
    setTimeout(() => send({ type: "paint", i: pxB }), 50); // immédiat : rejeté par cooldown
    setTimeout(() => send({ type: "paint", i: pxA }), 2100); // pixel figé : ignoré
    setTimeout(() => finish(), 2600);
    return;
  }
  const msg = JSON.parse(data.toString());
  if (msg.type === "welcome") {
    welcome = msg;
    total = msg.progress.total;
  } else if (msg.type === "painted") {
    if (msg.pseudo === "smoke") painted.push(msg); // ignore les pixels du bot
  } else if (msg.type === "progress") {
    progress = msg;
  } else if (msg.type === "cooldown") {
    if (msg.until > Date.now() + 400) cooldownRejects++; // cooldown actif (ack ou rejet)
  }
});

ws.on("error", (e) => fail("ws error: " + e.message));

function finish() {
  if (!welcome) fail("pas de welcome");
  if (!snapshot || snapshot.length !== total) fail(`snapshot taille ${snapshot?.length} != ${total}`);
  if (welcome.palette?.length < 2) fail("palette vide");
  if (painted.length !== 1) fail(`painted attendu 1, reçu ${painted.length} (cooldown/figé KO)`);
  if (painted[0].i !== pxA) fail(`painted index ${painted[0].i} != ${pxA}`);
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
