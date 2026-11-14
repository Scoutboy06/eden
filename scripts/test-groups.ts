import { readdir } from "node:fs/promises";

export function partitionTests(files: string[]) {
  const full = [...files].sort();
  const integration = full.filter(isIntegration);
  const fast = full.filter((file) => !isIntegration(file));

  return { fast, integration, full };
}

export async function discoverTests(root: URL): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(root, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    if (entry.isDirectory()) {
      const children = await discoverTests(new URL(`${entry.name}/`, root));
      const childPaths = children.map((child) => `${entry.name}/${child}`);
      files.push(...childPaths);
    } else if (
      entry.isFile() &&
      (entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.tsx"))
    ) {
      files.push(entry.name);
    }
  }

  return files.sort();
}

function isIntegration(file: string): boolean {
  if (
    file === "src/modules/cli/tests/output.test.ts" ||
    file === "src/modules/cli/tests/errors.test.ts" ||
    file === "src/modules/cli/tests/parser-contract.test.ts"
  )
    return false;

  return (
    file.startsWith("src/modules/cli/tests/") ||
    file.startsWith("src/modules/script/tests/") ||
    file.startsWith("src/modules/worktree/tests/") ||
    file.startsWith("src/modules/git/tests/") ||
    file === "apps/web-ui/server/tasks.test.ts" ||
    file === "apps/web-ui/server/task-detail.test.ts" ||
    file === "apps/web-ui/server/import-project.test.ts" ||
    file === "src/external/beads/tests/process.test.ts" ||
    file === "src/modules/pull-requests/tests/resolve.test.ts" ||
    file === "src/modules/config/tests/environment.test.ts" ||
    file === "src/external/docker-sbx/tests/docker-sbx-lifecycle.test.ts"
  );
}
