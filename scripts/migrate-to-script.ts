// 一次性迁移：库内 rules 书源 → script（转换器生成代码 + 落盘），并抽样验证全链路
// 用法：bun scripts/migrate-to-script.ts [--verify]
import { eq } from "drizzle-orm";
import { db } from "../src/db";
import { sources } from "../src/schema";
import { rulesToScript } from "../src/source/convert";
import { saveScriptFile } from "../src/source/script";
import { engineFor } from "../src/source/facade";

const doVerify = process.argv.includes("--verify");
const force = process.argv.includes("--force"); // 已转换的也重新生成代码（转换器修复后刷新）
const rows = await db.select().from(sources);
for (const r of rows) {
  if (r.type === "script" && !force) {
    console.log(`#${r.id} ${r.name} 已是 script，跳过`);
    continue;
  }
  const code = rulesToScript(JSON.parse(r.json));
  await db.update(sources).set({ type: "script", code }).where(eq(sources.id, r.id));
  saveScriptFile(r.id, code);
  console.log(`#${r.id} ${r.name} → script（${code.length} 字）`);
}

if (!doVerify) process.exit(0);

// —— 抽样验证：sto66(id=2) 搜索；两源各取一本在架书验 目录+正文 ——
const samples: { id: number; search?: string; bookUrl: string }[] = [
  { id: 2, search: "凡人", bookUrl: "https://www.sto66.com/book/2ikIewnkRl2FtyBHUDr8xE.html" },
  { id: 3, bookUrl: "https://www.yxshufang.com/book/51RA9.html" },
];
for (const s of samples) {
  const [row] = await db.select().from(sources).where(eq(sources.id, s.id));
  const eng = engineFor(row);
  console.log(`\n== 验证 #${row.id} ${row.name} ==`);
  try {
    if (s.search) {
      const books = await eng.search(s.search, (lv, st, m) => console.log(`  [${lv}]${st} ${m.slice(0, 100)}`));
      console.log(`  搜索：${books.length} 条，首条 ${books[0]?.name ?? "-"}`);
    }
    const info = await eng.bookInfo(s.bookUrl);
    console.log(`  详情：${info.name || "?"} · tocUrl=${info.tocUrl}`);
    const toc = await eng.toc(info.tocUrl, (lv, st, m) => console.log(`  [${lv}]${st} ${m.slice(0, 100)}`));
    console.log(`  目录：${toc.length} 章，首章 ${toc[0]?.title ?? "-"}`);
    const text = await eng.content(toc[0].url, (lv, st, m) => console.log(`  [${lv}]${st} ${m.slice(0, 100)}`));
    console.log(`  正文：${text.length} 字，预览 ${text.slice(0, 40).replace(/\n/g, " ")}…`);
  } catch (e: any) {
    console.log(`  ✗ 失败：${e?.message ?? e}`);
  }
}
process.exit(0);
