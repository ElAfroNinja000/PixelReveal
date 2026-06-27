import type { Env } from "./env";
import { loadAsset } from "./assets";
import {
  COOLDOWN_MS,
  UNREVEALED,
  encode,
  type ClientMessage,
  type CursorMsg,
  type HelloMsg,
  type PaintMsg,
  type WelcomeMsg,
} from "./protocol";

/** Identité attachée à chaque socket, survit à l'hibernation via (de)serializeAttachment. */
interface Identity {
  ip: string;
  sessionId: string;
  pseudo: string;
  spectate?: boolean;
}

/** Token bucket par IP (cf. ipBucket). */
const IP_BURST = 5;
const IP_REFILL_MS = 1000;

/** Joueur bot : révèle 1 pixel par tick (via DO alarm). Dort si aucun joueur connecté. */
const BOT_INTERVAL_MS = 1500;

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
  private roomKey = ""; // ex: "artwork-001#0" (artworkId + lap) — identité de cette room
  private artworkId = "";
  private width = 0;
  private height = 0;
  private palette: string[] = [];
  private answer = new Uint8Array(0);
  private revealed = new Uint8Array(0); // 0xFF = non révélé, sinon index palette ; persisté
  private revealedCount = 0;
  private readonly cooldowns = new Map<string, number>(); // sessionId -> ts dernier clic accepté
  private readonly tally = new Map<string, number>(); // pseudo -> pixels révélés
  // Rate-limit par IP : token bucket. Ferme le trou « 1 sessionId jetable par clic » d'un bot
  // mono-IP (le cooldown par session ne suffit pas si le bot tourne les sessions). Bucket
  // généreux pour ne pas pénaliser un NAT partagé : burst 5, recharge 1 jeton/s.
  private readonly ipBucket = new Map<string, { tokens: number; ts: number }>();
  private botName = ""; // pseudo auto du joueur bot (persisté)

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {}

  /**
   * Charge l'asset (answer + palette) et restaure l'état persisté (revealed + tally).
   * Idempotent et sérialisé via blockConcurrencyWhile pour éviter un double chargement
   * si plusieurs requêtes arrivent avant la fin du boot.
   */
  private async init(roomKeyParam?: string | null): Promise<void> {
    if (this.loaded) return;
    await this.ctx.blockConcurrencyWhile(async () => {
      if (this.loaded) return;

      // L'identité de la room (roomKey) arrive en paramètre à la 1re connexion, puis est
      // persistée : après hibernation, on la relit du storage sans dépendre de la requête.
      let rk = await this.ctx.storage.get<string>("roomKey");
      if (!rk && roomKeyParam) {
        rk = roomKeyParam;
        await this.ctx.storage.put("roomKey", rk);
      }
      if (!rk) throw new Error("roomKey manquant (room non initialisée)");
      this.roomKey = rk;
      this.artworkId = rk.split("#")[0]; // "artwork-001#0" -> "artwork-001"

      const asset = loadAsset(this.artworkId); // bundlé côté serveur, jamais exposé au client
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

      // Pseudo auto du bot, stable sur la durée de vie de la room.
      let bn = await this.ctx.storage.get<string>("botName");
      if (!bn) {
        bn = `🤖 Bot${Math.floor(1000 + Math.random() * 9000)}`;
        await this.ctx.storage.put("botName", bn);
      }
      this.botName = bn;

      this.loaded = true;
    });
  }

  /** Point d'entrée : upgrade WebSocket uniquement. `?room=` porte l'identité (roomKey). */
  async fetch(req: Request): Promise<Response> {
    await this.init(new URL(req.url).searchParams.get("room"));
    if (req.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server); // hibernation : pas de handler en mémoire à garder vivant
    // IP connue dès l'upgrade (header Cloudflare) ; stockée sur le socket pour le rate-limit.
    const ip = req.headers.get("cf-connecting-ip") ?? "local";
    server.serializeAttachment({ ip });
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
    if (msg.type === "hello") await this.onHello(ws, msg);
    else if (msg.type === "paint") await this.onPaint(ws, msg);
    else if (msg.type === "cursor") this.onCursor(ws, msg);
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    try {
      ws.close();
    } catch {
      /* déjà fermé */
    }
    // Le socket qui se ferme est encore listé par getWebSockets() pendant ce handler : on l'exclut.
    await this.reportOnline(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.reportOnline(ws);
  }

  /** hello : enregistre l'identité puis envoie welcome (méta) + snapshot binaire. */
  private async onHello(ws: WebSocket, msg: HelloMsg): Promise<void> {
    const prev = (ws.deserializeAttachment() as Partial<Identity> | null) ?? {};
    const identity: Identity = {
      ip: prev.ip ?? "local",
      sessionId: msg.sessionId,
      pseudo: msg.pseudo,
      spectate: msg.spectate === true,
    };
    ws.serializeAttachment(identity); // réattaché automatiquement après hibernation

    const welcome: WelcomeMsg = {
      type: "welcome",
      artworkId: this.artworkId,
      width: this.width,
      height: this.height,
      palette: this.palette,
      progress: { revealed: this.revealedCount, total: this.width * this.height },
      online: this.localOnline(),
    };
    ws.send(encode(welcome));
    // Snapshot = un octet par pixel, en frame binaire (jamais en JSON, trop gros — §6/§8).
    // On copie pour éviter d'exposer/figer le buffer interne.
    ws.send(this.revealed.slice());
    ws.send(encode({ type: "mine", count: this.tally.get(msg.pseudo) ?? 0 })); // contribution restaurée

    await this.reportOnline(); // signale le nouvel arrivant + diffuse le total global
    await this.ensureBotAlarm(); // un joueur est là -> le bot peut jouer
  }

  /** paint : cooldown serveur -> révélation -> persistance -> broadcast (§4.4). */
  private async onPaint(ws: WebSocket, msg: PaintMsg): Promise<void> {
    const identity = ws.deserializeAttachment() as Identity | null;
    if (!identity) return; // paint avant hello : ignoré
    if (identity.spectate) return; // spectateur : ne peint pas (post-MVP)

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
    if (!this.allowIp(identity.ip)) {
      // Rate-limit IP dépassé : rejet (anti-bot multi-sessions mono-IP, §9).
      ws.send(encode({ type: "cooldown", until: now + IP_REFILL_MS }));
      return;
    }

    // Révélation (cœur partagé joueur/bot) + ack cooldown + contribution perso.
    this.cooldowns.set(identity.sessionId, now);
    const n = await this.applyReveal(i, identity.pseudo);
    ws.send(encode({ type: "cooldown", until: now + COOLDOWN_MS }));
    ws.send(encode({ type: "mine", count: n }));
  }

  /** Cœur de la révélation, partagé entre clic joueur et tick bot : fige le pixel, maj tally,
   * persiste, diffuse painted/progress, gère la complétion (§4.7). Renvoie le total du pseudo. */
  private async applyReveal(i: number, pseudo: string): Promise<number> {
    const total = this.width * this.height;
    const c = this.answer[i];
    this.revealed[i] = c;
    this.revealedCount++;
    const n = (this.tally.get(pseudo) ?? 0) + 1;
    this.tally.set(pseudo, n);
    void this.ctx.storage.put(`px:${i}`, c);
    void this.ctx.storage.put(`ty:${pseudo}`, n);
    this.broadcast({ type: "painted", i, c, pseudo });
    this.broadcast({ type: "progress", revealed: this.revealedCount, total });
    if (this.revealedCount === total) {
      await this.notifyComplete();
      await this.saveGallery();
      this.broadcast({ type: "completed", ranking: this.ranking() });
    }
    return n;
  }

  /** Index d'un pixel non révélé au hasard, ou -1 si l'artwork est complet. */
  private pickUnrevealed(): number {
    const total = this.width * this.height;
    if (this.revealedCount >= total) return -1;
    const start = Math.floor(Math.random() * total);
    for (let k = 0; k < total; k++) {
      const j = (start + k) % total;
      if (this.revealed[j] === UNREVEALED) return j;
    }
    return -1;
  }

  /** Programme le prochain tick du bot s'il n'y en a pas déjà un et que l'artwork n'est pas fini. */
  private async ensureBotAlarm(): Promise<void> {
    if (this.revealedCount >= this.width * this.height) return;
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + BOT_INTERVAL_MS);
    }
  }

  /** Tick du bot : révèle 1 pixel sous le pseudo bot. Dort si aucun joueur n'est connecté. */
  async alarm(): Promise<void> {
    await this.init();
    if (this.ctx.getWebSockets().length === 0) return; // pas de joueur -> bot en pause
    const i = this.pickUnrevealed();
    if (i >= 0) await this.applyReveal(i, this.botName);
    await this.ensureBotAlarm(); // reprogramme le tick suivant
  }

  /** Relaie le curseur d'un joueur aux autres (coords normalisées, post-MVP). */
  private onCursor(ws: WebSocket, msg: CursorMsg): void {
    const identity = ws.deserializeAttachment() as Identity | null;
    if (!identity) return;
    const x = Math.min(1, Math.max(0, msg.x));
    const y = Math.min(1, Math.max(0, msg.y));
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const out = encode({ type: "cursor", id: identity.sessionId.slice(0, 8), pseudo: identity.pseudo, x, y });
    for (const peer of this.ctx.getWebSockets()) {
      if (peer !== ws) {
        try {
          peer.send(out);
        } catch {
          /* socket fermant */
        }
      }
    }
  }

  /** Archive l'œuvre terminée dans la galerie (côté coordinateur). Best-effort. */
  private async saveGallery(): Promise<void> {
    try {
      await this.coordinator().fetch("https://coordinator/gallery", {
        method: "POST",
        body: JSON.stringify({
          key: this.roomKey,
          artworkId: this.artworkId,
          width: this.width,
          height: this.height,
          palette: this.palette,
          answer: [...this.answer], // image complète : publique une fois l'œuvre finie
        }),
      });
    } catch {
      /* galerie indisponible : non bloquant */
    }
  }

  /** Classement par pseudo (pixels révélés), trié décroissant, top 10 — pour le beat. */
  private ranking(): { pseudo: string; count: number }[] {
    return [...this.tally.entries()]
      .map(([pseudo, count]) => ({ pseudo, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
  }

  /** Token bucket par IP : true si un jeton est dispo (et le consomme), false sinon. */
  private allowIp(ip: string): boolean {
    const now = Date.now();
    let b = this.ipBucket.get(ip);
    if (!b) {
      b = { tokens: IP_BURST, ts: now };
      this.ipBucket.set(ip, b);
    }
    const refill = Math.floor((now - b.ts) / IP_REFILL_MS);
    if (refill > 0) {
      b.tokens = Math.min(IP_BURST, b.tokens + refill);
      b.ts = now;
    }
    if (b.tokens <= 0) return false;
    b.tokens--;
    return true;
  }

  private localOnline(exclude?: WebSocket): number {
    const all = this.ctx.getWebSockets();
    return exclude ? all.filter((w) => w !== exclude).length : all.length;
  }

  private coordinator(): DurableObjectStub {
    return this.env.COORDINATOR.get(this.env.COORDINATOR.idFromName("singleton"));
  }

  /** Rapporte le nb de sockets de cette room au coordinateur, récupère le total global, diffuse. */
  private async reportOnline(exclude?: WebSocket): Promise<void> {
    const count = this.localOnline(exclude);
    let total = count;
    try {
      const res = await this.coordinator().fetch("https://coordinator/online", {
        method: "POST",
        body: JSON.stringify({ roomKey: this.roomKey, count }),
      });
      total = ((await res.json()) as { total: number }).total;
    } catch {
      /* coordinateur indisponible : on retombe sur le compte local */
    }
    this.broadcast({ type: "online", count: total });
  }

  /** Signale au coordinateur que cette room a atteint 100% (il fait avancer la frontière). */
  private async notifyComplete(): Promise<void> {
    try {
      await this.coordinator().fetch("https://coordinator/complete", {
        method: "POST",
        body: JSON.stringify({ roomKey: this.roomKey }),
      });
    } catch {
      /* best-effort : si ça échoue, la frontière n'avance pas, pas de divergence d'état */
    }
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
