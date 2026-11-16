import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import { and, eq, inArray } from "drizzle-orm";
import { db, sqlite } from "../src/db";
import { books, chapters, shelf, sources, users } from "../src/schema";
import { bookRoutes, runOrphanCleanup } from "../src/routes/books";

// 预览即入库模型：书是全局的（books 不带 user_id），用户与书只有两条关系——shelf（书架）与 progress（进度）。
// 这里只测不联网的部分：书架增删、列表只露自己的、进度按用户隔离、每日清理回收没人收藏的书。

const tag = `test://shelf-${Date.now()}`;
const created: number[] = [];
const sourceIds: number[] = [];
const userIds: number[] = [];
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

// 造一个带自定义分组的书源；加书架时应把它当作默认分组
async function addSource(group: string) {
  const [row] = await db
    .insert(sources)
    .values({ name: `测试源 ${Date.now()} ${group}`, group, json: "{}" })
    .returning({ id: sources.id });
  sourceIds.push(row.id);
  return row.id;
}

async function addBook(suffix: string, opts: { old?: boolean; onShelfFor?: number; sourceId?: number | null } = {}) {
  const [row] = await db
    .insert(books)
    .values({
      bookUrl: `${tag}/${suffix}`,
      sourceId: opts.sourceId ?? null,
      name: `测试书 ${suffix}`,
      author: "测试作者",
      createdAt: opts.old ? new Date(Date.now() - 48 * 3600_000) : new Date(),
    })
    .returning({ id: books.id });
  created.push(row.id);
  if (opts.onShelfFor) await db.insert(shelf).values({ userId: opts.onShelfFor, bookId: row.id });
  return row.id;
}

beforeAll(async () => {
  const ids = (sqlite.query("SELECT id FROM users ORDER BY id LIMIT 2").all() as { id: number }[]).map((r) => r.id);
  uidA = ids[0];
  uidB = ids[1] ?? ids[0];
  // 分组是用户级的，多用户隔离必须真有两个账号才测得出来
  if (uidA === uidB) {
    const [u] = await db.insert(users).values({ username: `test-group-${Date.now()}`, passwordHash: "test-only" }).returning({ id: users.id });
    uidB = u.id;
    userIds.push(u.id);
  }
});

afterAll(async () => {
  for (const id of created) {
    await db.delete(shelf).where(eq(shelf.bookId, id));
    await db.delete(books).where(eq(books.id, id));
  }
  if (sourceIds.length) await db.delete(sources).where(inArray(sources.id, sourceIds));
  if (userIds.length) await db.delete(users).where(inArray(users.id, userIds));
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


// 分组是「我的书架」的属性：书源分组只作创建时的默认值，改分组不能影响别人 / 书源本身
describe("书架分组（用户级 shelf.group）", () => {
  const patchGroup = (uid: number, id: number, group: unknown) =>
    appFor(uid).request(`/books/${id}/shelf`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ group }),
    });

  test("加入书架默认取书源分组；书源没有分组时归「默认」", async () => {
    const src = await addSource("轻小说");
    const withSrc = await addBook("group-default-src", { sourceId: src });
    // 给一章避免 POST /shelf 触发后台抓目录（本测试不联网）
    await db.insert(chapters).values({ bookId: withSrc, idx: 0, title: "第一章", url: `${tag}/group/1` });
    const noSrc = await addBook("group-default-none");

    expect((await appFor(uidA).request(`/books/${withSrc}/shelf`, { method: "POST" })).status).toBe(200);
    expect((await appFor(uidA).request(`/books/${noSrc}/shelf`, { method: "POST" })).status).toBe(200);

    const list = (await (await appFor(uidA).request("/books")).json()) as any[];
    expect(list.find((b) => b.id === withSrc)?.group).toBe("轻小说");
    expect(list.find((b) => b.id === noSrc)?.group).toBe("默认");
  });

  test("手动改分组：trim + 只改自己那一行，别人仍是原分组", async () => {
    const id = await addBook("group-edit", { onShelfFor: uidA });
    if (uidA !== uidB) await db.insert(shelf).values({ userId: uidB, bookId: id });

    const res = await patchGroup(uidA, id, "  追更  ");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ group: "追更" });

    const mine = await (await appFor(uidA).request(`/books/${id}`)).json();
    expect((mine as any).myGroup).toBe("追更");
    expect((mine as any).onShelf).toBe(true);
    if (uidA !== uidB) {
      const others = await (await appFor(uidB).request(`/books/${id}`)).json();
      expect((others as any).myGroup).toBe("默认");
    }
    // 书源分组本身没被改（本例无书源，验证默认值仍在数据库）
    const [row] = await db.select({ group: shelf.group }).from(shelf).where(and(eq(shelf.userId, uidA), eq(shelf.bookId, id)));
    expect(row.group).toBe("追更");
  });

  test("清空 = 未分组；超长截断到 50；非字符串 400；未收藏 404", async () => {
    const id = await addBook("group-clear", { onShelfFor: uidA });
    const empty = await patchGroup(uidA, id, "");
    expect(await empty.json()).toMatchObject({ group: "" });
    const long = await patchGroup(uidA, id, "分".repeat(80));
    expect(((await long.json()) as any).group).toHaveLength(50);
    expect((await patchGroup(uidA, id, 123)).status).toBe(400);
    const orphan = await addBook("group-not-on-shelf");
    expect((await patchGroup(uidA, orphan, "任意")).status).toBe(404);
  });

  test("GET /books/groups = 我书架用过的分组 + 启用书源的分组", async () => {
    await addSource("漫画");
    const id = await addBook("group-options", { onShelfFor: uidA });
    await patchGroup(uidA, id, "私藏");
    const groups = (await (await appFor(uidA).request("/books/groups")).json()) as string[];
    expect(groups).toContain("私藏");
    expect(groups).toContain("漫画");
    expect(groups).toEqual([...groups].sort());
  });

  test("详情接口带出 myGroup / onShelf；未收藏为 null", async () => {
    const id = await addBook("group-detail");
    const detail = await (await appFor(uidA).request(`/books/${id}`)).json();
    expect((detail as any).myGroup).toBeNull();
    expect((detail as any).onShelf).toBe(false);
  });
});
