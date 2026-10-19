import { stat } from "node:fs/promises";
import * as v from "valibot";
import type {
  ConfigChanges,
  ConfigDraft,
  ConfigSaveResult,
  ConfigService,
} from "../config/config.service";
import { ConfigSchema } from "../config/schema";
import type { SandboxProviderName } from "../sandbox/provider";

export type SetupPreferences = { provider: SandboxProviderName | undefined; worktreeRoot: string };
export type SetupReviewAction = "provider" | "worktreeRoot" | "save" | "cancel";
export type SetupResult = { status: ConfigSaveResult; path: string; changes: ConfigChanges };

export interface SetupPrompts {
  intro(path: string): void;
  provider(
    current: SandboxProviderName | undefined,
    saved: SandboxProviderName | undefined,
  ): Promise<SandboxProviderName | undefined>;
  worktreeRoot(current: string, saved: string | undefined): Promise<string>;
  review(preferences: SetupPreferences, selected: SetupReviewAction): Promise<SetupReviewAction>;
  confirmOverwrite(path: string): Promise<boolean>;
}

export class SetupCancelled extends Error {}

export class SetupService {
  constructor(private readonly config: ConfigService) {}

  async run(prompts: SetupPrompts): Promise<SetupResult> {
    const draft = await this.config.editGlobal();
    const savedProvider = draft.config.sandbox?.default_provider;
    const savedRoot = draft.get("worktree_root");

    prompts.intro(draft.path);

    try {
      const preferences: SetupPreferences = {
        provider: await prompts.provider(savedProvider, savedProvider),
        worktreeRoot: await prompts.worktreeRoot(savedRoot ?? "~/.worktrees", savedRoot),
      };
      let selected: SetupReviewAction = "save";

      while (true) {
        selected = await prompts.review(preferences, selected);

        if (selected === "provider") {
          preferences.provider = await prompts.provider(preferences.provider, savedProvider);
        } else if (selected === "worktreeRoot") {
          preferences.worktreeRoot = await prompts.worktreeRoot(
            preferences.worktreeRoot,
            savedRoot,
          );
        } else if (selected === "cancel") {
          throw new SetupCancelled();
        } else {
          return await savePreferences(draft, preferences, () =>
            prompts.confirmOverwrite(draft.path),
          );
        }
      }
    } catch (error) {
      if (!(error instanceof SetupCancelled)) throw error;

      return { status: "cancelled", path: draft.path, changes: {} };
    }
  }
}

async function savePreferences(
  draft: ConfigDraft,
  preferences: SetupPreferences,
  confirmOverwrite: () => Promise<boolean>,
): Promise<SetupResult> {
  const changes: Record<string, string | undefined> = {};

  if (preferences.provider !== draft.config.sandbox?.default_provider)
    changes["sandbox.default_provider"] = preferences.provider;
  if (preferences.worktreeRoot !== draft.get("worktree_root"))
    changes.worktree_root = preferences.worktreeRoot;

  const pathError = await validateWorktreeRoot(preferences.worktreeRoot);
  if (pathError) throw new Error(pathError);

  const status = await draft.save(changes, confirmOverwrite);

  return { status, path: draft.path, changes };
}

export async function validateWorktreeRoot(value: string): Promise<string | undefined> {
  const result = v.safeParse(ConfigSchema, { worktree_root: value });

  if (!result.success) return result.issues[0]?.message ?? "Invalid worktree root";

  try {
    const info = await stat(result.output.worktree_root);

    if (!info.isDirectory()) return "The worktree root must be a directory, not a file.";
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      return "Could not inspect the worktree root. Check its permissions.";
    }
  }
}
