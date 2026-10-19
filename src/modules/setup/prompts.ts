import * as clack from "@clack/prompts";
import { SelectPrompt } from "@clack/core";
import { styleText } from "node:util";
import { createPromptOutput } from "../cli/prompt-output";
import { sandboxProviderLabels, type SandboxProviderName } from "../sandbox/provider";
import type { ReadinessCheck } from "../sandbox/readiness";
import { ReadinessMonitor } from "./readiness";
import { formatReadiness } from "./presentation";
import {
  SetupCancelled,
  validateWorktreeRoot,
  type SetupPreferences,
  type SetupPrompts,
  type SetupResult,
  type SetupReviewAction,
} from "./setup.service";

export class ClackSetupPrompts implements SetupPrompts {
  private readonly monitors: Map<SandboxProviderName, ReadinessMonitor>;

  constructor(
    private readonly providers: readonly {
      name: SandboxProviderName;
      checks: readonly ReadinessCheck[];
    }[],
    private readonly dryRun: boolean,
  ) {
    this.monitors = new Map(
      providers.map((provider) => [provider.name, new ReadinessMonitor(provider.checks)]),
    );
  }

  intro(path: string): void {
    clack.intro(this.dryRun ? "Eden setup · Dry run" : "Eden setup");
    clack.log.info(`Global preferences · ${path}`);
  }

  async provider(
    current: SandboxProviderName | undefined,
    saved: SandboxProviderName | undefined,
  ): Promise<SandboxProviderName | undefined> {
    const display = createPromptOutput();
    const providers = this.providers;
    const monitors = this.monitors;
    const options = [
      ...providers.map(({ name }) => ({
        value: name as string,
        label: sandboxProviderLabels[name],
      })),
      { value: "none", label: "Choose a provider each time" },
    ];
    let frame = 0;
    const spinner = setInterval(() => {
      if (
        [...monitors.values()].some((monitor) =>
          monitor.snapshot().some((state) => state.checking && state.result.state !== "ready"),
        )
      ) {
        frame++;
        display.refresh();
      }
    }, 120);

    for (const monitor of monitors.values()) monitor.start(display.refresh);

    try {
      const value = unwrap(
        await new SelectPrompt({
          output: display.output,
          options,
          initialValue: current ?? "none",
          render() {
            const bar = styleText("gray", clack.S_BAR);
            const title = `${clack.symbol(this.state)}  Default sandbox provider`;

            if (this.state === "submit" || this.state === "cancel") {
              return `${bar}\n${title}\n${bar}  ${this.options[this.cursor]?.label ?? "Cancelled"}`;
            }

            const rows = this.options.map((option, index) => {
              const active = index === this.cursor;
              const marker = active
                ? styleText("green", clack.S_RADIO_ACTIVE)
                : styleText("gray", clack.S_RADIO_INACTIVE);
              const label = active ? option.label : styleText("dim", option.label);
              const previous =
                saved !== undefined && option.value === saved
                  ? styleText("gray", " · previously saved")
                  : "";
              const lines = [`${bar}  ${marker} ${label}${previous}`];
              const provider = providers.find(({ name }) => name === option.value);

              if (provider) {
                const states = monitors.get(provider.name)!.snapshot();
                lines.push(
                  `${bar}    ${states.map((state) => formatReadiness(state, provider.checks, frame)).join(" · ")}`,
                );

                if (active) {
                  const instructions = [
                    ...new Set(states.flatMap((state) => state.result.instructions ?? [])),
                  ];

                  if (instructions.length > 0) {
                    lines.push(
                      bar,
                      ...instructions.map(
                        (line) =>
                          `${bar}    ${line.startsWith("  ") ? styleText("cyan", line) : line}`,
                      ),
                    );
                  }
                }
              }

              return lines.join("\n");
            });

            return [
              bar,
              title,
              ...rows,
              bar,
              `${styleText("gray", "└")}  ${styleText("dim", "↑/↓ to move · Enter to confirm")}`,
            ].join("\n");
          },
        }).prompt(),
      );

      return value === "none" ? undefined : (value as SandboxProviderName);
    } finally {
      for (const monitor of monitors.values()) monitor.stop();

      clearInterval(spinner);
      display.close();
    }
  }

  async worktreeRoot(current: string, saved: string | undefined): Promise<string> {
    const origin =
      current === saved
        ? " · previously saved"
        : saved === undefined && current === "~/.worktrees"
          ? " · Eden default"
          : "";

    return unwrap(
      await clack.text({
        message: `Choose a default worktree root${origin}`,
        initialValue: current,
        validate: (value) => validateWorktreeRoot(value ?? ""),
      }),
    );
  }

  async review(
    preferences: SetupPreferences,
    selected: SetupReviewAction,
  ): Promise<SetupReviewAction> {
    return unwrap(
      await clack.select<SetupReviewAction>({
        message: "Review your preferences · Select a setting to edit",
        initialValue: selected,
        options: [
          {
            value: "provider",
            label: `Sandbox provider   ${preferences.provider ? sandboxProviderLabels[preferences.provider] : "Choose a provider each time"}`,
          },
          { value: "worktreeRoot", label: `Worktree root      ${preferences.worktreeRoot}` },
          { value: "save", label: this.dryRun ? "Preview changes" : "Save preferences" },
          { value: "cancel", label: "Cancel" },
        ],
      }),
    );
  }

  async confirmOverwrite(path: string): Promise<boolean> {
    clack.log.warn(`The configuration file changed while setup was open:\n${path}`);

    return unwrap(
      await clack.select({
        message: "Overwrite with your setup choices?",
        initialValue: false,
        options: [
          { value: false, label: "Cancel setup" },
          { value: true, label: "Overwrite" },
        ],
      }),
    );
  }

  finish(result: SetupResult): void {
    if (result.status === "previewed") {
      clack.note(
        Object.entries(result.changes)
          .map(([key, value]) => `${key}: ${value ?? "remove setting"}`)
          .join("\n"),
        "Proposed changes",
      );
    }

    const messages = {
      saved: "Global preferences saved.",
      previewed: "Preview complete. No preferences were saved.",
      unchanged: "Preferences unchanged.",
      cancelled: "Cancelled. Nothing was changed.",
    };
    clack.outro(messages[result.status]);
  }
}

function unwrap<T>(value: T | typeof clack.CANCEL_SYMBOL): Exclude<T, typeof clack.CANCEL_SYMBOL> {
  if (clack.isCancel(value) || value === undefined) throw new SetupCancelled();

  return value as Exclude<T, typeof clack.CANCEL_SYMBOL>;
}
