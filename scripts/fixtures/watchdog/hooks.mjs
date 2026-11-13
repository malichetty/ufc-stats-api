// Points watchdog.ts's two sibling imports at fakes: the real sync.ts shells out to wrangler, db.ts opens SQLite.
export async function resolve(specifier, context, next) {
  if ((context.parentURL ?? '').includes('/scraper/watchdog.ts')) {
    if (specifier === './sync.ts') return { url: new URL('./fake-sync.mjs', import.meta.url).href, shortCircuit: true };
    if (specifier === './db.ts') return { url: new URL('./fake-db.mjs', import.meta.url).href, shortCircuit: true };
  }
  return next(specifier, context);
}
