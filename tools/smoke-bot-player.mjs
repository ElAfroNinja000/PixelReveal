// Vérifie le joueur bot : on connecte un joueur (sans peindre) et on attend des `painted`
// émis par le bot (pseudo "🤖 Bot...") + une progression > 0.
import WebSocket from "ws";

const HTTP = process.argv[2] ?? "http://127.0.0.1:8787";
const ROOM = "artwork-001#botplayer-" + Date.now();
const WS = `${HTTP.replace(/^http/, "ws")}/__ws?room=${encodeURIComponent(ROOM)}`;
const fail = (m) => { console.error("FAIL:", m); process.exit(1); };

const ws = new WebSocket(WS);
ws.binaryType = "arraybuffer";
const botPaints = [];

ws.on("open", () => ws.send(JSON.stringify({ type: "hello", pseudo: "human", sessionId: "h1" })));
ws.on("error", (e) => fail("ws: " + e.message));
ws.on("message", (d, bin) => {
  if (bin) return;
  const m = JSON.parse(d.toString());
  if (m.type === "painted" && m.pseudo && m.pseudo.startsWith("🤖")) botPaints.push(m);
});

// Bot tick = 1500ms ; on attend ~5s -> au moins 2 reveals du bot attendus.
setTimeout(() => {
  if (botPaints.length < 2) fail(`bot a peint ${botPaints.length} pixels (attendu >=2)`);
  console.log(`OK — bot "${botPaints[0].pseudo}" a peint ${botPaints.length} pixels sans intervention humaine`);
  ws.close();
  process.exit(0);
}, 5500);

setTimeout(() => fail("timeout"), 9000);
