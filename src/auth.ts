import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { sign, verify } from "hono/jwt";
import { eq } from "drizzle-orm";
import { db } from "./db";
import { users } from "./schema";

// ponytail: 自部署默认密钥；生产用环境变量 JWT_SECRET 覆盖
const SECRET = process.env.JWT_SECRET ?? "bun-reader-dev-secret";
const COOKIE = "token";

export type AuthEnv = { Variables: { uid: number; username: string } };

async function issueToken(c: any, uid: number, username: string) {
  const token = await sign({ uid, username, exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30 }, SECRET, "HS256");
  setCookie(c, COOKIE, token, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
}

export function requireAuth() {
  return async (c: any, next: () => Promise<void>) => {
    const token = getCookie(c, COOKIE);
    if (!token) return c.json({ error: "未登录" }, 401);
    try {
      const p = (await verify(token, SECRET, "HS256")) as { uid: number; username: string };
      c.set("uid", p.uid);
      c.set("username", p.username);
      await next();
    } catch {
      return c.json({ error: "登录已过期" }, 401);
    }
  };
}

type Credentials = { username?: string; password?: string };
const readCreds = async (c: any): Promise<Credentials> => c.req.json().catch(() => ({}));

export const auth = new Hono<AuthEnv>();

auth.post("/register", async (c) => {
  const { username, password } = await readCreds(c);
  if (!username || !password || username.length < 2 || password.length < 6)
    return c.json({ error: "用户名≥2位，密码≥6位" }, 400);
  const exists = await db.select({ id: users.id }).from(users).where(eq(users.username, username));
  if (exists.length) return c.json({ error: "用户名已存在" }, 409);
  const hash = await Bun.password.hash(password);
  const [user] = await db.insert(users).values({ username, passwordHash: hash }).returning({ id: users.id });
  await issueToken(c, user.id, username);
  return c.json({ uid: user.id, username });
});

auth.post("/login", async (c) => {
  const { username, password } = await readCreds(c);
  if (!username || !password) return c.json({ error: "缺少用户名或密码" }, 400);
  const [user] = await db.select().from(users).where(eq(users.username, username));
  if (!user || !(await Bun.password.verify(password, user.passwordHash)))
    return c.json({ error: "用户名或密码错误" }, 401);
  await issueToken(c, user.id, username);
  return c.json({ uid: user.id, username });
});

auth.post("/logout", (c) => {
  deleteCookie(c, COOKIE, { path: "/" });
  return c.json({ ok: true });
});

auth.get("/me", requireAuth(), async (c) => {
  const uid = c.get("uid");
  const [u] = await db.select({ nickname: users.nickname, avatar: users.avatar }).from(users).where(eq(users.id, uid));
  return c.json({ uid, username: c.get("username"), nickname: u?.nickname ?? null, avatar: u?.avatar ?? null });
});

// 资料更新：昵称（≤20 字）与头像（dataURL，≤300KB，前端已 canvas 压缩到 128px）
auth.put("/profile", requireAuth(), async (c) => {
  const uid = c.get("uid");
  const body = await c.req.json().catch(() => ({} as any));
  const patch: { nickname?: string | null; avatar?: string | null } = {};
  if (body.nickname !== undefined) {
    const n = String(body.nickname ?? "").trim();
    if (n.length > 20) return c.json({ error: "昵称最多 20 字" }, 400);
    patch.nickname = n || null;
  }
  if (body.avatar !== undefined) {
    const a = body.avatar ? String(body.avatar) : "";
    if (a && !/^data:image\/(png|jpe?g|webp);base64,/.test(a)) return c.json({ error: "头像格式不支持" }, 400);
    if (a.length > 300 * 1024) return c.json({ error: "头像太大（≤300KB）" }, 400);
    patch.avatar = a || null;
  }
  if (!Object.keys(patch).length) return c.json({ error: "没有要更新的内容" }, 400);
  await db.update(users).set(patch).where(eq(users.id, uid));
  const [u] = await db.select({ nickname: users.nickname, avatar: users.avatar }).from(users).where(eq(users.id, uid));
  return c.json({ ok: true, nickname: u?.nickname ?? null, avatar: u?.avatar ?? null });
});

// 改密码：验旧密码，新密码 ≥6 位；成功后保持当前会话（cookie 不换发）
auth.put("/password", requireAuth(), async (c) => {
  const uid = c.get("uid");
  const body = await c.req.json().catch(() => ({} as any));
  const { oldPassword, newPassword } = body ?? {};
  if (!oldPassword || !newPassword) return c.json({ error: "缺少旧密码或新密码" }, 400);
  if (String(newPassword).length < 6) return c.json({ error: "新密码至少 6 位" }, 400);
  const [u] = await db.select().from(users).where(eq(users.id, uid));
  if (!u || !(await Bun.password.verify(String(oldPassword), u.passwordHash)))
    return c.json({ error: "旧密码不正确" }, 401);
  const hash = await Bun.password.hash(String(newPassword));
  await db.update(users).set({ passwordHash: hash }).where(eq(users.id, uid));
  return c.json({ ok: true });
});
