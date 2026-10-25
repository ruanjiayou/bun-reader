import { AsyncLocalStorage } from "node:async_hooks";
import { log } from "../log";

// —— Playwright 浏览器（WAF / 验证码 / 加密 AJAX 站点专用）——
// 单实例双模式：headed（默认，调试/预览，窗口可见、人工能介入验证）/
//              headless（真实抓取：目录后台补/全本缓存/正文/刷新，经 runWithBrowserMode("headless") 注入）。
// 共用同一个 profile（data/browser-profile），cookie 天然互通：
//   切换模式时等当前实例空闲（无未关页面）→ 关闭 → 以新模式重启（cookie 在 profile 里自动保留）。
// 不能同时开两个实例：Bun 下同进程第二个浏览器实例会卡死（实测 headed/headless 顺序均复现）；
//   因此调试与批量抓取并发时后到者等待，超时报「浏览器被 XX 占用」。
// 无头 UA 覆写：Chromium 无头 UA 含 HeadlessChrome 会被 WAF 识别，固定为正常 Chrome UA。
// BROWSER_HEADLESS=1 强制全局无头（服务器部署用）。
// channel 探测顺序：系统 Chrome → 系统 Edge → playwright 自带 chromium。

type BMode = "headed" | "headless";

const modeAls = new AsyncLocalStorage<BMode>();
// 在 fn 执行期间把浏览器模式设为 mode（真实抓取路径用：runWithBrowserMode("headless", ...)）
export function runWithBrowserMode<T>(mode: BMode, fn: () => T): T {
  return modeAls.run(mode, fn);
}

function resolveMode(explicit?: boolean): BMode {
  if (process.env.BROWSER_HEADLESS === "1") return "headless";
  if (explicit !== undefined) return explicit ? "headless" : "headed";
  return modeAls.getStore() ?? "headed";
}

// 无头上下文的 UA（去 HeadlessChrome；Chrome 大版本升级后需同步）
const HEADLESS_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";

const PROFILE = "data/browser-profile";
// 每模式在用页面数（page close 事件回调递减；等待模式切换的空闲判定用）
const pageCnt: Record<BMode, number> = { headed: 0, headless: 0 };
// 当前浏览器实例（同一时刻只有一个）
let state: { mode: BMode; p: Promise<any> } | null = null;
let switchChain: Promise<unknown> = Promise.resolve();
let exitHooked = false;

async function launch(mode: BMode): Promise<any> {
  const { chromium } = await import("playwright");
  const headless = mode === "headless";
  // 进程退出时顺手关浏览器，避免残留 chrome 进程（只挂一次）
  if (!exitHooked) {
    exitHooked = true;
    process.once("exit", () => {
      state?.p.then((c) => c.close()).catch(() => {});
    });
  }
  const tries: Record<string, string>[] = [{ channel: "chrome" }, { channel: "msedge" }, {}];
  const errs: string[] = [];
  for (const opt of tries) {
    try {
      const ctx = await chromium.launchPersistentContext(PROFILE, {
        headless,
        viewport: { width: 1280, height: 800 },
        ...(headless ? { userAgent: HEADLESS_UA } : {}),
        // 降低自动化特征（Cloudflare Turnstile 等会检测 navigator.webdriver / enable-automation）：
        // --disable-blink-features=AutomationControlled 让 webdriver=false；去掉默认 --enable-automation 开关
        args: ["--disable-blink-features=AutomationControlled"],
        ignoreDefaultArgs: ["--enable-automation"],
        ...opt,
      });
      log.info("browser", `浏览器已启动（${opt.channel ?? "chromium"} · ${headless ? "无头" : "有头"} · ${PROFILE}）`);
      return ctx;
    } catch (e: any) {
      errs.push(`${opt.channel ?? "chromium"}: ${String(e?.message ?? e).split("\n")[0]}`);
    }
  }
  throw new Error(
    `浏览器启动失败（依次尝试 chrome/msedge/chromium）——${errs.join("；")}。` +
      `常见原因：另一个进程（如正在运行的 bun-reader 服务或残留 chrome 窗口）占用了同一 profile 目录，请先关闭后重试`,
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 切换到目标模式：串行化；切换前等当前实例空闲（无未关页面），关闭后以新模式重启（同 profile）
function switchTo(mode: BMode): Promise<void> {
  const run = switchChain.then(async () => {
    if (state?.mode === mode) return;
    if (state) {
      const oldMode = state.mode;
      const deadline = Date.now() + 120_000;
      while (pageCnt[oldMode] > 0) {
        if (Date.now() > deadline)
          throw new Error(
            `浏览器当前被${oldMode === "headless" ? "无头抓取任务" : "有头会话"}占用，无法切换到${mode === "headless" ? "无头" : "有头"}模式，请稍后重试`,
          );
        await sleep(300);
      }
      const old = state.p;
      state = null;
      await old.then((c) => c.close()).catch(() => {});
      await sleep(500); // 等 profile 锁释放
    }
    state = { mode, p: launch(mode) };
  });
  switchChain = run.catch(() => {});
  return run;
}

async function getContext(mode: BMode): Promise<any> {
  if (!state || state.mode !== mode) await switchTo(mode);
  return state!.p;
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

// 打开一个浏览器页：自动等 WAF 挑战/验证码通过（Turnstile 类自动过，图片验证码需有头窗口手动完成），返回页面操作句柄
// headless 选项：true=无头（真实抓取路径经 runWithBrowserMode 注入，一般不用显式传）
export async function browserOpen(url: string, opts: { headless?: boolean; timeoutMs?: number } = {}): Promise<BrowserPage> {
  const mode = resolveMode(opts.headless);
  const ctx = await getContext(mode);
  const page = await ctx.newPage();
  pageCnt[mode]++;
  page.once("close", () => pageCnt[mode]--); // 任何途径关闭（句柄 close / 出错兜底 / 用户关窗口）都递减
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
export async function browserText(url: string, opts: { headless?: boolean; timeoutMs?: number } = {}) {
  const p = await browserOpen(url, opts);
  try {
    return { status: 200, text: await p.html(), url: p.url() };
  } finally {
    await p.close();
  }
}

// 持久化 profile 里某 URL 同域的 cookie 串（"k=v; k=v"），供服务端 fetchText 合并复用；
// 浏览器实例未启动时返回空串（不会为了取 cookie 拉起浏览器；单实例共用 profile，无需分模式）
export async function browserCookieHeader(url: string, headless?: boolean): Promise<string> {
  if (!state) return "";
  try {
    const ctx = await state.p;
    const cookies = await ctx.cookies(url);
    return cookies.map((c: any) => `${c.name}=${c.value}`).join("; ");
  } catch {
    return "";
  }
}
