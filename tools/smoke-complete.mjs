// Teste le chemin de complétion (phase 5) : peint un mini artwork 2x2 à 100% et vérifie
// que le serveur diffuse `completed` avec le classement (ranking) par pseudo.
// Route dev /__ws pour cibler artwork-test sans toucher la frontière. ~8s (cooldown 2s/clic).

import WebSocket from "ws";

const HTTP = process.argv[2] ?? "http://127.0.0.1:8787";
const ROOM = "artwork-test#" + Date.now(); // lap unique -> room vierge à chaque run
const WS = `${HTTP.replace(/^http/, "ws")}/__ws?room=${encodeURIComponent(ROOM)}`;
const fail = (m) => { console.error("FAIL:", m); process.exit(1); };

const ws = new WebSocket(WS);
ws.binaryType = "arraybuffer";
let total = 0, nextIdx = 0, completed = null;

ws.on("open", () => ws.send(JSON.stringify({ type: "hello", pseudo: "tester", sessionId: "complete-1" })));
ws.on("error", (e) => fail("ws: " + e.message));
ws.on("message", (data, isBinary) => {
  if (isBinary) return;
  const m = JSON.parse(data.toString());
  if (m.type === "welcome") {
    total = m.progress.total;
    paintNext();
  } else if (m.type === "cooldown") {
    // ack reçu : on programme le clic suivant juste après l'échéance
    const wait = Math.max(0, m.until - Date.now()) + 60;
    if (nextIdx < total) setTimeout(paintNext, wait);
  } else if (m.type === "completed") {
    completed = m;
    check();
  }
});

function paintNext() {
  if (nextIdx >= total) return;
  ws.send(JSON.stringify({ type: "paint", i: nextIdx++ }));
}

function check() {
  if (!completed) fail("pas de completed");
  if (!Array.isArray(completed.ranking) || completed.ranking.length === 0) fail("ranking vide");
  const top = completed.ranking[0];
  if (top.pseudo !== "tester") fail(`top pseudo ${top.pseudo} != tester`);
  if (top.count !== total) fail(`top count ${top.count} != ${total}`);
  console.log(`OK — completed reçu, ranking[0] = ${top.pseudo}:${top.count}/${total}`);
  ws.close();
  process.exit(0);
}

setTimeout(() => fail("timeout (completion trop lente ?)"), 20000);
