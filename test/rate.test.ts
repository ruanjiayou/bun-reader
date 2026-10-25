import { beforeEach, describe, expect, test } from "bun:test";
import { sqlite } from "../src/db";
import { RateLimiter, limiterFor } from "../src/source/rate";

// 用一个不存在的 source id 拿默认状态（cap=0 不限速），再手动设定场景；每个用例前清持久化状态
const SRC = 990001;
const fresh = () => RateLimiter.forSource(SRC);
beforeEach(() => sqlite.query("DELETE FROM rate_states WHERE source_id = ?").run(SRC));

describe("自适应限速器", () => {
  test("起步不限速，窗口内 16 次成功后失败 → 频率减半为 8", () => {
    const l = fresh();
    expect(l.cap).toBe(0); // 初始不限速
    for (let i = 0; i < 16; i++) l.onSuccess(SRC);
    expect(l.observed()).toBe(16);
    l.onFailure(SRC);
    expect(l.high).toBe(16); // 降频前频率记为收敛上限
    expect(l.cap).toBe(8); // 原频率减半
  });

  test("已有频率下再失败 → 继续减半，high 只升不降", () => {
    const l = fresh();
    l.onSuccess(SRC);
    l.onFailure(SRC); // 实测 1 次 → high=2, cap=1
    expect(l.cap).toBe(1);
    (l as any).cap = 8;
    (l as any).high = 8;
    l.onFailure(SRC);
    expect(l.cap).toBe(4);
    expect(l.high).toBe(8);
  });

  test("距上次失败满一个窗口无错误 → 频率向下取整收缩，恒低于失败过的频率", () => {
    const l = fresh();
    for (let i = 0; i < 16; i++) l.onSuccess(SRC);
    l.onFailure(SRC); // cap=8, high=16
    // 模拟整窗无错误：把 lastFailAt 拨回 61s 前
    (l as any).lastFailAt = Date.now() - 61000;
    l.onSuccess(SRC);
    expect(l.cap).toBe(12); // floor((8+16)/2)
    (l as any).lastFailAt = Date.now() - 61000;
    l.onSuccess(SRC);
    expect(l.cap).toBe(14);
    (l as any).lastFailAt = Date.now() - 61000;
    l.onSuccess(SRC);
    expect(l.cap).toBe(15); // floor((14+16)/2)
    (l as any).lastFailAt = Date.now() - 61000;
    l.onSuccess(SRC);
    expect(l.cap).toBe(15); // floor((15+16)/2)=15，停住——失败过的 16 永不可再触及
    // 未满整窗时不应回升
    l.onFailure(SRC); // cap=7（floor(15/2)）
    l.onSuccess(SRC); // 刚失败 0s，不应收敛
    expect(l.cap).toBe(7);
  });

  test("窗口滑动：超出 windowMs 的成功记录被淘汰", async () => {
    const l = fresh();
    (l as any).windowMs = 80;
    l.onSuccess(SRC);
    l.onSuccess(SRC);
    expect(l.observed()).toBe(2);
    await new Promise((r) => setTimeout(r, 120));
    expect(l.observed()).toBe(0);
  });

  test("窗口满时 acquire 等待最早记录滑出后才放行", async () => {
    const l = fresh();
    (l as any).windowMs = 150;
    l.cap = 2;
    l.onSuccess(SRC);
    l.onSuccess(SRC);
    const t0 = Date.now();
    await l.acquire(SRC);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(50); // 等到最早一条出窗
    expect(l.observed()).toBeLessThanOrEqual(2);
  });

  test("状态持久化：同源再次 forSource 沿用学习到的频率；limiterFor 同源共享实例", () => {
    const l = fresh();
    for (let i = 0; i < 10; i++) l.onSuccess(SRC);
    l.onFailure(SRC); // cap=5, high=10
    const again = RateLimiter.forSource(SRC);
    expect(again.cap).toBe(5);
    expect(again.high).toBe(10);
    expect(limiterFor(SRC)).toBe(limiterFor(SRC)); // 同源共享
  });
});
