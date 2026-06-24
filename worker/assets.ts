/**
 * Registre des assets d'artwork, chargés côté serveur uniquement.
 *
 * Sécurité : `answer` ne quitte jamais le serveur en bloc (§4.3/§9). On bundle donc l'asset
 * dans le worker plutôt que de l'exposer en statique public. À terme (pipeline de plusieurs
 * artworks), remplaçable par un chargement R2/KV privé sans toucher au reste.
 */

export interface Asset {
  id: string;
  width: number;
  height: number;
  palette: string[];
  answer: number[]; // index palette par pixel, row-major
}

// Bundlé dans le worker par esbuild (objet JSON au runtime). Jamais servi au client.
import artwork001 from "../assets/artwork-001.json";

// Mini artwork 2x2 réservé aux tests de complétion (atteignable en 4 clics). Non listé dans
// pipeline.json → jamais servi en prod par le coordinateur ; accessible seulement via /__ws (dev).
const ARTWORK_TEST: Asset = {
  id: "artwork-test",
  width: 2,
  height: 2,
  palette: ["#ff0000", "#00ff00"],
  answer: [0, 1, 1, 0],
};

const REGISTRY: Record<string, Asset> = {
  "artwork-001": artwork001 as Asset,
  "artwork-test": ARTWORK_TEST,
};

export function loadAsset(id: string): Asset {
  const asset = REGISTRY[id];
  if (!asset) throw new Error(`asset inconnu: ${id}`);
  return asset;
}
