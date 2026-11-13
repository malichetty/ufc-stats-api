import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

/** Minimum gap between two page loads. ufcstats is a small site; we stay well under one page every 2 s. */
export const MIN_GAP_MS = Number(process.env.UFC_MIN_GAP_MS ?? 2500);
const JITTER_MS = 1000;

export class BlockedError extends Error {}

/**
 * One headless Chromium, one tab, one page at a time. The browser runs ufcstats' JavaScript check the same way a
 * visitor's browser does; the pass cookie is kept for the whole run. Images, fonts, stylesheets and third-party
 * hosts are skipped to keep our load on the site small.
 */
export class Fetcher {
  private browser?: Browser;
  private ctx?: BrowserContext;
  private page?: Page;
  private lastAt = 0;

  async open(): Promise<void> {
    // Signals are handled by drain() so the current page finishes and the run ends cleanly. ufcstats only serves plain
    // http (its port 443 refuses connections), so anyone on the network path can feed this browser script: keep
    // Chromium's process sandbox on (Playwright turns it off unless asked) and refuse downloads.
    // Egress allowlist at the network layer: every host but ufcstats.com is sent to a closed local port and fails, which
    // also covers redirect hops, WebSockets and IP-literal URLs that the route filter below can't see. `<-loopback>`
    // stops Chromium from exempting localhost. This is not a proxy service: ufcstats.com is always reached directly.
    this.browser = await chromium.launch({
      headless: true, chromiumSandbox: true, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
      proxy: { server: 'http://127.0.0.1:9', bypass: 'ufcstats.com,<-loopback>' },
    });
    this.ctx = await this.browser.newContext({
      acceptDownloads: false,
      userAgent: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/${this.browser.version()} Safari/537.36 ufc-stats-api/2.0 (+https://github.com/malichetty/ufc-stats-api)`,
    });
    await this.ctx.route('**/*', (route) => {
      const req = route.request();
      const host = new URL(req.url()).hostname;
      if (host !== 'ufcstats.com' || ['image', 'font', 'stylesheet', 'media'].includes(req.resourceType())) {
        return route.abort();
      }
      return route.continue();
    });
    // The route filter above never sees WebSockets, and sees only the first hop of a redirect (checked in get()).
    await this.ctx.routeWebSocket(/.*/, (ws) => ws.close());
    this.page = await this.ctx.newPage();
  }

  async close(): Promise<void> {
    await this.browser?.close();
  }

  async get(url: string): Promise<string> {
    if (!this.page) throw new Error('fetcher not open');
    const wait = this.lastAt + MIN_GAP_MS + Math.random() * JITTER_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastAt = Date.now();

    const res = await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    const status = res?.status() ?? 0;
    if (status === 403 || status === 429 || status === 503) {
      throw new BlockedError(`ufcstats answered HTTP ${status} for ${url}`);
    }
    if (status >= 400) throw new Error(`HTTP ${status}`);
    if (new URL(this.page.url()).hostname !== 'ufcstats.com') throw new Error(`redirected off ufcstats.com to ${new URL(this.page.url()).hostname}`);
    try {
      // The challenge page has no footer; the real page does. 30 s covers the check and its reload.
      await this.page.waitForSelector('.b-foot', { state: 'attached', timeout: 30_000 });
    } catch {
      const title = await this.page.title().catch(() => '');
      if (/loading|checking/i.test(title)) {
        throw new BlockedError(`browser check did not clear within 30 s on ${url}`);
      }
      throw new Error(`page did not finish loading (title "${title}")`);
    }
    return this.page.content();
  }
}
