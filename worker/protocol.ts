/**
 * Protocole WebSocket partagé entre Worker (DO) et front.
 *
 * Pourquoi un fichier partagé : un seul endroit définit la forme des messages, le serveur
 * et le client ne peuvent pas diverger. Cf. CLAUDE.md §6.
 *
 * Deux canaux de transport sur la même WebSocket :
 *  - JSON texte pour les messages de contrôle (hello, paint, painted, progress, ...).
 *  - Frames binaires pour les gros volumes : le snapshot initial (un octet/pixel).
 * On n'envoie jamais de full state en JSON (cf. §10 : deltas, pas de full state).
 */

/** Octet sentinelle « pixel non révélé » dans un snapshot/answer. 0..254 = index palette. */
export const UNREVEALED = 0xff;

/** Cooldown serveur, en millisecondes. Arbitré côté DO (cf. §4.4). Pièce maîtresse anti-bot. */
export const COOLDOWN_MS = 2000;

/* ------------------------------------------------------------------ */
/* Client → Serveur                                                    */
/* ------------------------------------------------------------------ */

/** Rejoint l'artwork en cours (la frontière). Premier message après l'ouverture du socket. */
export interface HelloMsg {
  type: "hello";
  pseudo: string;
  /** Généré côté client, persisté en localStorage. Porte le cooldown, suit le joueur. */
  sessionId: string;
}

/** Tente de révéler le pixel d'index `i` (row-major). Le serveur arbitre cooldown + validité. */
export interface PaintMsg {
  type: "paint";
  i: number;
}

export type ClientMessage = HelloMsg | PaintMsg;

/* ------------------------------------------------------------------ */
/* Serveur → Client                                                    */
/* ------------------------------------------------------------------ */

/**
 * Métadonnées de l'artwork rejoint. Le `snapshot` binaire (Uint8Array de width*height octets)
 * est envoyé dans une frame binaire séparée juste après ce message — pas en JSON, trop gros.
 * Le client peint le snapshot d'un coup puis applique les deltas `painted`.
 */
export interface WelcomeMsg {
  type: "welcome";
  artworkId: string;
  width: number;
  height: number;
  /** Index → code couleur hex. La sentinelle UNREVEALED n'a pas d'entrée (rendue en fond). */
  palette: string[];
  progress: Progress;
  online: number;
}

/** Delta diffusé à toute la room quand un pixel passe révélé. `c` = index palette. */
export interface PaintedMsg {
  type: "painted";
  i: number;
  c: number;
  /** Optionnel : auteur du clic, pour feed / curseurs (post-MVP). */
  pseudo?: string;
}

export interface Progress {
  revealed: number;
  total: number;
}

/** Peut être piggybacké sur `painted` pour éviter un message séparé. */
export interface ProgressMsg extends Progress {
  type: "progress";
}

/** L'artwork a atteint 100%. Déclenche le beat (popup). Un nouveau `welcome` suit (§4.7). */
export interface CompletedMsg {
  type: "completed";
}

/** Compteur global de joueurs en ligne (maintenu par le coordinateur). */
export interface OnlineMsg {
  type: "online";
  count: number;
}

/** Ack/rejet d'un `paint`. `until` = timestamp (ms) avant lequel le prochain clic est refusé. */
export interface CooldownMsg {
  type: "cooldown";
  until: number;
}

export type ServerMessage =
  | WelcomeMsg
  | PaintedMsg
  | ProgressMsg
  | CompletedMsg
  | OnlineMsg
  | CooldownMsg;

/* ------------------------------------------------------------------ */
/* Helpers de (dé)sérialisation JSON, typés des deux côtés.            */
/* ------------------------------------------------------------------ */

export function encode(msg: ServerMessage | ClientMessage): string {
  return JSON.stringify(msg);
}

export function decode<T extends ServerMessage | ClientMessage>(data: string): T {
  return JSON.parse(data) as T;
}
