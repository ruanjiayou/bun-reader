import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { auth, requireAuth, type AuthEnv } from "./auth";
import { log, requestLogger } from "./log";
import { sourceRoutes } from "./routes/sources";
import { bookRoutes } from "./routes/books";
import { searchRoutes } from "./routes/search";

const app = new Hono<AuthEnv>();

app.use(requestLogger());

app.route("/auth", auth);

const api = new Hono<AuthEnv>().use(requireAuth());
api.get("/ping", (c) => c.json({ pong: true, uid: c.get("uid") }));
api.route("/sources", sourceRoutes);
api.route("/books", bookRoutes);
api.route("/search", searchRoutes);
app.route("/api", api);

// SPA：挂在 /reader 前缀下，未命中路径回退 index.html
const webDist = "web/dist";
app.get("/reader", (c) => c.redirect("/reader/")); // 无尾斜杠也进应用（须注册在 /reader/* 通配之前，否则被截胡返回空响应）
app.use("/reader/*", serveStatic({ root: webDist, rewriteRequestPath: (p) => p.slice("/reader".length) || "/" }));
app.get("/reader/*", serveStatic({ root: webDist, path: "index.html" }));
app.get("/", (c) => c.redirect("/reader/"));

const port = Number(process.env.PORT ?? 8094);
log.info("boot", `bun-reader listening on http://localhost:${port}`);
// idleTimeout 默认 10s：目录多页翻页/全本缓存等长请求会被掐（warn: Bun.serve() timed out + Reader released），
// 调到上限 255s（Bun 允许的最大值）
Bun.serve({ port, idleTimeout: 255, fetch: app.fetch });
