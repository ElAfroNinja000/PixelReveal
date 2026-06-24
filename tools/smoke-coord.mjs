// Smoke-test du coordinateur (phase 4), contre `npm run dev` (routes __ activées en dev).
// Vérifie : routage /ws -> frontière, online global agrégé (2 sockets), avance + cycle (lap++).
// Sort 0 si tout passe, 1 sinon.

import WebSocket from "ws";

const HTTP = process.argv[2] ?? "http://127.0.0.1:8787";
const WS = HTTP.replace(/^http/, "ws") + "/ws";
const fail = (m) => {
  console.error("FAIL:", m);
  process.exit(1);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lap = (roomKey) => Number(roomKey.split("#")[1]);

// Ouvre un socket, envoie hello à l'open, suit le dernier `online` reçu + le welcome.
function connect(id) {
  const ws = new WebSocket(WS);
  ws.binaryType = "arraybuffer";
  const h = { ws, welcome: null, online: 0 };
  ws.on("open", () => ws.send(JSON.stringify({ type: "hello", pseudo: id, sessionId: "s_" + id })));
  ws.on("message", (data, isBinary) => {
    if (isBinary) return;
    const m = JSON.parse(data.toString());
    if (m.type === "welcome") h.welcome = m;
    else if (m.type === "online") h.online = m.count;
  });
  return h;
}

async function main() {
  // 1) Routage : /ws aboutit à la frontière, welcome porte un artworkId.
  const a = connect("A");
  await sleep(500);
  if (!a.welcome) fail("pas de welcome (routage /ws KO)");
  if (typeof a.welcome.artworkId !== "string") fail("welcome sans artworkId");
  const artworkId = a.welcome.artworkId;

  // 2) Online global : 2e socket -> le 1er doit voir online == 2, puis 1 après fermeture.
  const b = connect("B");
  await sleep(500);
  if (a.online !== 2) fail(`online global attendu 2, vu ${a.online}`);
  b.ws.close();
  await sleep(500);
  if (a.online !== 1) fail(`online global attendu 1 après close, vu ${a.online}`);
  a.ws.close();

  // 3) Avance + cycle via routes de diagnostic (pas besoin de peindre 90k pixels).
  const f0 = await (await fetch(`${HTTP}/__frontier`)).json();
  const adv = (roomKey) =>
    fetch(`${HTTP}/__advance`, { method: "POST", body: JSON.stringify({ roomKey }) }).then((r) => r.json());

  const f1 = await adv(f0.roomKey);
  // Pipeline à un seul artwork -> l'avance cycle : même artworkId, lap incrémenté (canvas vierge).
  if (f1.artworkId !== f0.artworkId) fail(`cycle: artworkId changé ${f0.artworkId}->${f1.artworkId}`);
  if (lap(f1.roomKey) !== lap(f0.roomKey) + 1) fail(`cycle: lap ${lap(f0.roomKey)}->${lap(f1.roomKey)} (attendu +1)`);

  // Avance avec un roomKey périmé : idempotent, frontière inchangée.
  const stale = await adv("artwork-xxx#999");
  if (stale.roomKey !== f1.roomKey) fail(`idempotence KO: ${f1.roomKey} -> ${stale.roomKey}`);

  // Nouvelle avance valide : lap encore +1.
  const f2 = await adv(f1.roomKey);
  if (lap(f2.roomKey) !== lap(f1.roomKey) + 1) fail(`2e cycle: lap ${lap(f1.roomKey)}->${lap(f2.roomKey)}`);

  console.log(
    `OK — routage(${artworkId}), online global 2->1, cycle lap ${lap(f0.roomKey)}->${lap(f1.roomKey)}->${lap(f2.roomKey)}, idempotence OK`,
  );
  process.exit(0);
}

main().catch((e) => fail(e.message));
setTimeout(() => fail("timeout global"), 10000);
