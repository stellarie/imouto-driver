/** Caps concurrent async work at `permits`. */
export class Semaphore {
  private readonly queue: Array<() => void> = [];

  constructor(private permits: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.permits > 0) this.permits--;
    else await new Promise<void>((r) => this.queue.push(r));
    try {
      return await fn();
    } finally {
      const next = this.queue.shift();
      if (next) next();
      else this.permits++;
    }
  }
}
