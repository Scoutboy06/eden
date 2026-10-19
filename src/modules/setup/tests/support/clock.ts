import type { ReadinessClock } from "../../readiness";

export class ManualClock implements ReadinessClock {
  private time = 0;
  private nextId = 0;
  private readonly tasks = new Map<number, { action: () => void; due: number; period?: number }>();

  now(): number {
    return this.time;
  }

  interval(action: () => void, delay: number): () => void {
    return this.schedule(action, delay, delay);
  }

  timeout(action: () => void, delay: number): () => void {
    return this.schedule(action, delay);
  }

  async advance(duration: number): Promise<void> {
    const end = this.time + duration;

    while (true) {
      const next = [...this.tasks.entries()]
        .filter(([, task]) => task.due <= end)
        .sort((a, b) => a[1].due - b[1].due)[0];
      if (!next) break;

      const [id, task] = next;
      this.time = task.due;
      if (task.period) task.due += task.period;
      else this.tasks.delete(id);

      task.action();
      await this.settle();
    }

    this.time = end;
    await this.settle();
  }

  async settle(): Promise<void> {
    for (let index = 0; index < 40; index++) await Promise.resolve();
  }

  get pendingTasks(): number {
    return this.tasks.size;
  }

  private schedule(action: () => void, delay: number, period?: number): () => void {
    const id = this.nextId++;
    this.tasks.set(id, { action, due: this.time + delay, period });

    return () => {
      this.tasks.delete(id);
    };
  }
}
