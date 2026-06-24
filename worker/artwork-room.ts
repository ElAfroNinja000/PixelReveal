import type { Env } from "./env";
import { loadAsset } from "./assets";
import {
  COOLDOWN_MS,
  UNREVEALED,
  encode,
  type ClientMessage,
  type HelloMsg,
  type PaintMsg,
  type WelcomeMsg,
} from "./protocol";

/** Identité attachée à chaque socket, survit à l'hibernation via (de)serializeAttachment. */
interface Identity {
  sessionId: string;
  pseudo: string;
}

// Phase 3 : une seule room. Le pipeline (plusieurs artworks) arrive en phase 4 (coordinateur).
const ARTWORK_ID = "artwork-001";

/**
 * Durable Object : une room = un artwork (cf. §4.1).
 *
 * Mono-thread : toutes les écritures (paint, cooldown) sont sérialisées par le runtime DO,
 * donc pas de race condition sur `revealed`/`revealedCount`. Le serveur est seule autorité :
 * il détient `answer` (jamais envoyé en bloc) et ne révèle la couleur qu'au clic (§4.2/§4.3).
 *
 * WebSockets via l'API Hibernation : le DO peut s'endormir sockets ouverts puis reprendre
 * sans perdre l'état persisté (§4.5).
 */
export class ArtworkRoom implements DurableObject {
  private loaded = false;
  private width = 0;
  private height = 0;
  private palette: string[] = [];
  private answer = new Uint8Array(0);
  private revealed = new Uint8Array(0); // 0xFF = non révélé, sinon index palette ; persisté
  private revealedCount = 0;
  private readonly cooldowns = new Map<string, number>(); // sessionId -> ts dernier clic accepté
  private readonly tally = new Map<string, number>(); // pseudo -> pixels révélés

  // env (COORDINATOR) sera utilisé en phase 4 pour la transition. Pas nécessaire au MVP room.
  constructor(
    private readonly ctx: DurableObjectState,
    _env: Env,
  ) {}

  /**
   * Charge l'asset (answer + palette) et restaure l'état persisté (revealed + tally).
   * Idempotent et sérialisé via blockConcurrencyWhile pour éviter un double chargement
   * si plusieurs requêtes arrivent avant la fin du boot.
   */
  private async init(): Promise<void> {
    if (this.loaded) return;
    await this.ctx.blockConcurrencyWhile(async () => {
      if (this.loaded) return;

      const asset = loadAsset(ARTWORK_ID); // bundlé côté serveur, jamais exposé au client
      this.width = asset.width;
      this.height = asset.height;
      this.palette = asset.palette;
      this.answer = Uint8Array.from(asset.answer);

      const total = this.width * this.height;
      this.revealed = new Uint8Array(total).fill(UNREVEALED);

      // Reprise : rejoue les pixels déjà révélés persistés (clé `px:<i>` -> index couleur).
      const px = await this.ctx.storage.list<number>({ prefix: "px:" });
      for (const [key, c] of px) {
        const i = Number(key.slice(3));
        if (i >= 0 && i < total && this.revealed[i] === UNREVEALED) {
          this.revealed[i] = c;
          this.revealedCount++;
        }
      }
      // Reprise du classement (clé `ty:<pseudo>` -> compteur).
      const ty = await this.ctx.storage.list<number>({ prefix: "ty:" });
      for (const [key, n] of ty) this.tally.set(key.slice(3), n);

      this.loaded = true;
    });
  }

  /** Point d'entrée : upgrade WebSocket uniquement. */
  async fetch(req: Request): Promise<Response> {
    await this.init();
    if (req.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server); // hibernation : pas de handler en mémoire à garder vivant
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    await this.init(); // le DO a pu hiberner entre l'open et ce message
    if (typeof data !== "string") return; // le client n'émet que du JSON (paint/hello)
    let msg: ClientMessage;
    try {
      msg = JSON.parse(data) as ClientMessage;
    } catch {
      return; // message illisible : on ignore, jamais d'état "faux" (§2)
    }
    if (msg.type === "hello") this.onHello(ws, msg);
    else if (msg.type === "paint") this.onPaint(ws, msg);
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    try {
      ws.close();
    } catch {
      /* déjà fermé */
    }
    this.broadcastOnline(); // un joueur de moins
  }

