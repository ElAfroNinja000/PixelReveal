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

const REGISTRY: Record<string, Asset> = {
  "artwork-001": artwork001 as Asset,
};

export function loadAsset(id: string): Asset {
  const asset = REGISTRY[id];
  if (!asset) throw new Error(`asset inconnu: ${id}`);
  return asset;
}
