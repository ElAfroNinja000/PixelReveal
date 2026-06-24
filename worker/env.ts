/** Bindings du Worker (cf. wrangler.toml). Partagé par index.ts et les Durable Objects. */
export interface Env {
  /** Une instance de DO par artwork (clé = artworkId). */
  ARTWORK_ROOM: DurableObjectNamespace;
  /** Singleton pipeline + frontière + online global (implémenté en phase 4). */
  COORDINATOR: DurableObjectNamespace;
}
