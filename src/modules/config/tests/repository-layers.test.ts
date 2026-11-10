import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { withTemporaryDirectory } from "../../fs/tests/support/temporary-directory";
import { createFileConfigService } from "../config.service";
import { findRepositoryPath } from "../repository";

const layers = ["global", "repository", "local"] as const;

test.each([
  [
    "null to mapping",
    null,
    { eden: { name: "Eden", path: "/work/eden" } },
    { eden: { name: "Eden", path: "/work/eden" } },
  ],
  ["mapping to null", { eden: { name: "Eden", path: "/work/eden" } }, null, null],
] as const)(
  "merges project registry layers from %s",
  async (_direction, globalProjects, repositoryProjects, expectedProjects) => {
    await withTemporaryDirectory(async (directory) => {
      const global = join(directory, "config.yaml");
      const repository = join(directory, "repo", ".eden", "config.yaml");
      await mkdir(dirname(repository), { recursive: true });
      await writeFile(global, Bun.YAML.stringify({ projects: globalProjects }));
      await writeFile(repository, Bun.YAML.stringify({ projects: repositoryProjects }));
      const result = await createFileConfigService({
        pathsLowToHigh: [global, repository],
      }).readWithProvenance();
      const projectProvenance = Object.fromEntries(
        Object.entries(result.provenance).filter(
          ([key]) => key === "projects" || key.startsWith("projects."),
        ),
      );

      expect(result.config.projects).toEqual(expectedProjects);
      if (expectedProjects === null) {
        expect(projectProvenance).toEqual({ projects: { type: "file", path: repository } });
      } else {
        expect(projectProvenance).toEqual({
          "projects.eden.name": { type: "file", path: repository },
          "projects.eden.path": { type: "file", path: repository },
        });
      }
    });
  },
);

for (const nested of [false, true]) {
  test.each([...layers])(
    `resolves %s configuration leaves with nested=${nested}`,
    async (winningLayer) => {
      await withTemporaryDirectory(async (directory) => {
        const repository = join(directory, "repo");
        const cwd = nested ? join(repository, "src", "nested") : repository;
        const paths = {
          global: join(directory, "config.yaml"),
          repository: join(repository, ".eden", "config.yaml"),
          local: join(repository, ".eden", "config.local.yaml"),
        };
        const agents = { global: "claude", repository: "codex", local: "opencode" };
        const root = join(directory, `${winningLayer}-trees`);
        await mkdir(cwd, { recursive: true });
        await mkdir(join(repository, ".git"));
        for (const layer of layers) {
          await mkdir(dirname(paths[layer]), { recursive: true });
          await writeFile(
            paths[layer],
            Bun.YAML.stringify({
              ...(layer === winningLayer ? { sandbox: { default_provider: "docker-sbx" } } : {}),
              ...(layers.indexOf(layer) <= layers.indexOf(winningLayer)
                ? {
                    agent: { default: agents[layer] },
                    worktree_root: join(directory, `${layer}-trees`),
                  }
                : {}),
            }),
          );
        }
        const service = createFileConfigService({
          pathsLowToHigh: [paths.global, paths.repository, paths.local],
        });

        const repositoryPath = await findRepositoryPath(cwd);
        const { config, provenance } = await service.readWithProvenance();

        expect(repositoryPath).toBe(repository);
        expect(config).toMatchObject({
          agent: { default: agents[winningLayer] },
          worktree_root: root,
          sandbox: { default_provider: "docker-sbx" },
        });
        for (const key of ["agent.default", "worktree_root", "sandbox.default_provider"]) {
          expect(provenance[key]).toEqual({ type: "file", path: paths[winningLayer] });
        }
        expect(await Bun.file(root).exists()).toBe(false);
      });
    },
  );
}
