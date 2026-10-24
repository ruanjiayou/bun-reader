// 一次性验证：幽香书房书源规则对真实站点跑全链路（详情→目录→正文）
import { db } from "../src/db";
import { sources } from "../src/schema";
import { normalizeSource } from "../src/source/rule";
import { getBookInfo, getToc, getContent } from "../src/source/engine";
import { eq } from "drizzle-orm";

const [row] = await db.select().from(sources).where(eq(sources.id, 3));
const src = normalizeSource(JSON.parse(row.json));
const log = (lv: string, step: string, msg: string) => console.log(`[${lv}][${step}] ${msg}`);

const bookUrl = process.argv[2] ?? "https://www.yxshufang.com/book/51RA9.html";
const info = await getBookInfo(src, bookUrl, log as any);
console.log("详情:", JSON.stringify({ name: info.name, author: info.author, cover: info.cover, latest: info.latestChapter, tocUrl: info.tocUrl }, null, 2));
const toc = await getToc(src, info.tocUrl, log as any);
console.log(`目录: ${toc.length} 章，首章 ${toc[0]?.title} · ${toc[0]?.url}`);
const content = await getContent(src, toc[0].url, log as any);
console.log(`首章正文 ${content.length} 字，前 60 字：${content.slice(0, 60).replace(/\n/g, "/")}`);
