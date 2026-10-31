import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { db, sqlite } from "../src/db";
import { books, shelf } from "../src/schema";
import { bookRoutes, runOrphanCleanup } from "../src/routes/books";

// 预览即入库模型：书是全局的（books 不带 user_id），用户与书只有两条关系——shelf（书架）与 progress（进度）。
// 这里只测不联网的部分：书架增删、列表只露自己的、进度按用户隔离、每日清理回收没人收藏的书。

const tag = `test://shelf-${Date.now()}`;
const created: number[] = [];
let uidA = 0;
let uidB = 0;

// 直接挂 bookRoutes，用中间件伪造登录态（真实路由的鉴权在 app.use(requireAuth()) 里）
function appFor(uid: number) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    (c as any).set("uid", uid);
    await next();
  });
  app.route("/books", bookRoutes);
  return app;
}

async function addBook(suffix: string, opts: { old?: boolean; onShelfFor?: number } = {}) {
  const [row] = await db
    .insert(books)
    .values({
      bookUrl: `${tag}/${suffix}`,
      sourceId: null,
      name: `测试书 ${suffix}`,
      author: "测试作者",
      createdAt: opts.old ? new Date(Date.now() - 48 * 3600_000) : new Date(),
    })
    .returning({ id: books.id });
  created.push(row.id);
  if (opts.onShelfFor) await db.insert(shelf).values({ userId: opts.onShelfFor, bookId: row.id });
  return row.id;
}

beforeAll(() => {
  const ids = (sqlite.query("SELECT id FROM users ORDER BY id LIMIT 2").all() as { id: number }[]).map((r) => r.id);
  uidA = ids[0];
  uidB = ids[1] ?? ids[0];
});

afterAll(async () => {
  for (const id of created) {
    await db.delete(shelf).where(eq(shelf.bookId, id));
    await db.delete(books).where(eq(books.id, id));
  }
});

describe("书架关联（预览即入库）", () => {
  test("加书架只建关联：书在库里，列表里出现", async () => {
    const id = await addBook("add");
    const res = await appFor(uidA).request(`/books/${id}/shelf`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ onShelf: true });

    const list = (await (await appFor(uidA).request("/books")).json()) as any[];
    expect(list.some((b) => b.id === id)).toBe(true);
  });

  test("书架列表只列自己的；别人的书不出现", async () => {
    const id = await addBook("only-mine", { onShelfFor: uidA });
    const mine = (await (await appFor(uidA).request("/books")).json()) as any[];
    const others = (await (await appFor(uidB).request("/books")).json()) as any[];
    expect(mine.some((b) => b.id === id)).toBe(true);
    if (uidA !== uidB) expect(others.some((b) => b.id === id)).toBe(false);
  });

  test("移出书架：关联删除，书本身还在（能被重新加入）", async () => {
    const id = await addBook("remove", { onShelfFor: uidA });
    const del = await appFor(uidA).request(`/books/${id}/shelf`, { method: "DELETE" });
    expect(del.status).toBe(200);
    const left = await db.select({ id: shelf.bookId }).from(shelf).where(and(eq(shelf.userId, uidA), eq(shelf.bookId, id)));
    expect(left.length).toBe(0);
    const [still] = await db.select({ id: books.id }).from(books).where(eq(books.id, id));
    expect(still?.id).toBe(id);
  });

  test("进度按用户隔离：A 读到第 5 章，B 读同一本书仍是未开始", async () => {
    const id = await addBook("progress");
    await appFor(uidA).request(`/books/${id}/progress`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chapterIdx: 5, scrollPos: 12 }),
    });
    const a = await (await appFor(uidA).request(`/books/${id}`)).json();
    expect((a as any).progress).toMatchObject({ chapterIdx: 5, scrollPos: 12 });
    if (uidA !== uidB) {
      const b = await (await appFor(uidB).request(`/books/${id}`)).json();
      expect((b as any).progress).toBeNull();
    }
  });

  test("没人收藏且超过宽限期的书，被每日清理回收；有书架的保留", async () => {
    const orphan = await addBook("orphan", { old: true });
    const kept = await addBook("kept", { old: true, onShelfFor: uidA });
    await runOrphanCleanup();
    const gone = await db.select({ id: books.id }).from(books).where(eq(books.id, orphan));
    const alive = await db.select({ id: books.id }).from(books).where(eq(books.id, kept));
    expect(gone.length).toBe(0);
    expect(alive.length).toBe(1);
  });
});
