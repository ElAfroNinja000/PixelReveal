// Anti-bot : un script qui tourne les sessionId (1 socket = 1 session jetable) depuis une
// seule IP ne doit PAS dépasser le rate-limit. Sans limite IP, 40 sockets => ~40 reveals
// instantanés ; avec le token bucket par IP (burst 5), seuls ~5 passent. (cf. §9)
//
// Room dev fraîche (lap unique) via /__ws pour partir d'un canvas vierge.

import WebSocket from "ws";

const HTTP = process.argv[2] ?? "http://127.0.0.1:8787";
const ROOM = "artwork-001#bot-" + Date.now(); // même artworkId, instance DO neuve (vierge)
const WS = `${HTTP.replace(/^http/, "ws")}/__ws?room=${encodeURIComponent(ROOM)}`;
const N = 40;
const fail = (m) => { console.error("FAIL:", m); process.exit(1); };

const painted = new Set(); // index distincts révélés (vus par l'observateur)

for (let k = 0; k < N; k++) {
  const ws = new WebSocket(WS);
  ws.binaryType = "arraybuffer";
  ws.on("open", () =>
    ws.send(JSON.stringify({ type: "hello", pseudo: "bot" + k, sessionId: "throwaway-" + k + "-" + Math.random() })),
  );
  ws.on("error", () => {});
  ws.on("message", (data, isBinary) => {
    if (isBinary) return;
    const m = JSON.parse(data.toString());
    if (m.type === "welcome") ws.send(JSON.stringify({ type: "paint", i: k })); // chacun son pixel
    else if (m.type === "painted") painted.add(m.i); // broadcast à toute la room
  });
}

setTimeout(() => {
  const n = painted.size;
  // Marge : burst 5 + quelques recharges pendant la fenêtre. Doit rester très en dessous de N.
  if (n < 1) fail("aucun reveal (room/route KO ?)");
  if (n > 10) fail(`rate-limit IP inefficace : ${n} reveals sur ${N} sessions (attendu <= ~burst)`);
  console.log(`OK — ${N} sessions mono-IP -> ${n} reveals seulement (rate-limit IP actif)`);
  process.exit(0);
}, 2500);

setTimeout(() => fail("timeout"), 8000);
