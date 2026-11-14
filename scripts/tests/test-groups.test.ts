import { expect, test } from "bun:test";
import { discoverTests, partitionTests } from "../test-groups";

test("fast and integration partition every discovered test exactly once", async () => {
  const files = await discoverTests(new URL("../../", import.meta.url));

  const { fast, integration, full } = partitionTests(files);
  const partitionedFiles = [...fast, ...integration].sort();
  const uniqueFileCount = new Set(full).size;

  expect(full).toEqual(files);
  expect(full).toContain("apps/web-ui/app/components/worktree-card.test.tsx");
  expect(partitionedFiles).toEqual(full);
  expect(uniqueFileCount).toBe(full.length);
  expect(fast.length).toBeGreaterThan(0);
  expect(integration.length).toBeGreaterThan(0);
});

test("real CLI, Git, environment and lifecycle suites stay outside the fast loop", () => {
  const files = [
    "src/modules/cli/tests/pr.test.ts",
    "src/modules/cli/tests/completion/bash.test.ts",
    "src/modules/script/tests/script-runner.test.ts",
    "src/modules/worktree/tests/worktree.service.test.ts",
    "src/modules/pull-requests/tests/resolve.test.ts",
    "src/modules/config/tests/environment.test.ts",
    "src/external/docker-sbx/tests/docker-sbx-lifecycle.test.ts",
  ];

  const groups = partitionTests(files);
  const sortedFiles = [...files].sort();

  expect(groups).toEqual({ fast: [], integration: sortedFiles, full: sortedFiles });
});

test("in-process output, config and adapter contracts remain fast", () => {
  const files = [
    "src/modules/cli/tests/output.test.ts",
    "src/modules/cli/tests/errors.test.ts",
    "src/modules/cli/tests/parser-contract.test.ts",
    "src/modules/config/tests/layers.test.ts",
    "src/external/github/tests/github-provider.test.ts",
    "src/external/docker-sbx/tests/docker-sbx.test.ts",
  ];

  const groups = partitionTests(files);
  const sortedFiles = [...files].sort();

  expect(groups).toEqual({ fast: sortedFiles, integration: [], full: sortedFiles });
});
