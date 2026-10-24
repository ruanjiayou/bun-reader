import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { sources } from "../schema";
import { searchSource } from "../source/engine";
import { normalizeSource } from "../source/rule";
import type { AuthEnv } from "../auth";

// 聚合搜索：SSE 扇出到所有启用书源，逐源推送结果；并发 4、单源 15s 超时、失败静默计数
export const searchRoutes = new Hono<AuthEnv>();

searchRoutes.get("/", async (c) => {
  const q = c.req.query("q")?.trim();
  if (!q) return c.json({ error: "缺少搜索关键词 q" }, 400);
  const srcRows = await db.select().from(sources).where(eq(sources.enabled, true));

  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (data: any) => controller.enqueue(enc.encode(`data: ${JSON.stringify(data)}\n\n`));
      let done = 0;
      let failed = 0;
      let cursor = 0;
      const total = srcRows.length;
      send({ type: "start", total, q });

      const worker = async () => {
        while (cursor < total) {
          const s = srcRows[cursor++];
          try {
            const eng = normalizeSource(JSON.parse(s.json));
            const found = await Promise.race([
              searchSource(eng, q),
              new Promise<never>((_, rej) => setTimeout(() => rej(new Error("超时")), 15000)),
            ]);
            if ((found as any[]).length) send({ type: "books", sourceId: s.id, sourceName: s.name, books: found });
          } catch {
            failed++;
          }
          done++;
          send({ type: "progress", done, total, failed });
          await db.update(sources).set({ lastUseAt: new Date() }).where(eq(sources.id, s.id));
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, total) }, worker));
      send({ type: "end", done, total, failed });
      controller.close();
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
  });
});
