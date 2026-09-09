/** 页面租约只存在内存；任一页面可见即可加速，失联页面会自动过期。 */
export class SyncPresence {
  private readonly pages = new Map<string, number>();

  constructor(private readonly ttlMs = 45_000) {}

  update(id: string, visible: boolean, now = Date.now()) {
    this.hasVisible(now);
    if (visible) this.pages.set(id, now + this.ttlMs);
    else this.pages.delete(id);
  }

  hasVisible(now = Date.now()) {
    for (const [id, expires] of this.pages) {
      if (expires <= now) this.pages.delete(id);
    }
    return this.pages.size > 0;
  }
}
