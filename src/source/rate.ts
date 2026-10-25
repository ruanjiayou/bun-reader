import { sqlite } from "../db";
import { log } from "../log";

// ---------- 缓存自适应限速器（滑动窗口计频，按书源维度学习并持久化） ----------
//
// 规则：
// - 窗口内只统计「成功」请求数（时间戳数组），失败后的重试等待不计入频率
// - 起步不限速（cap=0）；一旦失败：频率减半（向下取整，不限速时以窗口内实测成功数为准），
//   降频前的频率记入 high 作为收敛上限——high 是失败过的频率，永远不可再触及
// - 距上次失败超过一个完整窗口仍无错误 → 频率 = floor((当前+high)/2)，逐次逼近但恒低于 high
// - cap/high/windowMs/last_fail_at 存 rate_states 表（仅按书源维度），重启后沿用；
//   times[] 时间戳数组只在内存，同源多本书的缓存任务共用同一实例

interface RateState {
  cap: number; // 窗口内允许的成功请求数；0 = 不限速（初始态）
  high: number; // 最近一次降频前的频率（收敛上限）
  windowMs: number; // 滑动窗口时长，默认 60s
  lastFailAt: number; // 周期内是否出现过失败 → 由最近失败时间推导
}

const stmt = {
  get: sqlite.query("SELECT cap, high, window_ms, last_fail_at FROM rate_states WHERE source_id = ?"),
  upsert: sqlite.query("INSERT OR REPLACE INTO rate_states (source_id, cap, high, window_ms, last_fail_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"),
};

export class RateLimiter {
  cap: number;
  high: number;
  readonly windowMs: number;
  private lastFailAt: number;
  private times: number[] = []; // 窗口内成功请求的时间戳

  private constructor(s: RateState) {
    this.cap = s.cap;
    this.high = s.high;
    this.windowMs = s.windowMs;
    this.lastFailAt = s.lastFailAt;
  }

  static forSource(id: number): RateLimiter {
    const row = stmt.get.get(id) as any;
    return new RateLimiter(
      row
        ? { cap: row.cap, high: row.high, windowMs: row.window_ms, lastFailAt: row.last_fail_at }
        : { cap: 0, high: 0, windowMs: 60000, lastFailAt: 0 },
    );
  }

  private save(id: number) {
    stmt.upsert.run(id, this.cap, this.high, this.windowMs, this.lastFailAt, Date.now());
  }

  private prune(now = Date.now()) {
    while (this.times.length && now - this.times[0] >= this.windowMs) this.times.shift();
  }

  // 当前窗口内的实测频率（成功数/窗口），用于首次失败时确定基准
  observed(): number {
    this.prune();
    return this.times.length;
  }

  // 取得一个请求许可；窗口满则等到最早一条成功滑出窗口
  async acquire(id: number) {
    this.prune();
    if (this.cap > 0 && this.times.length >= this.cap) {
      const wait = this.times[0] + this.windowMs - Date.now();
      if (wait > 0) {
        log.info("cache", `限速等待 ${(wait / 1000).toFixed(1)}s（窗口 ${this.cap} 次/${this.windowMs / 1000}s 已满）`);
        await new Promise((r) => setTimeout(r, wait));
        this.prune();
      }
    }
  }

  // 成功：计入频率；距上次失败已过完整窗口仍无错误 → 向 high 收缩（floor 保证恒低于失败频率）
  onSuccess(id: number) {
    const now = Date.now();
    this.prune(now);
    this.times.push(now);
    if (this.cap > 0 && this.high > this.cap && now - this.lastFailAt >= this.windowMs) {
      const next = Math.min(this.high - 1, Math.floor((this.cap + this.high) / 2));
      if (next !== this.cap && next > 0) {
        this.cap = next;
        log.info("cache", `整窗无错误，频率回升至 ${this.cap} 次/${this.windowMs / 1000}s（上限 ${this.high} 不可触及）`);
        this.save(id);
      }
    }
  }

  // 失败：频率减半向下取整（不限速时以窗口内实测成功数为基准）
  onFailure(id: number) {
    this.lastFailAt = Date.now();
    if (this.cap === 0) {
      this.high = Math.max(2, this.observed());
      this.cap = Math.max(1, Math.floor(this.high / 2));
    } else if (this.cap > 1) {
      this.high = Math.max(this.high, this.cap);
      this.cap = Math.max(1, Math.floor(this.cap / 2));
    }
    log.info("cache", `请求失败，频率降为 ${this.cap} 次/${this.windowMs / 1000}s（上限 ${this.high}）`);
    this.save(id);
  }
}

// 同源共享：同站点多本书的缓存任务用同一个频率状态
const limiters = new Map<number, RateLimiter>();
export const limiterFor = (sourceId: number): RateLimiter => {
  let l = limiters.get(sourceId);
  if (!l) {
    l = RateLimiter.forSource(sourceId);
    limiters.set(sourceId, l);
  }
  return l;
};
