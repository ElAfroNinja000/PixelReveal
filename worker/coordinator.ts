import type { Env } from "./env";

/**
 * STUB — implémenté en phase 4 (Epic Coordinateur).
 *
 * Rôle à venir : singleton qui tient l'ordre du pipeline, l'index de la frontière (artwork
 * en cours), route les nouvelles connexions vers la bonne room, orchestre la transition
 * partagée à 100% et maintient le compteur global de joueurs en ligne (cf. §4.1/§4.7/§4.8).
 *
 * Présent dès maintenant car déclaré dans la migration wrangler (new_classes v1) : la classe
 * doit exister pour que le binding COORDINATOR se charge.
 */
export class Coordinator implements DurableObject {
  // Phase 4 : ctx/env seront capturés ici. Stub volontairement sans état pour l'instant.
  constructor(_ctx: DurableObjectState, _env: Env) {}

  async fetch(_req: Request): Promise<Response> {
    return new Response("coordinator: not implemented (phase 4)", { status: 501 });
  }
}
