import { log } from "../log";

// —— Playwright 有头浏览器（WAF / 验证码 / 加密 AJAX 站点专用）——
// 持久化用户目录 data/browser-profile：cookie / localStorage 自动保存，
// WAF 挑战种下的凭据过一次后续自动复用；验证码弹窗手动完成，最长等 180s。
// channel 探测顺序：系统 Chrome → 系统 Edge → playwright 自带 chromium。
// BROWSER_HEADLESS=1 切无头（默认有头，本地调试用）。

let ctxP: Promise<any> | null = null;

const CAPTCHA_RE = /验证码|人机验证|安全验证|安全挑战|请完成验证|captcha/i;
// 判定收紧：标题命中，或「小页面 + 关键词」（正常内容页很大且可能内嵌含 captcha 字样的脚本，不能只看关键词）
// Cloudflare Turnstile / aegis WAF：英文挑战页（如 69shuba），页面内嵌 turnstile 脚本或 verify 端点
const isCaptchaPage = (html: string) =>
  /<title>[^<]*(验证|captcha|waf|human\s+verification)[^<]*<\/title>/i.test(html) ||
  /challenges\.cloudflare\.com\/turnstile|cf-turnstile|aegis_captcha_verify/.test(html) ||
  (html.length < 4000 && CAPTCHA_RE.test(html));

// page.content() 在页面跳转进行中会抛 "Unable to retrieve content because the page is navigating
// and changing the content."（验证码提交后的 redirect 最容易撞上轮询时机）→ 等 load 稳定后重试
async function safeContent(page: any, tries = 10): Promise<string> {
  for (let i = 0; ; i++) {
    try {
      return await page.content();
    } catch (e: any) {
      if (i >= tries || !/navigating|changing the content/i.test(String(e?.message ?? e))) throw e;
      await page.waitForLoadState("load", { timeout: 15_000 }).catch(() => {});
      await page.waitForTimeout(300);
    }
  }
}

async function getContext(): Promise<any> {
  if (!ctxP) {
    ctxP = (async () => {
      const { chromium } = await import("playwright");
      const headless = process.env.BROWSER_HEADLESS === "1";
      const tries: Record<string, string>[] = [{ channel: "chrome" }, { channel: "msedge" }, {}];
      const errs: string[] = [];
      for (const opt of tries) {
        try {
          const ctx = await chromium.launchPersistentContext("data/browser-profile", {
            headless,
            viewport: { width: 1280, height: 800 },
            // 降低自动化特征（Cloudflare Turnstile 等会检测 navigator.webdriver / enable-automation）：
            // --disable-blink-features=AutomationControlled 让 webdriver=false；去掉默认 --enable-automation 开关
            args: ["--disable-blink-features=AutomationControlled"],
            ignoreDefaultArgs: ["--enable-automation"],
            ...opt,
          });
          log.info("browser", `浏览器已启动（${opt.channel ?? "chromium"} · ${headless ? "无头" : "有头"} · 持久化 data/browser-profile）`);
          return ctx;
        } catch (e: any) {
          errs.push(`${opt.channel ?? "chromium"}: ${String(e?.message ?? e).split("\n")[0]}`);
        }
      }
      throw new Error(
        `浏览器启动失败（依次尝试 chrome/msedge/chromium）——${errs.join("；")}。` +
          `常见原因：另一个进程（如正在运行的 bun-reader 服务或残留 chrome 窗口）占用了同一 profile 目录，请先关闭后重试`,
      );
    })();
    // 进程退出时顺手关浏览器，避免残留 chrome 进程
    process.once("exit", () => ctxP?.then((c) => c.close()).catch(() => {}));
  }
  return ctxP;
}

export interface BrowserPage {
  html(): Promise<string>;
  url(): string;
  click(sel: string, timeoutMs?: number): Promise<void>;
  /** 等待选择器命中数量变化（加密 AJAX 翻页后列表刷新），返回是否等到 */
  waitCount(sel: string, prev: number, timeoutMs?: number): Promise<boolean>;
  waitForLoad(timeoutMs?: number): Promise<void>;
  /** 页内上下文 fetch：自动带浏览器 cookie / 真实 TLS 指纹，支持 POST（相对地址相对当前页解析） */
  fetch(url: string, opts?: { method?: string; body?: string; headers?: Record<string, string> }): Promise<{ status: number; text: string }>;
  close(): Promise<void>;
}

