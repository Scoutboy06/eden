import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import * as v from "valibot";

import { createFileConfigService } from "../config.service";
import { ConfigSchema } from "../schema";

test("global project registry accepts stable keys with a display name and repository path", () => {
  expect(
    v.parse(ConfigSchema, {
      projects: { "Inet.Server": { name: "Inet.Server", path: "/work/inet" } },
    }).projects,
  ).toEqual({ "Inet.Server": { name: "Inet.Server", path: "/work/inet" } });
});

test("global project registry accepts null as an absent registry", () => {
  expect(v.parse(ConfigSchema, { projects: null }).projects).toBeNull();
});

test("project registry rejects entries without both name and path", () => {
  expect(v.safeParse(ConfigSchema, { projects: { broken: { name: "Broken" } } }).success).toBe(
    false,
  );
});

test("project paths expand home and normalize when global config is read", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eden-project-config-"));
  const path = join(directory, "config.yaml");
  await writeFile(
    path,
    'projects:\n  "Inet.Server":\n    name: Inet.Server\n    path: ~/src/inet/../eden\n',
  );

  try {
    const config = await createFileConfigService({ pathsLowToHigh: [path] }).read();
    expect(config.projects?.["Inet.Server"]?.path).toBe(join(homedir(), "src", "eden"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("project paths reject relative paths and null bytes", () => {
  for (const path of ["src/eden", "~other/eden", "/work/eden\0repo"]) {
    expect(v.safeParse(ConfigSchema, { projects: { eden: { name: "Eden", path } } }).success).toBe(
      false,
    );
  }
});

test("project keys reject URL dot segments while preserving URL-encoded names", () => {
  for (const key of [".", ".."]) {
    expect(
      v.safeParse(ConfigSchema, { projects: { [key]: { name: key, path: "/work/eden" } } }).success,
    ).toBe(false);
  }

  expect(
    v.parse(ConfigSchema, {
      projects: { "Eden & Co": { name: "Eden & Co", path: "/work/eden" } },
    }).projects,
  ).toEqual({ "Eden & Co": { name: "Eden & Co", path: "/work/eden" } });
});
