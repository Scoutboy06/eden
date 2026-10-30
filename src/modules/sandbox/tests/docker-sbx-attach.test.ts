import { expect, test } from "bun:test";
import { attachDockerSandbox, type AttachDependencies } from "../providers/docker-sbx";

function fakeChild() {
  let finish!: (exitCode: number) => void;
  const kills: Array<string | undefined> = [];
  const child = {
    exited: new Promise<number>((resolve) => (finish = resolve)),
    kill: (signal?: string) => {
      kills.push(signal);
      if (signal === "SIGKILL") finish(137);
    },
  };

  return { child: child as unknown as ReturnType<typeof Bun.spawn>, finish, kills };
}

function attach(overrides: AttachDependencies) {
  return attachDockerSandbox("example", { isTerminal: true, ...overrides });
}

test("attach restores the terminal after a normal exit", async () => {
  const events: string[] = [];
  const { child, finish } = fakeChild();

  const result = attach({
    saveTerminal: () => {
      events.push("saved");

      return () => events.push("restored");
    },
    spawn: () => {
      events.push("spawned");

      return child;
    },
  });
  finish(3);

  expect(await result).toBe(3);
  expect(events).toEqual(["saved", "spawned", "restored"]);
});

test("attach does not touch the terminal when stdin is not a terminal", async () => {
  const { child, finish } = fakeChild();
  let saved = false;

  const result = attachDockerSandbox("example", {
    isTerminal: false,
    saveTerminal: () => {
      saved = true;

      return () => {};
    },
    spawn: () => child,
  });
  finish(0);

  expect(await result).toBe(0);
  expect(saved).toBe(false);
});

test("attach restores the terminal when the provider cannot start", async () => {
  let restored = false;

  const result = attach({
    saveTerminal: () => () => {
      restored = true;
    },
    spawn: () => {
      throw new Error("ENOENT");
    },
  });

  await expect(result).rejects.toMatchObject({ code: "SANDBOX_PROVIDER_UNAVAILABLE" });
  expect(restored).toBe(true);
});

test("attach propagates a terminal save failure without spawning", async () => {
  let spawned = false;

  const result = attach({
    saveTerminal: () => {
      throw new Error("cannot save");
    },
    spawn: () => {
      spawned = true;

      return fakeChild().child;
    },
  });

  await expect(result).rejects.toThrow("cannot save");
  expect(spawned).toBe(false);
});

test("attach restores the terminal after a SIGINT cancellation", async () => {
  let restored = false;
  const { child, finish } = fakeChild();

  const result = attach({
    platform: "linux",
    saveTerminal: () => () => {
      restored = true;
    },
    spawn: () => child,
  });
  process.emit("SIGINT");
  finish(0);

  expect(await result).toBe(130);
  expect(restored).toBe(true);
});

test("attach on posix forwards SIGINT to the provider immediately", async () => {
  const { child, finish, kills } = fakeChild();

  const result = attach({ platform: "linux", saveTerminal: () => () => {}, spawn: () => child });
  process.emit("SIGINT");
  finish(0);
  await result;

  expect(kills).toEqual(["SIGINT"]);
});

test("attach on windows leaves SIGINT to the console and lets the provider exit", async () => {
  const { child, finish, kills } = fakeChild();

  const result = attach({
    platform: "win32",
    killGraceMs: 5000,
    saveTerminal: () => () => {},
    spawn: () => child,
  });
  process.emit("SIGINT");
  finish(0);

  expect(await result).toBe(130);
  expect(kills).toEqual([]);
});

test("attach on windows kills a provider that ignores SIGINT after the grace period", async () => {
  const { child, kills } = fakeChild();

  const result = attach({
    platform: "win32",
    killGraceMs: 20,
    saveTerminal: () => () => {},
    spawn: () => child,
  });
  process.emit("SIGINT");

  expect(await result).toBe(130);
  expect(kills).toEqual(["SIGKILL"]);
});
