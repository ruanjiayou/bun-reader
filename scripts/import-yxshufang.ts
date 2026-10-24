// 一次性导入脚本：幽香书房书源（与 /api/sources/import 相同的去重 upsert 逻辑）
import { db, sqlite } from "../src/db";
import { sources } from "../src/schema";
import { normalizeSource } from "../src/source/rule";
import { eq } from "drizzle-orm";

const raw = JSON.parse(await Bun.file("sources/yxshufang.json").text());
const s = normalizeSource(raw);
const [exist] = await db.select({ id: sources.id }).from(sources).where(eq(sources.bookUrl, s.bookSourceUrl));
if (exist) {
  await db.update(sources).set({ name: s.bookSourceName, group: s.bookSourceGroup ?? "默认", json: JSON.stringify(s) }).where(eq(sources.id, exist.id));
  console.log("updated id=", exist.id);
} else {
  const [row] = await db
    .insert(sources)
    .values({ name: s.bookSourceName, bookUrl: s.bookSourceUrl, group: s.bookSourceGroup ?? "默认", enabled: s.enabled !== false, json: JSON.stringify(s) })
    .returning({ id: sources.id });
  console.log("inserted id=", row.id);
}
