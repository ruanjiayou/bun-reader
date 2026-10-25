import { log } from "../log";

// —— Playwright 有头浏览器（WAF / 验证码 / 加密 AJAX 站点专用）——
// 持久化用户目录 data/browser-profile：cookie / localStorage 自动保存，
// WAF 挑战种下的凭据过一次后续自动复用；验证码弹窗手动完成，最长等 180s。
// channel 探测顺序：系统 Chrome → 系统 Edge → playwright 自带 chromium。
// BROWSER_HEADLESS=1 切无头（默认有头，本地调试用）。

let ctxP: Promise<any> | null = null;

const CAPTCHA_RE = /验证码|人机验证|安全验证|安全挑战|请完成验证|captcha/i;
// 判定收紧：标题命中，或「小页面 + 关键词」（正常内容页很大且可能内嵌含 captcha 字样的脚本，不能只看关键词）
const isCaptchaPage = (html: string) =>
  /<title>[^<]*(验证|captcha|waf)[^<]*<\/title>/i.test(html) || (html.length < 4000 && CAPTCHA_RE.test(html));

async function getContext(): Promise<any> {
  if (!ctxP) {
    ctxP = (async () => {
      const { chromium } = await import("playwright");
      const headless = process.env.BROWSER_HEADLESS === "1";
      const tries: Record<string, string>[] = [{ channel: "chrome" }, { channel: "msedge" }, {}];
      let lastErr: any;
      for (const opt of tries) {
        try {
          const ctx = await chromium.launchPersistentContext("data/browser-profile", {
            headless,
            viewport: { width: 1280, height: 800 },
            ...opt,
          });
          log.info("browser", `浏览器已启动（${opt.channel ?? "chromium"} · ${headless ? "无头" : "有头"} · 持久化 data/browser-profile）`);
          return ctx;
        } catch (e) {
          lastErr = e;
        }
      }
      throw lastErr;
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
  close(): Promise<void>;
}

// 打开一个浏览器页：自动等 WAF 挑战/验证码通过（有头窗口里手动完成），返回页面操作句柄
export async function browserOpen(url: string, opts: { timeoutMs?: number } = {}): Promise<BrowserPage> {
  const ctx = await getContext();
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: opts.timeoutMs ?? 45_000 });
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    let html = await page.content();
    const onChallenge = () => /WAF\/VERIFY/i.test(page.url());
    if (isCaptchaPage(html) || onChallenge()) {
      log.warn("browser", `WAF/验证码挑战（${page.url().slice(0, 90)}），请在弹出的浏览器窗口输入验证码并提交（最长等 180s）…`);
      const deadline = Date.now() + 180_000;
      let lastTip = Date.now();
      let passed = false;
      while (Date.now() < deadline) {
        await page.waitForTimeout(2000);
        html = await page.content();
        // 通过标志：跳回正常页面（URL 离开 WAF/VERIFY 且内容是真实页面）
        if ((!isCaptchaPage(html) && html.length > 5000 && !onChallenge()) || (!onChallenge() && html.length > 5000)) {
          passed = true;
          break;
        }
        if (Date.now() - lastTip > 30_000) {
          log.info("browser", "仍在等待人工验证…（在浏览器窗口输入图片验证码并点提交）");
          lastTip = Date.now();
        }
      }
      if (!passed) throw new Error("验证码未通过（等待 180s 超时），请重试并在浏览器窗口及时完成验证");
      log.info("browser", "验证已通过，cookie 已存入持久化 profile，下次直接复用");
    }
  } catch (e) {
    await page.close().catch(() => {});
    throw e;
  }
  return {
    html: () => page.content(),
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