  async webSocketError(_ws: WebSocket): Promise<void> {
    this.broadcastOnline();
  }

  /** hello : enregistre l'identité puis envoie welcome (méta) + snapshot binaire. */
  private onHello(ws: WebSocket, msg: HelloMsg): void {
    const identity: Identity = { sessionId: msg.sessionId, pseudo: msg.pseudo };
    ws.serializeAttachment(identity); // réattaché automatiquement après hibernation

    const welcome: WelcomeMsg = {
      type: "welcome",
      artworkId: ARTWORK_ID,
      width: this.width,
      height: this.height,
      palette: this.palette,
      progress: { revealed: this.revealedCount, total: this.width * this.height },
      online: this.online(),
    };
    ws.send(encode(welcome));
    // Snapshot = un octet par pixel, en frame binaire (jamais en JSON, trop gros — §6/§8).
    // On copie pour éviter d'exposer/figer le buffer interne.
    ws.send(this.revealed.slice());

    this.broadcastOnline(); // signale le nouvel arrivant aux autres
  }

  /** paint : cooldown serveur -> révélation -> persistance -> broadcast (§4.4). */
  private onPaint(ws: WebSocket, msg: PaintMsg): void {
    const identity = ws.deserializeAttachment() as Identity | null;
    if (!identity) return; // paint avant hello : ignoré

    const total = this.width * this.height;
    const i = msg.i;
    if (!Number.isInteger(i) || i < 0 || i >= total) return; // index hors grille

    const now = Date.now();
    const last = this.cooldowns.get(identity.sessionId) ?? 0;
    if (now - last < COOLDOWN_MS) {
      // Trop tôt : rejet. Pièce maîtresse anti-bot (§9). On renvoie l'échéance au client.
      ws.send(encode({ type: "cooldown", until: last + COOLDOWN_MS }));
      return;
    }
    if (this.revealed[i] !== UNREVEALED) {
      // Pixel déjà figé (§2) : no-op, et on ne brûle pas le cooldown pour un clic inutile.
      return;
    }

    // Révélation : la couleur vient de answer (vérité serveur), jamais du client.
    const c = this.answer[i];
    this.revealed[i] = c;
    this.revealedCount++;
    this.cooldowns.set(identity.sessionId, now);
    const n = (this.tally.get(identity.pseudo) ?? 0) + 1;
    this.tally.set(identity.pseudo, n);

    // Persistance incrémentale : un petit put par pixel plutôt que réécrire 90k octets/clic.
    void this.ctx.storage.put(`px:${i}`, c);
    void this.ctx.storage.put(`ty:${identity.pseudo}`, n);

    // Ack au cliqueur + diffusion du delta et de la progression à toute la room.
    ws.send(encode({ type: "cooldown", until: now + COOLDOWN_MS }));
    this.broadcast({ type: "painted", i, c, pseudo: identity.pseudo });
    this.broadcast({ type: "progress", revealed: this.revealedCount, total });

    // 100% atteint : beat de complétion. Le coordinateur (phase 4) enchaînera le welcome suivant.
    if (this.revealedCount === total) this.broadcast({ type: "completed" });
  }

  private online(): number {
    return this.ctx.getWebSockets().length;
  }

  private broadcastOnline(): void {
    this.broadcast({ type: "online", count: this.online() });
  }

  /** Diffuse un message JSON à tous les sockets de la room. */
  private broadcast(msg: Parameters<typeof encode>[0]): void {
    const payload = encode(msg);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(payload);
      } catch {
        /* socket en cours de fermeture : ignoré */
      }
    }
  }
}
