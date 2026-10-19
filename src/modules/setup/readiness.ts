import type { ReadinessCheck, ReadinessResult } from "../sandbox/readiness";

export type ReadinessState = {
  id: string;
  result: ReadinessResult;
  checking: boolean;
  retryIn?: number;
};

export interface ReadinessClock {
  now(): number;
  interval(action: () => void, delay: number): () => void;
  timeout(action: () => void, delay: number): () => void;
}

const systemClock: ReadinessClock = {
  now: Date.now,
  interval(action, delay) {
    const timer = setInterval(action, delay);
    return () => clearInterval(timer);
  },
  timeout(action, delay) {
    const timer = setTimeout(action, delay);
    return () => clearTimeout(timer);
  },
};

export class ReadinessMonitor {
  private readonly states = new Map<string, ReadinessState>();
  private controller: AbortController | undefined;
  private stopTick: (() => void) | undefined;
  private onChange: (() => void) | undefined;
  private nextCheck = 0;
  private running = false;

  constructor(
    private readonly checks: readonly ReadinessCheck[],
    private readonly clock: ReadinessClock = systemClock,
  ) {
    for (const check of checks) {
      this.states.set(check.id, {
        id: check.id,
        result: { state: "skipped", label: check.skippedLabel },
        checking: false,
      });
    }
  }

  snapshot(): ReadinessState[] {
    return [...this.states.values()].map((state) => ({
      ...state,
      retryIn:
        this.controller && !this.running && state.result.state !== "ready"
          ? Math.max(0, Math.ceil((this.nextCheck - this.clock.now()) / 1000))
          : undefined,
    }));
  }

  start(onChange: () => void): void {
    this.stop();
    this.onChange = onChange;
    this.controller = new AbortController();
    void this.refresh(this.controller);
    this.stopTick = this.clock.interval(() => {
      if (!this.controller) return;
      if (!this.running && this.clock.now() >= this.nextCheck) void this.refresh(this.controller);
      else this.onChange?.();
    }, 1000);
  }

  stop(): void {
    this.onChange = undefined;
    this.stopTick?.();
    this.stopTick = undefined;
    const controller = this.controller;
    this.controller = undefined;
    controller?.abort();
    this.running = false;

    for (const state of this.states.values()) state.checking = false;
  }

  private async refresh(controller: AbortController): Promise<void> {
    this.running = true;
    const pending = new Map<string, Promise<ReadinessResult>>();
    const run = (check: ReadinessCheck): Promise<ReadinessResult> => {
      const existing = pending.get(check.id);
      if (existing) return existing;

      const task = (async (): Promise<ReadinessResult> => {
        const dependencies = await Promise.all(
          check.dependencies.map((id) => {
            const dependency = this.checks.find((candidate) => candidate.id === id);
            if (!dependency) throw new Error(`Unknown readiness dependency: ${id}`);

            return run(dependency);
          }),
        );

        if (controller.signal.aborted) return { state: "skipped", label: check.skippedLabel };

        const state = this.states.get(check.id)!;

        if (dependencies.some((result) => result.state !== "ready")) {
          state.result = { state: "skipped", label: check.skippedLabel };
          this.onChange?.();
          return state.result;
        }

        state.checking = true;
        this.onChange?.();
        const result = await this.runCheck(check, controller.signal);

        if (this.controller === controller) {
          state.result = result;
          state.checking = false;
          this.onChange?.();
        }

        return result;
      })();

      pending.set(check.id, task);
      return task;
    };

    try {
      await Promise.all(this.checks.map(run));
    } finally {
      if (this.controller === controller) {
        this.running = false;
        this.nextCheck = this.clock.now() + 10_000;
        this.onChange?.();
      }
    }
  }

  private runCheck(check: ReadinessCheck, signal: AbortSignal): Promise<ReadinessResult> {
    return new Promise((resolve) => {
      const controller = new AbortController();
      const cancel = () => {
        controller.abort();
        finish({ state: "skipped", label: check.skippedLabel });
      };
      const stopTimeout = this.clock.timeout(() => {
        controller.abort();
        finish({ state: "timeout", label: "Check timed out", instructions: check.instructions });
      }, 5000);
      const finish = (result: ReadinessResult) => {
        stopTimeout();
        signal.removeEventListener("abort", cancel);
        resolve(result);
      };

      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
      else {
        Promise.resolve()
          .then(() => check.run(controller.signal))
          .then(finish, (error: unknown) => {
            finish({
              state: "unknown",
              label: "Check failed",
              instructions: [error instanceof Error ? error.message : String(error)],
            });
          });
      }
    });
  }
}