// 打开一个浏览器页：自动等 WAF 挑战/验证码通过（有头窗口里手动完成），返回页面操作句柄
export async function browserOpen(url: string, opts: { timeoutMs?: number } = {}): Promise<BrowserPage> {
  const ctx = await getContext();
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: opts.timeoutMs ?? 45_000 });
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    let html = await safeContent(page);
    const onChallenge = () => /WAF\/VERIFY/i.test(page.url());
    if (isCaptchaPage(html) || onChallenge()) {
      log.warn("browser", `WAF/人机验证挑战（${page.url().slice(0, 90)}），等待通过（最长 180s；Turnstile 类挑战通常自动通过，图片验证码需在窗口手动输入）…`);
      const deadline = Date.now() + 180_000;
      let lastTip = Date.now();
      let passed = false;
      while (Date.now() < deadline) {
        try {
          await page.waitForTimeout(2000);
          html = await safeContent(page);
        } catch (e: any) {
          if (/closed|destroyed/i.test(String(e?.message ?? e)))
            throw new Error("浏览器窗口已关闭，人机验证中断（验证期间请勿关闭浏览器窗口）");
          throw e;
        }
        // 通过标志：不再是挑战页（Turnstile 自动跳转 / 图片验证码提交后 redirect 都走这里）
        if (!isCaptchaPage(html) && !onChallenge()) {
          passed = true;
          break;
        }
        if (Date.now() - lastTip > 30_000) {
          log.info("browser", "仍在等待人机验证…（Turnstile 会自动通过；如需图片验证码请在浏览器窗口输入并提交）");
          lastTip = Date.now();
        }
      }
      if (!passed) throw new Error("人机验证未通过（等待 180s 超时），请重试并在浏览器窗口及时完成验证");
      log.info("browser", "验证已通过，cookie 已存入持久化 profile，下次直接复用");
      await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    }
  } catch (e) {
    await page.close().catch(() => {});
    throw e;
  }
  return {
    html: () => safeContent(page),
    url: () => page.url(),
    click: (sel, timeoutMs = 10_000) => page.click(sel, { timeout: timeoutMs }),
    waitCount: async (sel, prev, timeoutMs = 15_000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        await page.waitForTimeout(400);
        try {
          if ((await page.locator(sel).count()) !== prev) return true;
        } catch {
          // 选择器暂时失效（列表刷新中），继续等
        }
      }
      return false;
    },
    waitForLoad: (timeoutMs = 15_000) => page.waitForLoadState("networkidle", { timeout: timeoutMs }).catch(() => {}),
    fetch: async (url, opts = {}) =>
      page.evaluate(
        async ({ u, o }: { u: string; o: typeof opts }) => {
          const r = await fetch(u, o);
          return { status: r.status, text: await r.text() };
        },
        { u: new URL(url, page.url()).href, o: opts },
      ),
    close: () => page.close(),
  };
}

// 一次性抓取：打开 → 等验证/挑战 → 取 HTML → 关页
export async function browserText(url: string, opts: { timeoutMs?: number } = {}) {
  const p = await browserOpen(url, opts);
  try {
    return { status: 200, text: await p.html(), url: p.url() };
  } finally {
    await p.close();
  }
}

// 持久化 profile 里某 URL 同域的 cookie 串（"k=v; k=v"），供服务端 fetchText 合并复用；
// 浏览器上下文未启动时返回空串（不会为了取 cookie 拉起浏览器）
export async function browserCookieHeader(url: string): Promise<string> {
  if (!ctxP) return "";
  try {
    const ctx = await ctxP;
    const cookies = await ctx.cookies(url);
    return cookies.map((c: any) => `${c.name}=${c.value}`).join("; ");
  } catch {
    return "";
  }
}
