// Vérifie la reprise : après redémarrage du worker, le snapshot doit conserver les pixels
// déjà révélés (persistés en DO storage). On suppose qu'au moins le pixel 0 a été peint avant.
import WebSocket from "ws";

const URL = process.argv[2] ?? "ws://127.0.0.1:8787/ws";
const ws = new WebSocket(URL);
ws.binaryType = "arraybuffer";
let welcome = null;

ws.on("open", () => ws.send(JSON.stringify({ type: "hello", pseudo: "reprise", sessionId: "r1" })));
ws.on("message", (data, isBinary) => {
  if (!isBinary) {
    welcome = JSON.parse(data.toString());
    return;
  }
  const snap = new Uint8Array(data);
  const px0 = snap[0];
  const revealed = welcome?.progress?.revealed ?? 0;
  if (px0 !== 0xff && revealed >= 1) {
    console.log(`OK reprise — pixel0=${px0} (révélé), progress ${revealed}/${welcome.progress.total}`);
    process.exit(0);
  }
  console.error(`FAIL reprise — pixel0=${px0} (0xFF=non révélé), revealed=${revealed}`);
  process.exit(1);
});
ws.on("error", (e) => {
  console.error("ws error", e.message);
  process.exit(1);
});
setTimeout(() => {
  console.error("timeout");
  process.exit(1);
}, 8000);
