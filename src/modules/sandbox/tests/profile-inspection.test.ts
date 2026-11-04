import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withTemporaryDirectory } from "../../fs/tests/support/temporary-directory";
import { createFileConfigService } from "../../config/config.service";
import { describeProfile, listProfiles } from "../profiles";

test("profile inspection preserves merged values, literal names, and provenance", async () => {
  await withTemporaryDirectory(async (directory) => {
    const global = join(directory, "global.yaml");
    const local = join(directory, "local.yaml");
    await writeFile(
      global,
      'sandbox: { default_provider: docker-sbx, profiles: { "__proto__": { agent: claude, template: global:image } } }\n',
    );
    await mkdir(join(directory, "nested"));
    await writeFile(local, 'sandbox: { profiles: { "__proto__": { pull: never } } }\n');
    const resolved = await createFileConfigService({
      pathsLowToHigh: [global, local],
    }).readWithProvenance();

    expect(listProfiles(resolved).map(({ name }) => name)).toEqual(["__proto__"]);
    expect(describeProfile(resolved, "__proto__")).toMatchObject({
      provider: "docker-sbx",
      profile: { agent: "claude", template: "global:image", pull: "never" },
      sources: [global, local].sort(),
    });
    expect(() => describeProfile(resolved, "constructor")).toThrow(
      expect.objectContaining({ code: "SANDBOX_PROFILE_NOT_FOUND" }),
    );
  });
});
