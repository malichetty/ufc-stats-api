interface Env {
  ADMIN_API_KEY?: string;
  /** dev only: shorten the meta cache so tests see a new data version at once */
  META_TTL_SECONDS?: string;
}
