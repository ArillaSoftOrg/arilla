/**
 * Yerel, bağımlılıksız tarayıcı sürücüsü (karar 0083, Faz B.1): kurulu
 * Chrome'u başsız ve GEÇİCİ bir profille açar, Chrome DevTools Protocol'e
 * Node'un yerleşik `WebSocket`'iyle bağlanır. Playwright/Puppeteer indirilmez.
 *
 * Yalnızca yerel E2E içindir: sayfa güvenlik başlıkları (CSP, frame-ancestors)
 * olduğu gibi kalır; ekran boyutu ve tema tarayıcı öykünmesiyle verilir.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DEFAULT_CHROME_PATHS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

/** `CHROME_PATH` ya da bilinen kurulum yolları; yoksa `null` (test atlanır). */
export function findChrome(): string | null {
  const fromEnv = process.env.CHROME_PATH;
  if (fromEnv) return existsSync(fromEnv) ? fromEnv : null;
  return DEFAULT_CHROME_PATHS.find((path) => existsSync(path)) ?? null;
}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

export interface Viewport {
  width: number;
  height: number;
  /** Dokunmatik öykünme: `pointer: coarse`, `hover: none`. */
  touch?: boolean;
}

export class CdpPage {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly waiters: { method: string; resolve: (params: unknown) => void }[] = [];
  /** Sayfanın başlattığı tüm istek adresleri (engellenenler dahil). */
  readonly requestedUrls: string[] = [];

  private constructor(
    private readonly socket: WebSocket,
    private readonly sessionId: string,
  ) {}

  static async attach(socket: WebSocket, sessionId: string): Promise<CdpPage> {
    const page = new CdpPage(socket, sessionId);
    socket.addEventListener("message", (event) => page.onMessage(String(event.data)));
    await page.send("Page.enable");
    await page.send("Network.enable");
    await page.send("Runtime.enable");
    return page;
  }

  private onMessage(raw: string): void {
    const message = JSON.parse(raw) as {
      id?: number;
      sessionId?: string;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: { message: string };
    };
    if (message.sessionId !== this.sessionId) return;
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
      return;
    }
    if (message.method === "Network.requestWillBeSent") {
      const url = (message.params as { request?: { url?: string } })?.request?.url;
      if (url) this.requestedUrls.push(url);
    }
    if (message.method) {
      const index = this.waiters.findIndex((w) => w.method === message.method);
      if (index >= 0) {
        const [waiter] = this.waiters.splice(index, 1);
        waiter?.resolve(message.params);
      }
    }
  }

  /**
   * Adres kalıplarını ağ katmanında engeller (`*` joker). İstek yine
   * `requestedUrls`'e düşer ama sunucuya hiç gitmez: testler dış servise
   * (ör. Google Analytics) bağlanmaz.
   */
  async blockUrls(patterns: readonly string[]): Promise<void> {
    await this.send("Network.setBlockedURLs", { urls: patterns });
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ id, method, params, sessionId: this.sessionId }));
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    });
  }

  private waitFor(method: string, timeoutMs = 20_000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`zaman aşımı: ${method}`)), timeoutMs);
      this.waiters.push({
        method,
        resolve: (params) => {
          clearTimeout(timer);
          resolve(params);
        },
      });
    });
  }

  async setViewport({ width, height, touch = false }: Viewport): Promise<void> {
    await this.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: touch,
    });
    await this.send("Emulation.setTouchEmulationEnabled", { enabled: touch, maxTouchPoints: 5 });
  }

  async setColorScheme(scheme: "light" | "dark"): Promise<void> {
    await this.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: scheme }],
    });
  }

  async setCookie(url: string, name: string, value: string): Promise<void> {
    await this.send("Network.setCookie", { url, name, value, path: "/" });
  }

  async goto(url: string): Promise<void> {
    const loaded = this.waitFor("Page.loadEventFired");
    await this.send("Page.navigate", { url });
    await loaded;
  }

  async evaluate<T>(expression: string): Promise<T> {
    const result = await this.send<{
      result: { value?: T };
      exceptionDetails?: { text: string; exception?: { description?: string } };
    }>("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ?? result.exceptionDetails.text,
      );
    }
    return result.result.value as T;
  }

  async press(key: "Tab" | "Escape" | "Enter", shift = false): Promise<void> {
    const codes = { Tab: 9, Escape: 27, Enter: 13 } as const;
    const base = {
      key,
      code: key,
      windowsVirtualKeyCode: codes[key],
      modifiers: shift ? 8 : 0,
    };
    await this.send("Input.dispatchKeyEvent", { type: "keyDown", ...base });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  }

  /** Öğenin ortasına gerçek fare tıklaması (öykünülmüş olay değil). */
  async click(selector: string): Promise<void> {
    const box = await this.evaluate<{ x: number; y: number } | null>(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    if (!box) throw new Error(`öğe yok: ${selector}`);
    for (const type of ["mousePressed", "mouseReleased"]) {
      await this.send("Input.dispatchMouseEvent", {
        type,
        x: box.x,
        y: box.y,
        button: "left",
        clickCount: 1,
      });
    }
  }

  /** Görünen alan ya da tam sayfa PNG (base64). */
  async screenshot(fullPage = false): Promise<string> {
    if (!fullPage) {
      const shot = await this.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
      return shot.data;
    }
    const size = await this.evaluate<{ w: number; h: number }>(
      "({ w: document.documentElement.clientWidth, h: Math.min(document.documentElement.scrollHeight, 6000) })",
    );
    const shot = await this.send<{ data: string }>("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: size.w, height: size.h, scale: 1 },
    });
    return shot.data;
  }
}

export class Browser {
  private constructor(
    private readonly process: ChildProcess,
    private readonly socket: WebSocket,
    private readonly profileDir: string,
  ) {}

  static async launch(chromePath: string): Promise<Browser> {
    const profileDir = mkdtempSync(join(tmpdir(), "arilla-cdp-"));
    const child = spawn(
      chromePath,
      [
        "--headless=new",
        "--remote-debugging-port=0",
        `--user-data-dir=${profileDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--disable-gpu",
        "--hide-scrollbars",
        "about:blank",
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    const wsUrl = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Chrome açılmadı")), 20_000);
      let buffer = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        const match = /DevTools listening on (ws:\/\/\S+)/.exec(buffer);
        if (match?.[1]) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      });
      child.on("exit", () => reject(new Error("Chrome kapandı")));
    });
    const socket = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("CDP bağlanamadı")), { once: true });
    });
    return new Browser(child, socket, profileDir);
  }

  private browserCall<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const id = Math.floor(Math.random() * 1e9);
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise<T>((resolve, reject) => {
      const onMessage = (event: MessageEvent) => {
        const message = JSON.parse(String(event.data)) as {
          id?: number;
          result?: T;
          error?: { message: string };
        };
        if (message.id !== id) return;
        this.socket.removeEventListener("message", onMessage);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result as T);
      };
      this.socket.addEventListener("message", onMessage);
    });
  }

  async newPage(): Promise<CdpPage> {
    const { targetId } = await this.browserCall<{ targetId: string }>("Target.createTarget", {
      url: "about:blank",
    });
    const { sessionId } = await this.browserCall<{ sessionId: string }>("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    return CdpPage.attach(this.socket, sessionId);
  }

  async close(): Promise<void> {
    this.socket.close();
    this.process.kill();
    await new Promise((resolve) => setTimeout(resolve, 300));
    rmSync(this.profileDir, { recursive: true, force: true });
  }
}
