import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { auth, requireAuth, type AuthEnv } from "./auth";
import { sourceRoutes } from "./routes/sources";

const app = new Hono<AuthEnv>();

app.route("/auth", auth);

const api = new Hono<AuthEnv>().use(requireAuth());
api.get("/ping", (c) => c.json({ pong: true, uid: c.get("uid") }));
api.route("/sources", sourceRoutes);
app.route("/api", api);

// SPA：构建产物托管，未命中路径回退 index.html
const webDist = "web/dist";
app.use("*", serveStatic({ root: webDist, rewriteRequestPath: (p) => p }));
app.get("*", serveStatic({ root: webDist, path: "index.html" }));

const port = Number(process.env.PORT ?? 3000);
console.log(`bun-reader listening on http://localhost:${port}`);
Bun.serve({ port, fetch: app.fetch });
