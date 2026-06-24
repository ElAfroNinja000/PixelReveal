/** Bindings du Worker (cf. wrangler.toml). Partagé par index.ts et les Durable Objects. */
export interface Env {
  /** Une instance de DO par artwork (clé = artworkId). */
  ARTWORK_ROOM: DurableObjectNamespace;
  /** Singleton pipeline + frontière + online global. */
  COORDINATOR: DurableObjectNamespace;
  /** "dev" active les routes de diagnostic (cf. index.ts). Absent en production. */
  ENVIRONMENT?: string;
}
