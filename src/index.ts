import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { auth, requireAuth, type AuthEnv } from "./auth";
import { log, requestLogger } from "./log";
import { sourceRoutes } from "./routes/sources";
import { bookRoutes, startBookUpdateScheduler, startOrphanCleanup } from "./routes/books";
import { searchRoutes } from "./routes/search";
import { materializeScripts } from "./source/script";
import { closeBrowser } from "./source/browser";

const app = new Hono<AuthEnv>();

app.use(requestLogger());

// —— 缓存策略（jiayou.work 多应用共用域名按路径转发，/reader 的缓存头必须自己声明）——
// API 一律 no-store：网关/浏览器不得缓存任何接口响应
const noStore = async (c: any, next: () => Promise<void>) => {
  await next();
  c.header("Cache-Control", "no-store");
};
for (const p of ["/api/*", "/auth/*", "/gw/reader/api/*", "/gw/reader/auth/*"]) app.use(p, noStore);

// 静态资源：文件名带内容 hash 的 /assets/* 缓存一年 immutable；
// index.html / sw.js / manifest 必须 no-cache（每次导航回源校验）——
// SW 更新检测靠拿最新 sw.js，若被网关/浏览器缓存旧版，PWA 将永远停在旧版本（症状：build 后刷新无效）
const cacheStatic = (path: string, c: any) => {
  c.header("Cache-Control", /\/assets\//.test(path) ? "public, max-age=31536000, immutable" : "no-cache");
};

app.route("/auth", auth);

const api = new Hono<AuthEnv>().use(requireAuth());
api.get("/ping", (c) => c.json({ pong: true, uid: c.get("uid") }));
api.route("/sources", sourceRoutes);
api.route("/books", bookRoutes);
api.route("/search", searchRoutes);
app.route("/api", api);

// 网关前缀别名：前端请求统一带 /gw/reader 前缀；网关不剥前缀直接转发时命中这里
// （本地直连后端仍走 /api、/auth，两条路径等价）
app.route("/gw/reader/auth", auth);
app.route("/gw/reader/api", api);

// SPA：挂在 /reader 前缀下，未命中路径回退 index.html（缓存头见 cacheStatic）
const webDist = "web/reader";
app.get("/reader", (c) => c.redirect("/reader/")); // 无尾斜杠也进应用（须注册在 /reader/* 通配之前，否则被截胡返回空响应）
app.use("/reader/*", serveStatic({ root: webDist, rewriteRequestPath: (p) => p.slice("/reader".length) || "/", onFound: cacheStatic }));
app.get("/reader/*", serveStatic({ root: webDist, path: "index.html", onFound: cacheStatic }));
app.get("/", (c) => c.redirect("/reader/"));

const port = Number(process.env.PORT ?? 8094);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// EADDRINUSE 时把「谁占着端口」打出来（Linux 部署排查用）：
// 常见是上一次进程没退干净，或被杀后残留的 chromium 继承着监听 fd 还活着。
// 有这条日志就不用再猜了，直接 kill 对应 pid。
function portHolder(p: number): string {
  if (process.platform !== "linux") return "";
  const probes: [string, string[]][] = [
    ["ss", ["-lptnH", `sport = :${p}`]],
    ["lsof", ["-nP", `-i:${p}`]],
  ];
  for (const [cmd, args] of probes) {
    try {
      const r = Bun.spawnSync({ cmd: [cmd, ...args], stdout: "pipe", stderr: "ignore", timeout: 2000 });
      const out = r.stdout?.toString().trim();
      if (out) return out.split("\n").slice(0, 3).join(" | ");
    } catch {
      /* 命令不存在（没装 iproute2/lsof）*/
    }
  }
  return "";
}

// idleTimeout 默认 10s：目录多页翻页/全本缓存等长请求会被掐（warn: Bun.serve() timed out + Reader released），
// 调到上限 255s（Bun 允许的最大值）。
// 端口被占时重试几次：旧进程刚收到 SIGTERM、socket 可能还差几百毫秒才释放，
// 一撞就 exit 会让 supervisor 判定「启动失败」并退出重试链。
const BIND_TRIES = Math.max(1, Number(process.env.BIND_RETRIES ?? 3));
let server: ReturnType<typeof Bun.serve> | null = null;
for (let i = 1; i <= BIND_TRIES && !server; i++) {
  try {
    server = Bun.serve({ port, idleTimeout: 255, fetch: app.fetch });
  } catch (e: any) {
    const msg = String(e?.message ?? e).split("\n")[0];
    const busy = /in use|EADDRINUSE/i.test(msg);
    if (busy && i < BIND_TRIES) {
      log.warn("boot", `端口 ${port} 被占用，1s 后重试（${i}/${BIND_TRIES}）：${portHolder(port) || "占用者未知"}`);
      await sleep(1000);
      continue;
    }
    // 端口被占/无权限时不要再往上抛整段栈：部署脚本只认这条明确日志（常见：旧实例还没退干净）
    log.error(
      "boot",
      `端口 ${port} 监听失败：${msg}` + (busy ? `（占用者：${portHolder(port) || "未知"}；是否已有实例在运行？）` : ""),
    );
    process.exit(1);
  }
}
if (!server) process.exit(1);
log.info("boot", `bun-reader listening on http://localhost:${server.port}`);

// 优雅退出：部署脚本重启时先 SIGTERM 再起新进程，端口要立刻释放，
// 否则新进程 bind 撞上 EADDRINUSE（日志「端口 xxx 监听失败」）——看起来就是「重启失败」。
// 三步固定顺序：停监听（端口立刻可用）→ 等浏览器关完（顺手带走 chromium 子进程）→ 退出。
let closing = false;
async function shutdown(sig: string) {
  if (closing) return;
  closing = true;
  log.info("boot", `收到 ${sig}，关闭服务`);
  // 兜底：无论浏览器关得多慢，4s 内必退（supervisord 默认 stopwaitsecs=10，别等它 SIGKILL）
  setTimeout(() => process.exit(0), 4000);
  try {
    server!.stop(true);
  } catch {
    /* 已停止 */
  }
  await Promise.race([closeBrowser(), sleep(2500)]);
  process.exit(0);
}
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    void shutdown(sig);
  });
}

// —— 启动成功之后才做耗时初始化 ——
// 落盘脚本重建 = 逐条查库 + 读文件 + 生成并编译校验，源多时要几秒到几十秒。
// 放在 Bun.serve 之前会推迟端口就绪，部署脚本/反代健康检查等不到端口就判定「启动失败」并杀进程；
// 这里延后一拍执行，期间有请求进来时 ensureScriptFile 仍会惰性补出单个脚本，不必等全量重建。
setTimeout(() => {
  // 落盘脚本是产物、code 列才是真相：data/sources 被清空/换机器部署时按数据库重新生成
  materializeScripts()
    .then(({ total, generated }) => {
      if (generated.length) log.info("boot", `脚本源落盘重建 ${generated.length}/${total} 个（${generated.join(", ")}）`);
      else log.info("boot", `脚本源落盘 ${total} 个，无缺失`);
    })
    .catch((e) => log.warn("boot", `脚本源落盘检查失败：${e?.message ?? e}`));
  // 书籍更新巡检（默认每 6h；UPDATE_INTERVAL_MS=0 关闭；用户上传封面不被覆盖）
  startBookUpdateScheduler();
  // 孤儿书籍清理（默认每 24h；CLEANUP_INTERVAL_MS=0 关闭）：
  // 预览即入库会留下大量没人收藏的书，连同章节/进度/正文缓存一起回收
  startOrphanCleanup();
}, 1000);
