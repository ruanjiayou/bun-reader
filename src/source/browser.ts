import { log } from "../log";

// —— 远程浏览器（KasmWeb chrome 容器 · CDP 连接）——
// 本地不再拉起 chromium：连接部署在 docker 的 kasmweb/chrome（compose 见 notes/docker/chromium-vnc）。
// 默认端点 http://127.0.0.1:9222（宿主 9222 → 容器 cdp-proxy 9223 → chrome 9222），CDP_URL 可覆盖。
// 形态收益：常驻实例（零启动成本）、cookie 落容器 profile 卷持久化、人机验证可开 VNC 网页（:6901）操作同一窗口。
// 关键约束：**绝不能 browser.close()**——共享实例，close 会断开连接并清上下文；只关自己开的页。
// 容器重启后连接失效：getCtx 检测 isConnected 自动重连。
// 旧的 headed/headless 双模式、profile 锁、UA 覆写全部取消：远程是唯一实例且就是真实 Chrome（navigator.webdriver=false）。

const CDP_URL = process.env.CDP_URL || "http://127.0.0.1:9222";

let browserP: Promise<any> | null = null;
const openPages = new Set<any>(); // 本进程打开的页：退出时清掉，避免容器里越积越多

async function connect(): Promise<any> {
  const { chromium } = await import("playwright");
  try {
    const b = await chromium.connectOverCDP(CDP_URL);
    log.info("browser", `已连接远程浏览器（${CDP_URL} · Chrome ${b.version()}）`);
    return b;
  } catch (e: any) {
    browserP = null;
    throw new Error(
      `远程浏览器连接失败（${CDP_URL}）——请确认 kasmweb/chrome 容器已启动（docker compose up -d）且 CDP 端口可达。原始错误：${String(e?.message ?? e).split("\n")[0]}`,
    );
  }
}

function getBrowser(): Promise<any> {
  if (!browserP) browserP = connect();
  return browserP;
}

// 默认上下文 = 容器 Chrome 的持久化 profile（cookie 全局共享，验证过一次后续复用）
async function getCtx(): Promise<any> {
  const b = await getBrowser();
  if (!b.isConnected()) {
    log.warn("browser", "远程浏览器连接已断开（容器重启？），自动重连");
    browserP = null;
    return getCtx();
  }
  return b.contexts()[0] ?? b.newContext();
}

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

// 打开一个浏览器页（远程容器里的一个 tab）：自动等 WAF 挑战/验证码通过（Turnstile 类自动过，
// 图片验证码开 VNC 网页 :6901 在同一窗口手动完成），返回页面操作句柄。
// opts.headless 已废弃（远程唯一实例无此区分），保留参数只为脚本 API 兼容。
export async function browserOpen(url: string, opts: { headless?: boolean; timeoutMs?: number } = {}): Promise<BrowserPage> {
  const ctx = await getCtx();
  const page = await ctx.newPage();
  openPages.add(page);
  page.once("close", () => openPages.delete(page)); // 任何途径关闭（句柄 close / 出错兜底 / VNC 里手动关）都摘除
  try {
    await page.setViewportSize({ width: 1280, height: 800 }).catch(() => {});
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: opts.timeoutMs ?? 45_000 });
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    let html = await safeContent(page);
    const onChallenge = () => /WAF\/VERIFY/i.test(page.url());
    if (isCaptchaPage(html) || onChallenge()) {
      log.warn("browser", `WAF/人机验证挑战（${page.url().slice(0, 90)}），等待通过（最长 180s；Turnstile 类通常自动通过，图片验证码请开 VNC 窗口 :6901 手动输入）…`);
      const deadline = Date.now() + 180_000;
      let lastTip = Date.now();
      let passed = false;
      while (Date.now() < deadline) {
        try {
          await page.waitForTimeout(2000);
          html = await safeContent(page);
        } catch (e: any) {
          if (/closed|destroyed/i.test(String(e?.message ?? e)))
            throw new Error("浏览器页已关闭，人机验证中断（验证期间请勿在 VNC 里关掉该 tab）");
          throw e;
        }
        // 通过标志：不再是挑战页（Turnstile 自动跳转 / 图片验证码提交后 redirect 都走这里）
        if (!isCaptchaPage(html) && !onChallenge()) {
          passed = true;
          break;
        }
        if (Date.now() - lastTip > 30_000) {
          log.info("browser", "仍在等待人机验证…（Turnstile 会自动通过；如需图片验证码请在 VNC 窗口 :6901 输入并提交）");
          lastTip = Date.now();
        }
      }
      if (!passed) throw new Error("人机验证未通过（等待 180s 超时），请在 VNC 窗口 :6901 完成验证后重试");
      log.info("browser", "验证已通过，cookie 已存入容器 profile，下次直接复用");
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

// 服务退出：只关本进程打开的页。**不关远程浏览器**（共享常驻实例，browser.close() 会断开连接清上下文）。
export async function closeBrowser(): Promise<void> {
  const pages = [...openPages];
  openPages.clear();
  await Promise.allSettled(pages.map((p) => p.close().catch(() => {})));
  browserP = null; // 丢弃连接引用，WS 随进程退出消亡，远端 Chrome 不受影响
}

// 一次性抓取：打开 → 等验证/挑战 → 取 HTML → 关页
export async function browserText(url: string, opts: { headless?: boolean; timeoutMs?: number } = {}) {
  const p = await browserOpen(url, opts);
  try {
    return { status: 200, text: await p.html(), url: p.url() };
  } finally {
    await p.close();
  }
}

// 远程 profile 里某 URL 同域的 cookie 串（"k=v; k=v"），供服务端 fetchText 合并复用；
// 浏览器未连接时返回空串（不会为了取 cookie 建立连接）
export async function browserCookieHeader(url: string): Promise<string> {
  if (!browserP) return "";
  try {
    const b = await getBrowser();
    if (!b.isConnected()) return "";
    const ctx = b.contexts()[0];
    const cookies = await ctx.cookies(url);
    return cookies.map((c: any) => `${c.name}=${c.value}`).join("; ");
  } catch {
    return "";
  }
}
