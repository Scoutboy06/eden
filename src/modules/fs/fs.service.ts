import { mkdir } from "node:fs/promises";
import type { Execution } from "../execution";

export class FilesystemService {
  constructor(private readonly execution: Execution) {}

  async mkdir(path: string): Promise<void> {
    await this.execution.mutate(
      {
        type: "fs.mkdir",
        description: `Create directory ${path}`,
        input: { path },
      },
      async () => {
        await mkdir(path, { recursive: true });
      },
    );
  }
}
