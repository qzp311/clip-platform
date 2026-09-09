/** 限制 FFmpeg 渲染并发数的任务队列 */
export class RenderJobQueue {
  private active = 0;
  private readonly queue: Array<() => void> = [];
  private idleWaiters: Array<() => void> = [];

  constructor(private readonly maxConcurrent: number) {}

  enqueue<T>(job: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = () => {
        this.active += 1;
        void job()
          .then(resolve, reject)
          .finally(() => {
            this.active -= 1;
            this.pump();
            this.notifyIdleIfReady();
          });
      };

      if (this.active < this.maxConcurrent) {
        run();
      } else {
        this.queue.push(run);
      }
    });
  }

  async onIdle(): Promise<void> {
    if (this.active === 0 && this.queue.length === 0) return;
    await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  private pump(): void {
    while (this.active < this.maxConcurrent && this.queue.length > 0) {
      const next = this.queue.shift();
      next?.();
    }
  }

  private notifyIdleIfReady(): void {
    if (this.active > 0 || this.queue.length > 0) return;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolve of waiters) resolve();
  }
}
