/** 简单固定窗口限流器（进程内）：绑定/刷新等敏感端点防爆破与失败退避 */
export class RateLimiter {
  #limit: number;
  #windowMs: number;
  #buckets = new Map<string, { count: number; resetAt: number }>();

  constructor(limit: number, windowMs: number) {
    this.#limit = limit;
    this.#windowMs = windowMs;
  }

  /** 返回 true 表示本次请求放行；false 表示已超限 */
  check(key: string): boolean {
    const now = Date.now();
    const bucket = this.#buckets.get(key);
    if (bucket === undefined || bucket.resetAt <= now) {
      this.#buckets.set(key, { count: 1, resetAt: now + this.#windowMs });
      return true;
    }
    if (bucket.count >= this.#limit) return false;
    bucket.count += 1;
    return true;
  }
}
