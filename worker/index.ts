import type { Env } from "./env";

// Les classes DO doivent être exportées depuis l'entrée du Worker pour que le runtime les monte.
export { ArtworkRoom } from "./artwork-room";
export { Coordinator } from "./coordinator";

const SINGLETON = "singleton";

function coordinator(env: Env): DurableObjectStub {
  return env.COORDINATOR.get(env.COORDINATOR.idFromName(SINGLETON));
}

/** Recopie une réponse en ajoutant un CORS ouvert (galerie publique, lecture seule). */
function cors(res: Response): Response {
  const out = new Response(res.body, res);
  out.headers.set("access-control-allow-origin", "*");
  return out;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/ws") {
      // Le coordinateur résout la frontière (artwork en cours) ; on aiguille la connexion vers
      // sa room et on lui passe le roomKey via `?room=` (cf. §4.8). idFromName(roomKey) garantit
      // la même instance de DO pour tous les joueurs de ce passage.
      const res = await coordinator(env).fetch("https://coordinator/frontier");
      const { roomKey } = (await res.json()) as { roomKey: string };
      const target = new URL(req.url);
      target.searchParams.set("room", roomKey);
      const room = env.ARTWORK_ROOM.get(env.ARTWORK_ROOM.idFromName(roomKey));
      return room.fetch(new Request(target, req));
    }

    // Galerie publique (œuvres terminées) — lecture seule. L'écriture reste interne (room->coord).
    // CORS ouvert : le front (Pages, autre origin) lit la galerie depuis le navigateur.
    if (url.pathname === "/gallery" && req.method === "GET") {
      return cors(await coordinator(env).fetch("https://coordinator/gallery"));
    }
    if (url.pathname === "/gallery/item" && req.method === "GET") {
      return cors(await coordinator(env).fetch("https://coordinator/gallery/item" + url.search));
    }

    // Routes de diagnostic — uniquement en dev (npm run dev passe --var ENVIRONMENT:dev).
    // Lecture seule (/__frontier) et avance forcée (/__advance) pour tester sans peindre 90k px.
    if (env.ENVIRONMENT === "dev") {
      if (url.pathname === "/__frontier") {
        return coordinator(env).fetch("https://coordinator/frontier");
      }
      if (url.pathname === "/__advance" && req.method === "POST") {
        const body = await req.text();
        return coordinator(env).fetch("https://coordinator/complete", { method: "POST", body });
      }
      // Connexion directe à une room arbitraire (?room=KEY) — bypass de la frontière, pour
      // tester la complétion sur un mini artwork. Hors dev, cette route n'existe pas.
      if (url.pathname === "/__ws") {
        const roomKey = url.searchParams.get("room");
        if (!roomKey) return new Response("room manquant", { status: 400 });
        const target = new URL(req.url);
        target.searchParams.set("room", roomKey);
        return env.ARTWORK_ROOM.get(env.ARTWORK_ROOM.idFromName(roomKey)).fetch(new Request(target, req));
      }
    }

    return new Response("PixelReveal worker OK", {
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
};
