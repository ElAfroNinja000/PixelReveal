import type { Env } from "./env";
import pipelineRaw from "../assets/pipeline.json";

/** Ordre du pipeline + politique de fin (cf. §4.9). Bundlé (non secret). */
interface Pipeline {
  artworks: string[];
  onExhausted: "cycle" | "stop" | "reshuffle";
}
const PIPELINE = pipelineRaw as Pipeline;

/**
 * Position de la frontière : index dans le pipeline + numéro de tour (lap).
 * Le lap incrémente à chaque cycle complet : il rend le roomKey unique par passage, donc une
 * nouvelle instance de DO (canvas vierge) quand on recroise le même artwork (§4.9).
 */
interface Frontier {
  index: number;
  lap: number;
}

/** Méta d'une œuvre archivée (l'image complète est stockée à part sous gal:<key>). */
interface GalleryMeta {
  key: string;
  artworkId: string;
  width: number;
  height: number;
  ts: number;
}

function roomKeyOf(f: Frontier): string {
  return `${PIPELINE.artworks[f.index]}#${f.lap}`;
}

/**
 * DO singleton (cf. §4.1) : tient l'ordre du pipeline, l'index de frontière et le compteur
 * global de joueurs. Ne détient aucun socket — il coordonne, les rooms diffusent.
 */
export class Coordinator implements DurableObject {
  private frontier: Frontier | null = null;
  private readonly onlineByRoom = new Map<string, number>(); // roomKey -> sockets (éphémère)

  constructor(private readonly ctx: DurableObjectState, _env: Env) {}

  private async getFrontier(): Promise<Frontier> {
    if (!this.frontier) {
      this.frontier = (await this.ctx.storage.get<Frontier>("frontier")) ?? { index: 0, lap: 0 };
    }
    return this.frontier;
  }

  private frontierResponse(f: Frontier): Response {
    return Response.json({ roomKey: roomKeyOf(f), artworkId: PIPELINE.artworks[f.index] });
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    // Frontière courante : la room où router toute nouvelle connexion (§4.8).
    if (url.pathname === "/frontier") {
      return this.frontierResponse(await this.getFrontier());
    }

    // Une room signale qu'elle a atteint 100%. On avance la frontière, mais seulement si le
    // signal correspond bien à la frontière actuelle (idempotent : ignore les doublons/retards).
    if (url.pathname === "/complete") {
      const { roomKey } = (await req.json()) as { roomKey: string };
      const cur = await this.getFrontier();
      if (roomKey === roomKeyOf(cur)) {
        this.frontier = this.advance(cur);
        await this.ctx.storage.put("frontier", this.frontier);
      }
      return this.frontierResponse(this.frontier!);
    }

    // Une room rapporte son nombre de sockets ; on renvoie le total global agrégé (§4.x online).
    if (url.pathname === "/online") {
      const { roomKey, count } = (await req.json()) as { roomKey: string; count: number };
      if (count <= 0) this.onlineByRoom.delete(roomKey);
      else this.onlineByRoom.set(roomKey, count);
      let total = 0;
      for (const n of this.onlineByRoom.values()) total += n;
      return Response.json({ total });
    }

    // --- Galerie des œuvres terminées (post-MVP) ---
    // Méta listée sous "gallery" (cap 50) ; image complète sous gal:<key>. Public (œuvre finie).
    if (url.pathname === "/gallery" && req.method === "POST") {
      const e = (await req.json()) as {
        key: string; artworkId: string; width: number; height: number; palette: string[]; answer: number[];
      };
      await this.ctx.storage.put(`gal:${e.key}`, e);
      const list = (await this.ctx.storage.get<GalleryMeta[]>("gallery")) ?? [];
      if (!list.some((m) => m.key === e.key)) {
        list.unshift({ key: e.key, artworkId: e.artworkId, width: e.width, height: e.height, ts: Date.now() });
        while (list.length > 50) {
          const drop = list.pop();
          if (drop) await this.ctx.storage.delete(`gal:${drop.key}`);
        }
        await this.ctx.storage.put("gallery", list);
      }
      return Response.json({ ok: true });
    }
    if (url.pathname === "/gallery" && req.method === "GET") {
      return Response.json((await this.ctx.storage.get<GalleryMeta[]>("gallery")) ?? []);
    }
    if (url.pathname === "/gallery/item") {
      const key = url.searchParams.get("key");
      const item = key ? await this.ctx.storage.get(`gal:${key}`) : null;
      if (!item) return new Response("not found", { status: 404 });
      return Response.json(item);
    }

    return new Response("not found", { status: 404 });
  }

  /** Avance d'un cran ; en bout de pipeline, applique la politique (défaut = cycle). */
  private advance(f: Frontier): Frontier {
    const next = f.index + 1;
    if (next < PIPELINE.artworks.length) return { index: next, lap: f.lap };
    // Pipeline épuisé :
    if (PIPELINE.onExhausted === "stop") return { index: f.index, lap: f.lap }; // reste à la fin
    return { index: 0, lap: f.lap + 1 }; // cycle (et reshuffle ≈ cycle au MVP) → canvas vierge
  }
}
