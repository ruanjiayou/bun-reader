import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { auth, requireAuth, type AuthEnv } from "./auth";
import { log, requestLogger } from "./log";
import { sourceRoutes } from "./routes/sources";
import { bookRoutes, startBookUpdateScheduler } from "./routes/books";
import { searchRoutes } from "./routes/search";

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
log.info("boot", `bun-reader listening on http://localhost:${port}`);
// 书籍更新巡检（默认每 6h；UPDATE_INTERVAL_MS=0 关闭；用户上传封面不被覆盖）
startBookUpdateScheduler();
// idleTimeout 默认 10s：目录多页翻页/全本缓存等长请求会被掐（warn: Bun.serve() timed out + Reader released），
// 调到上限 255s（Bun 允许的最大值）
Bun.serve({ port, idleTimeout: 255, fetch: app.fetch });
