import type { Env } from "./env";

// Les classes DO doivent être exportées depuis l'entrée du Worker pour que le runtime les monte.
export { ArtworkRoom } from "./artwork-room";
export { Coordinator } from "./coordinator";

// Phase 3 : routage minimal vers l'unique room. Le coordinateur (frontière, pipeline) prendra
// le relais en phase 4 pour aiguiller vers l'artwork en cours.
const ARTWORK_ID = "artwork-001";

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/ws") {
      // Une instance de DO déterministe par artworkId : idFromName garantit la même room pour tous.
      const id = env.ARTWORK_ROOM.idFromName(ARTWORK_ID);
      return env.ARTWORK_ROOM.get(id).fetch(req);
    }

    return new Response("PixelReveal worker OK", {
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
};
