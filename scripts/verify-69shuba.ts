// 临时探针：69书吧（id=4）脚本源端到端验证——走 facade 引擎门面，与应用真实调用路径一致
import { Database } from "bun:sqlite";
import { engineFor } from "../src/source/facade";

const db = new Database("data/book.db");
const row = db.query("select * from sources where id=4").get() as any;
const eng = engineFor(row);

console.log("== search 剑来 ==");
const hits = await eng.search("剑来");
console.log("hits:", hits.length, "first:", JSON.stringify(hits[0], null, 1));

console.log("== bookInfo ==");
const info = await eng.bookInfo(hits[0].bookUrl ?? hits[0].detailUrl);
console.log(JSON.stringify({ ...info, intro: info.intro.slice(0, 60) + "…" }, null, 1));

console.log("== toc（全量翻页） ==");
const t0 = Date.now();
const chapters = await eng.toc(info.tocUrl);
console.log("chapters:", chapters.length, `(${Math.round((Date.now() - t0) / 1000)}s)`, "first:", chapters[0]?.title, "last:", chapters[chapters.length - 1]?.title);

console.log("== content ==");
const text = await eng.content(chapters[0].url);
console.log("content:", text.length, "字 head:", JSON.stringify(text.slice(0, 80)));
process.exit(0);
