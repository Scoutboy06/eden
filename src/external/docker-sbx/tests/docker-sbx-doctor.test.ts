import { expect, test } from "bun:test";
import { DockerSandboxProvider } from "../provider";
import type { SandboxdLinkProbe } from "../sandboxd-links";

const localAppData = String.raw`C:\Users\example\AppData\Local`;
const base = String.raw`C:\Users\example\AppData\Local\Temp`;
const numbered = String.raw`C:\Users\example\AppData\Local\Temp\1`;
const otherNumbered = String.raw`C:\Users\example\AppData\Local\Temp\2`;
const stateDir = String.raw`C:\Users\example\AppData\Local\DockerSandboxes\sandboxes\state\sandboxd`;
const elsewhere = String.raw`C:\elsewhere`;
const linkName = "sboxd-fafa863a";

function fake(
  links: Record<string, string | undefined>,
  overrides: Partial<SandboxdLinkProbe> = {},
) {
  const entries = new Map(Object.entries(links));
  const created: string[][] = [];
  const probe: SandboxdLinkProbe = {
    platform: "win32",
    env: { LOCALAPPDATA: localAppData, TEMP: numbered },
    readText: () => undefined,
    exists: (path) => entries.has(path),
    readLink: (path) => entries.get(path),
    readDir: (path) =>
      path === base
        ? ["1", "2", "notes", "sboxd-other"]
        : path === numbered
          ? [linkName, "scratch"]
          : [],
    createJunction: (path, target) => {
      created.push([path, target]);
      entries.set(path, target);
    },
    ...overrides,
  };

  return { probe, created, entries };
}

function provider(probe: SandboxdLinkProbe) {
  return new DockerSandboxProvider(undefined, { sandboxdLinkProbe: probe });
}

test("doctor reports ok, missing and wrong-target links across temp folders", async () => {
  const { probe } = fake({
    [`${numbered}\\${linkName}`]: `${stateDir}\\`,
    [`${otherNumbered}\\${linkName}`]: elsewhere,
  });

  const report = await provider(probe).diagnose({ fix: false });

  expect(report).toEqual({
    applicable: true,
    stateDir,
    temp: numbered,
    links: [
      { path: `${base}\\${linkName}`, status: "missing" },
      { path: `${numbered}\\${linkName}`, status: "ok" },
      { path: `${otherNumbered}\\${linkName}`, status: "wrong-target", actual: elsewhere },
    ],
  });
});

test("doctor lists a link once when TEMP is a short path to a scanned folder", async () => {
  const shortTemp = String.raw`C:\Users\EXAMPL~1\AppData\Local\Temp\1`;
  const { probe } = fake(
    { [`${numbered}\\${linkName}`]: stateDir },
    {
      env: { LOCALAPPDATA: localAppData, TEMP: shortTemp },
      readDir: (path) => (path === base ? ["1"] : path === shortTemp ? [linkName] : []),
      readLink: (path) =>
        path === `${numbered}\\${linkName}` || path === `${shortTemp}\\${linkName}`
          ? stateDir
          : undefined,
      realPath: (path) => (path === shortTemp ? numbered : path),
    },
  );

  const report = await provider(probe).diagnose({ fix: false });

  expect(report.links).toEqual([
    { path: `${base}\\${linkName}`, status: "missing" },
    { path: `${numbered}\\${linkName}`, status: "ok" },
  ]);
});

test("doctor compares targets case-insensitively and ignores the extended prefix", async () => {
  const { probe } = fake({
    [`${base}\\${linkName}`]: stateDir.toUpperCase(),
    [`${numbered}\\${linkName}`]: `\\\\?\\${stateDir}`,
    [`${otherNumbered}\\${linkName}`]: stateDir,
  });

  const report = await provider(probe).diagnose({ fix: false });

  expect(report.links.map((link) => link.status)).toEqual(["ok", "ok", "ok"]);
});

test("doctor treats a real folder in the link's place as a wrong target", async () => {
  const { probe } = fake({
    [`${base}\\${linkName}`]: stateDir,
    [`${numbered}\\${linkName}`]: stateDir,
    [`${otherNumbered}\\${linkName}`]: undefined,
  });

  const report = await provider(probe).diagnose({ fix: false });

  expect(report.links.at(-1)).toEqual({
    path: `${otherNumbered}\\${linkName}`,
    status: "wrong-target",
    actual: "not a link",
  });
});

test("doctor uses link prefixes from daemon.log", async () => {
  const logged = String.raw`D:\Custom\Temp\sboxd-0badc0de`;
  const log = `time=1 msg="rootfs disk does not exist: ${logged}\\containerd\\root\\rwlayer.img"\n`;
  const { probe } = fake(
    {},
    {
      env: { LOCALAPPDATA: localAppData },
      readText: (path) => (path === `${stateDir}\\daemon.log` ? log : undefined),
    },
  );

  const report = await provider(probe).diagnose({ fix: false });

  expect(report.links.map((link) => link.path)).toEqual([
    `${base}\\sboxd-0badc0de`,
    `${base}\\1\\sboxd-0badc0de`,
    `${base}\\2\\sboxd-0badc0de`,
    logged,
  ]);
});

test("doctor --fix creates only the missing links and never touches others", async () => {
  const wrong = `${otherNumbered}\\${linkName}`;
  const { probe, created, entries } = fake({
    [`${numbered}\\${linkName}`]: stateDir,
    [wrong]: elsewhere,
  });

  const report = await provider(probe).diagnose({ fix: true });

  expect(created).toEqual([[`${base}\\${linkName}`, stateDir]]);
  expect(report.links.map((link) => link.status)).toEqual(["created", "ok", "wrong-target"]);
  expect(entries.get(wrong)).toBe(elsewhere);
});

test("doctor --fix reports a junction that could not be created", async () => {
  const { probe } = fake(
    { [`${numbered}\\${linkName}`]: stateDir, [`${otherNumbered}\\${linkName}`]: stateDir },
    {
      createJunction: () => {
        throw new Error("EPERM");
      },
    },
  );

  const report = await provider(probe).diagnose({ fix: true });

  expect(report.links[0]).toEqual({
    path: `${base}\\${linkName}`,
    status: "failed",
    error: "EPERM",
  });
});

test("doctor does not apply off Windows", async () => {
  const { probe, created } = fake({}, { platform: "linux" });

  const report = await provider(probe).diagnose({ fix: true });

  expect(report).toEqual({ applicable: false, links: [] });
  expect(created).toEqual([]);
});
