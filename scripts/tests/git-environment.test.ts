import { expect, test } from "bun:test";
import { isolateGitEnvironment } from "../git-environment";

test("removes inherited Git controls without changing unrelated test environment", () => {
  const environment: NodeJS.ProcessEnv = {
    GIT_DIR: "/caller/.git",
    GIT_WORK_TREE: "/caller",
    GIT_COMMON_DIR: "/caller/.git",
    GIT_INDEX_FILE: "/caller/index",
    GIT_OBJECT_DIRECTORY: "/caller/objects",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.bare",
    GIT_CONFIG_VALUE_0: "true",
    PATH: "/tools",
    HOME: "/home/test",
    XDG_CONFIG_HOME: "/config",
  };

  isolateGitEnvironment(environment);

  expect(environment).toEqual({ PATH: "/tools", HOME: "/home/test", XDG_CONFIG_HOME: "/config" });
});

test("the Bun test preload removes Git hook controls before test modules execute", () => {
  const inheritedGitKeys = Object.keys(process.env).filter((key) => key.startsWith("GIT_"));

  expect(inheritedGitKeys).toEqual([]);
});
