import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { createProjectRegistry } from "../src/modules/projects/project-registry";

const repository = resolve(import.meta.dirname, "..");
const projectName = "opencode-e2e-fixture";
const nativeSessionID = "eden-e2e-native-session";

async function main() {
  const scratch = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "eden-opencode-e2e-"));
  const home = join(scratch, "home");
  const stateHome = join(scratch, "state");
  const configHome = join(scratch, "config");
  const projectPath = join(scratch, projectName);
  const fake = new FakeOpenCode();
  let vite: ViteInstance | undefined;
  let browser: Browser | undefined;
  const contexts: BrowserContext[] = [];

  try {
    await Promise.all([
      mkdir(home, { recursive: true }),
      mkdir(stateHome, { recursive: true }),
      mkdir(configHome, { recursive: true }),
      mkdir(projectPath, { recursive: true }),
    ]);
    await initializeGitProject(projectPath, configHome);
    await prepareDiffFixture(projectPath);
    const registered = await createProjectRegistry({
      stateHome,
      configHome,
      legacyConfigPath: join(configHome, "eden", "config.yaml"),
      home,
    }).registerNamed(projectName, projectPath);
    await fake.listen();
    const env = isolatedEnvironment({
      home,
      stateHome,
      configHome,
      fakeUrl: fake.url,
    });
    vite = await startVite(env);
    browser = await chromium.launch({ headless: true });

    const firstContext = await browser.newContext({ viewport: { width: 1400, height: 950 } });
    contexts.push(firstContext);
    const firstPage = await firstContext.newPage();
    await openDoingPage(firstPage, vite.url, registered.key, basename(projectPath));
    const diffResponsePromise = firstPage.waitForResponse((response) =>
      response.url().includes("/api/worktree-diff"),
    );
    await firstPage.getByRole("tab", { name: "Diff" }).click();
    const diffResponse = await diffResponsePromise;
    if (!diffResponse.ok())
      throw new Error(
        `Worktree diff returned ${diffResponse.status()}: ${await diffResponse.text()}`,
      );
    await firstPage.getByText(/state = 'working'/).waitFor();
    await firstPage.getByText(/state = 'before'/).waitFor();
    await firstPage.getByText("staged only").waitFor();
    await firstPage.getByText("staged addition").waitFor();
    await firstPage.getByText("untracked addition").waitFor();
    await firstPage.getByText("Binary file; text preview is not available.").waitFor();
    await firstPage.getByText("File exceeds the preview size limit.").waitFor();
    await firstPage.getByTitle("rename-old.txt").waitFor();
    await firstPage.getByTitle("deleted.txt").waitFor();
    await firstPage.getByTitle("outside-link").waitFor();
    await firstPage.getByTitle("odd\nname.txt").waitFor();
    await firstPage.getByText("excludes commit history").waitFor();
    if (process.env.EDEN_WORKTREE_DIFF_E2E_SCREENSHOT)
      await firstPage.screenshot({ path: process.env.EDEN_WORKTREE_DIFF_E2E_SCREENSHOT });
    await firstPage.setViewportSize({ width: 900, height: 900 });
    const documentWidth = await firstPage.evaluate(
      () => [document.documentElement.scrollWidth, window.innerWidth] as const,
    );
    assert.ok(
      documentWidth[0] <= documentWidth[1] + 1,
      "the diff viewer stays within a narrow browser viewport",
    );
    await firstPage.getByRole("tab", { name: "Reviews" }).click();
    const createdResponse = firstPage.waitForResponse(
      (response) =>
        response.url().endsWith("/api/conversations") && response.request().method() === "POST",
    );
    await firstPage.getByRole("button", { name: "New session tab" }).click();
    await firstPage.getByRole("menuitem", { name: "OpenCode conversation" }).click();
    const created = (await (await createdResponse).json()) as { conversation: { id: string } };
    const conversationID = String(created.conversation.id);
    const firstComposer = firstPage.getByRole("textbox", { name: "Message OpenCode" });
    await firstComposer.waitFor({ state: "visible" });

    await firstComposer.fill("**first fake prompt**");
    await firstComposer.press("Enter");
    const firstPrompt = await fake.waitForPromptCount(1);
    let messageListCount = fake.messageLists;
    const firstTurn = fake.startTurn(firstPrompt);
    fake.emitTextStarted(firstTurn);
    const markdownPartial = [
      "# Streamed reply",
      "",
      "This has **bold formatting** and a streamed list:",
      "",
      ...Array.from({ length: 42 }, (_, index) => `- item ${index + 1}`),
      "",
      "```ts",
      "const answer = 42;",
    ].join("\n");
    fake.emitTextDelta(firstTurn, markdownPartial);
    await fake.waitForMessageListCount(++messageListCount);

    await firstPage.getByRole("heading", { name: "Streamed reply" }).waitFor();
    await firstPage.getByText("bold formatting", { exact: true }).waitFor();
    await firstPage.getByRole("listitem").filter({ hasText: "item 42" }).waitFor();
    const firstTranscript = firstPage.getByRole("region", { name: "Conversation transcript" });
    const promptMarkup = firstPage.locator('[data-slot="bubble"] strong');
    assert.equal(await promptMarkup.count(), 0, "user prompts remain plain text");
    assert.equal(
      await firstPage
        .locator('[data-slot="bubble"]')
        .getByText("**first fake prompt**", { exact: true })
        .count(),
      1,
    );
    const partialCode = firstPage.locator("pre code");
    await partialCode.filter({ hasText: "const answer = 42;" }).waitFor();
    assert.ok(
      await firstTranscript.evaluate(
        (element) => element.scrollHeight > element.clientHeight + 100,
      ),
      "long streamed Markdown creates a scrollable transcript",
    );

    const secondContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    contexts.push(secondContext);
    const secondPage = await secondContext.newPage();
    await openDoingPage(secondPage, vite.url, registered.key, basename(projectPath));
    const secondTab = secondPage.getByRole("tab", { name: "OpenCode conversation 1" });
    await secondTab.waitFor({ state: "visible" });
    await secondTab.click();
    await secondPage.getByRole("heading", { name: "Streamed reply" }).waitFor();
    await secondPage.locator("pre code").filter({ hasText: "const answer = 42;" }).waitFor();
    fake.askPermission(firstTurn);
    await firstPage.getByRole("heading", { name: "OpenCode permission requested" }).waitFor();
    await secondPage.getByRole("heading", { name: "OpenCode permission requested" }).waitFor();
    assert.deepEqual(fake.permissionReplies, [], "a pending permission is never auto-approved");
    if (process.env.EDEN_OPENCODE_PERMISSION_E2E_SCREENSHOT)
      await secondPage.screenshot({ path: process.env.EDEN_OPENCODE_PERMISSION_E2E_SCREENSHOT });
    await secondPage.getByRole("button", { name: "Allow once" }).click();
    assert.equal(await fake.waitForPermissionReply(), "once");
    const stalePermission = await firstPage.evaluate(async (id) => {
      const response = await fetch(
        `/api/conversations/${encodeURIComponent(id)}/permissions/fake-permission`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ decision: "reject" }),
        },
      );
      return response.status;
    }, conversationID);
    assert.equal(stalePermission, 409, "a stale browser cannot overwrite the first native reply");
    await firstPage
      .getByRole("heading", { name: "OpenCode permission requested" })
      .waitFor({ state: "hidden" });
    await secondPage
      .getByRole("heading", { name: "OpenCode permission requested" })
      .waitFor({ state: "hidden" });

    await secondPage.getByRole("button", { name: "Close OpenCode conversation 1" }).click();
    await secondTab.waitFor({ state: "hidden" });
    await firstPage
      .getByRole("tab", { name: "OpenCode conversation 1" })
      .waitFor({ state: "hidden" });
    await secondPage.getByRole("button", { name: "New session tab" }).click();
    await secondPage.getByRole("menuitem", { name: "Reopen OpenCode conversation 1" }).click();
    await secondTab.waitFor({ state: "visible" });
    await firstPage
      .getByRole("tab", { name: "OpenCode conversation 1" })
      .waitFor({ state: "visible" });
    await secondPage.getByText("Streamed reply").waitFor();
    assert.equal(
      fake.prompts.length,
      1,
      "closing and reopening does not interrupt or replay a turn",
    );
    assert.equal(fake.sessionCreates, 1, "reopening shared visibility does not wake OpenCode");

    await firstTranscript.evaluate((element) => {
      element.scrollTop = 0;
      element.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    fake.emitTextDelta(firstTurn, "\n```\n\nCompleted fenced code.");
    await firstPage.getByText("Completed fenced code.", { exact: true }).waitFor();
    assert.equal(
      await firstTranscript.evaluate((element) => element.scrollTop),
      0,
      "streaming Markdown does not pull a reader away from earlier content",
    );
    await secondPage.getByText("Completed fenced code.", { exact: true }).waitFor();

    const overlapping = await secondPage.evaluate(async (id) => {
      const response = await fetch(`/api/conversations/${encodeURIComponent(id)}/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "must be rejected" }),
      });
      return response.status;
    }, conversationID);
    assert.equal(overlapping, 409, "a second browser cannot overlap a running turn");
    assert.equal(fake.prompts.length, 1, "a conflicting send never reaches OpenCode");

    const markdownFinal = `${markdownPartial}\n\`\`\`\n\nCompleted fenced code.`;
    fake.completeTurn(firstTurn, markdownFinal);
    await firstPage.getByText("Completed fenced code.", { exact: true }).waitFor();
    await secondPage.getByText("Completed fenced code.", { exact: true }).waitFor();
    await firstPage.locator("pre code").filter({ hasText: "const answer = 42;" }).waitFor();
    assert.equal(fake.sessionCreates, 1);

    for (const context of contexts.splice(0)) await context.close();
    await stopVite(vite);
    vite = await startVite(env);

    const reopenedContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    contexts.push(reopenedContext);
    const reopenedPage = await reopenedContext.newPage();
    await openDoingPage(reopenedPage, vite.url, registered.key, basename(projectPath));
    const reopenedTab = reopenedPage.getByRole("tab", { name: "OpenCode conversation 1" });
    await reopenedTab.waitFor({ state: "visible" });
    await reopenedTab.click();
    await reopenedPage.getByRole("heading", { name: "Streamed reply" }).waitFor();
    assert.equal(fake.prompts.length, 1, "reopening after server restart does not replay a turn");
    assert.equal(fake.sessionCreates, 1, "reopening reuses the durable Eden transcript");

    const composer = reopenedPage.getByRole("textbox", { name: "Message OpenCode" });
    await composer.fill("prompt whose settlement event is lost");
    await composer.press("Enter");
    const eofPrompt = await fake.waitForPromptCount(2);
    messageListCount = fake.messageLists;
    const eofTurn = fake.startTurn(eofPrompt);
    fake.emitTextStarted(eofTurn);
    await fake.waitForMessageListCount(++messageListCount);
    fake.completeTurn(eofTurn, "Native reply recovered after EOF", false);
    await reopenedPage
      .getByText("The last turn did not finish. Your transcript is preserved.", { exact: true })
      .waitFor();
    const incomplete = await reopenedPage.evaluate(async (id) => {
      const response = await fetch(`/api/conversations/${encodeURIComponent(id)}`);
      const body = (await response.json()) as { conversation: { status: string } };
      return body.conversation.status;
    }, conversationID);
    assert.equal(incomplete, "incomplete", "EOF preserves the transcript in an incomplete state");
    assert.equal(fake.prompts.length, 2, "the interrupted prompt was only submitted once");

    await composer.fill("new prompt after reconciliation");
    await composer.press("Enter");
    const followUpPrompt = await fake.waitForPromptCount(3);
    assert.equal(followUpPrompt.sessionID, nativeSessionID);
    assert.equal(
      fake.sessionCreates,
      1,
      "reconciliation does not create a replacement native session",
    );
    assert.equal(
      fake.prompts.filter(({ text }) => text === "prompt whose settlement event is lost").length,
      1,
      "the uncertain prompt is reconciled, never replayed",
    );
    const followUpTurn = fake.startTurn(followUpPrompt);
    fake.emitTextStarted(followUpTurn);
    fake.emitTextDelta(followUpTurn, "Recovered session still streams");
    fake.completeTurn(followUpTurn, "Recovered session still streams to final");
    await reopenedPage
      .getByText("Recovered session still streams to final", { exact: true })
      .waitFor();

    await composer.fill("stop this turn and keep its partial reply");
    await composer.press("Enter");
    const stoppablePrompt = await fake.waitForPromptCount(4);
    const stoppableTurn = fake.startTurn(stoppablePrompt);
    fake.emitTextStarted(stoppableTurn);
    fake.emitTextDelta(stoppableTurn, "Partial text before Stop.");
    await reopenedPage.getByText("Partial text before Stop.", { exact: true }).waitFor();

    const stopContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    contexts.push(stopContext);
    const stopPage = await stopContext.newPage();
    await openDoingPage(stopPage, vite.url, registered.key, basename(projectPath));
    await stopPage.getByRole("tab", { name: "OpenCode conversation 1" }).click();
    const stopButton = stopPage.getByRole("button", { name: "Stop" });
    await stopButton.waitFor({ state: "visible" });
    const stopResponsePromise = stopPage.waitForResponse((response) =>
      response.url().endsWith(`/api/conversations/${conversationID}/stop`),
    );
    await stopButton.click();
    const stopResponse = await stopResponsePromise;
    assert.equal(stopResponse.status(), 202, await stopResponse.text());
    await stopPage.getByText("Partial text before Stop.", { exact: true }).waitFor();
    await reopenedPage.waitForFunction(async (id) => {
      const response = await fetch(`/api/conversations/${encodeURIComponent(id)}`);
      const body = (await response.json()) as { conversation: { status: string } };
      return body.conversation.status === "ready";
    }, conversationID);
    await reopenedPage.getByText("Partial text before Stop.", { exact: true }).waitFor();
    assert.equal(stoppablePrompt.sessionID, nativeSessionID);
    assert.equal(fake.interruptions, 1, "Stop uses OpenCode's native interrupt API");
    assert.equal(fake.prompts.length, 4, "Stop never replays the active prompt");

    await composer.fill("continue after stopping");
    await composer.press("Enter");
    const postStopPrompt = await fake.waitForPromptCount(5);
    assert.equal(
      postStopPrompt.sessionID,
      nativeSessionID,
      "Send continues the same native session",
    );
    const postStopTurn = fake.startTurn(postStopPrompt);
    fake.emitTextStarted(postStopTurn);
    fake.completeTurn(postStopTurn, "Continued after Stop.");
    await reopenedPage.getByText("Continued after Stop.", { exact: true }).waitFor();
    assert.deepEqual(fake.errors, []);

    if (process.env.EDEN_CONVERSATION_E2E_SCREENSHOT)
      await reopenedPage.screenshot({ path: process.env.EDEN_CONVERSATION_E2E_SCREENSHOT });

    console.log(
      JSON.stringify({
        result: "passed",
        project: registered.key,
        nativeSessionID,
        prompts: fake.prompts.map(({ text, sessionID }) => ({ text, sessionID })),
        restarts: 1,
        conflictStatus: overlapping,
        incompleteStatusAfterEOF: incomplete,
        sentPromptCount: fake.prompts.length,
      }),
    );
  } finally {
    for (const context of contexts.splice(0)) await context.close().catch(() => {});
    await browser?.close().catch(() => {});
    if (vite) await stopVite(vite);
    await fake.close();
    await rm(scratch, { recursive: true, force: true });
  }
}

type ViteInstance = { child: ChildProcess; url: string; output: () => string };

async function initializeGitProject(path: string, configHome: string) {
  const git = Bun.which("git");
  if (!git) throw new Error("Git is required for the isolated E2E project.");
  const env = {
    ...process.env,
    HOME: join(configHome, "home"),
    GIT_CONFIG_GLOBAL: join(configHome, "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
  };
  await Promise.all([
    writeFile(join(path, "README.md"), "# OpenCode E2E fixture\n"),
    writeFile(join(path, "modified.ts"), "export const state = 'before';\n"),
    writeFile(join(path, "staged.txt"), "before\n"),
    writeFile(join(path, "deleted.txt"), "before\n"),
    writeFile(join(path, "rename-old.txt"), "rename me\n"),
  ]);
  await run(git, ["-C", path, "init", "--initial-branch=e2e"], env);
  await run(git, ["-C", path, "config", "user.name", "Eden E2E"], env);
  await run(git, ["-C", path, "config", "user.email", "e2e@example.invalid"], env);
  await run(git, ["-C", path, "add", "."], env);
  await run(git, ["-C", path, "commit", "--quiet", "-m", "fixture"], env);
}

async function prepareDiffFixture(path: string) {
  const git = Bun.which("git");
  if (!git) throw new Error("Git is required for the isolated E2E project.");
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: join(path, "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
  };
  await writeFile(join(path, "modified.ts"), "export const state = 'staged';\n");
  await run(git, ["-C", path, "add", "modified.ts"], env);
  await writeFile(join(path, "modified.ts"), "export const state = 'working';\n");
  await writeFile(join(path, "staged.txt"), "staged only\n");
  await run(git, ["-C", path, "add", "staged.txt"], env);
  await writeFile(join(path, "new-staged.txt"), "staged addition\n");
  await run(git, ["-C", path, "add", "new-staged.txt"], env);
  await run(git, ["-C", path, "rm", "--quiet", "deleted.txt"], env);
  await run(git, ["-C", path, "mv", "rename-old.txt", "renamed.txt"], env);
  await Promise.all([
    writeFile(join(path, "untracked.txt"), "untracked addition\n"),
    writeFile(join(path, "odd\nname.txt"), "unusual filename\n"),
    writeFile(join(path, "binary.dat"), new Uint8Array([0, 1, 2, 255])),
    writeFile(join(path, "large.txt"), "x".repeat(256 * 1024 + 1)),
  ]);
  await symlink("/etc/passwd", join(path, "outside-link"));
}

function isolatedEnvironment({
  home,
  stateHome,
  configHome,
  fakeUrl,
}: {
  home: string;
  stateHome: string;
  configHome: string;
  fakeUrl: string;
}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(OPENCODE_|OPENAI_|ANTHROPIC_|AZURE_|GEMINI_|GOOGLE_API_KEY|AWS_)/.test(key))
      delete env[key];
  }
  return {
    ...env,
    HOME: home,
    XDG_STATE_HOME: stateHome,
    XDG_CONFIG_HOME: configHome,
    GIT_CONFIG_GLOBAL: join(configHome, "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    EDEN_CONVERSATION_E2E: "1",
    EDEN_OPENCODE_E2E_FAKE_URL: fakeUrl,
    EDEN_WEB_HOST: "127.0.0.1",
    EDEN_TERMINAL_BACKEND: "bun",
  };
}

async function startVite(env: NodeJS.ProcessEnv): Promise<ViteInstance> {
  const executable = Bun.which("bun");
  if (!executable) throw new Error("Bun is required to run the Vite E2E server.");
  const port = await randomLoopbackPort();
  const child = spawn(
    executable,
    ["--bun", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
    {
      cwd: join(repository, "apps", "web-ui"),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  let settled = false;
  let resolveReady!: (url: string) => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<string>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const collect = (chunk: Buffer) => {
    output += chunk.toString();
    const match = output.match(/Local:\s+http:\/\/127\.0\.0\.1:(\d+)\//);
    if (match && !settled) {
      settled = true;
      resolveReady(`http://127.0.0.1:${match[1]}`);
    }
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  child.once("error", (error) => rejectReady(error));
  child.once("exit", (code) => {
    if (!settled) rejectReady(new Error(`Vite exited before ready (${code}).\n${output}`));
  });
  const watchdog = setTimeout(() => {
    if (settled) return;
    settled = true;
    rejectReady(new Error(`Vite did not become ready.\n${output}`));
  }, 30_000);
  try {
    const url = await ready;
    return { child, url, output: () => output };
  } catch (error) {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }
    throw error;
  } finally {
    clearTimeout(watchdog);
  }
}

async function randomLoopbackPort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve a Vite port.");
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

async function stopVite(instance: ViteInstance) {
  if (instance.child.exitCode !== null || instance.child.signalCode !== null) return;
  const exited = once(instance.child, "exit");
  instance.child.kill("SIGTERM");
  const watchdog = setTimeout(() => instance.child.kill("SIGKILL"), 5000);
  try {
    await exited;
  } finally {
    clearTimeout(watchdog);
  }
}

async function openDoingPage(
  page: Page,
  baseUrl: string,
  projectKey: string,
  worktreeName: string,
) {
  await page.goto(`${baseUrl}/p/${encodeURIComponent(projectKey)}/doing`);
  const worktree = page.getByRole("button", {
    name: `Open ${worktreeName} on e2e in Doing`,
  });
  await worktree.waitFor({ state: "visible" });
  await worktree.click();
  await page.getByRole("button", { name: "New session tab" }).waitFor({ state: "visible" });
}

async function run(executable: string, args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(executable, args, { env, stdio: ["ignore", "pipe", "pipe"] });
  const [code, stdout, stderr] = await Promise.all([
    once(child, "exit").then(([value]) => value as number),
    readStream(child.stdout),
    readStream(child.stderr),
  ]);
  if (code !== 0)
    throw new Error(`Command failed: ${executable} ${args.join(" ")}\n${stderr}\n${stdout}`);
}

async function readStream(stream: NodeJS.ReadableStream | null) {
  if (!stream) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString();
}

type FakePrompt = { sessionID: string; id: string; text: string };
type FakeTurn = { prompt: FakePrompt; assistantID: string };

class FakeOpenCode {
  private readonly server = createServer((request, response) => {
    void this.handle(request, response).catch((error: unknown) => {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.errors.push(failure.message);
      for (const waiter of this.promptWaiters.splice(0)) waiter.reject(failure);
      for (const waiter of this.messageListWaiters.splice(0)) waiter.reject(failure);
      if (!response.headersSent)
        json(response, 500, { errors: [{ message: "Fake service failed." }] });
      else response.destroy();
    });
  });
  private readonly eventStreams = new Set<ServerResponse>();
  private readonly promptWaiters: {
    count: number;
    resolve: (prompt: FakePrompt) => void;
    reject: (error: Error) => void;
  }[] = [];
  private readonly messageListWaiters: {
    count: number;
    resolve: () => void;
    reject: (error: Error) => void;
  }[] = [];
  private readonly sessionMessages: Record<string, unknown>[] = [];
  private readonly permissions: Record<string, unknown>[] = [];
  private readonly permissionReplyWaiters: ((decision: string) => void)[] = [];
  private active = false;
  private messageListCount = 0;
  readonly prompts: FakePrompt[] = [];
  readonly errors: string[] = [];
  sessionCreates = 0;
  interruptions = 0;
  permissionReplies: string[] = [];
  url = "";

  get messageLists() {
    return this.messageListCount;
  }

  async listen() {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", resolve);
    });
    const address = this.server.address();
    assert(address && typeof address !== "string");
    this.url = `http://127.0.0.1:${address.port}`;
  }

  async waitForPromptCount(count: number) {
    const existing = this.prompts[count - 1];
    if (existing) return existing;
    return new Promise<FakePrompt>((resolve, reject) => {
      const timeout = setTimeout(
        () =>
          reject(
            new Error(
              `Timed out waiting for fake prompt ${count}.${this.errors.length ? ` ${this.errors.join("; ")}` : ""}`,
            ),
          ),
        15_000,
      );
      this.promptWaiters.push({
        count,
        resolve: (prompt) => {
          clearTimeout(timeout);
          resolve(prompt);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
    });
  }

  async waitForMessageListCount(count: number) {
    if (this.messageListCount >= count) return;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`Timed out waiting for fake message list ${count}.`)),
        15_000,
      );
      this.messageListWaiters.push({
        count,
        resolve: () => {
          clearTimeout(timeout);
          resolve();
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
    });
  }

  startTurn(prompt: FakePrompt): FakeTurn {
    assert.equal(prompt.sessionID, nativeSessionID);
    this.active = true;
    const assistantID = `assistant-${this.prompts.indexOf(prompt) + 1}`;
    this.sessionMessages.push({
      id: assistantID,
      sessionID: nativeSessionID,
      type: "assistant",
      time: { created: Date.now() },
      agent: "build",
      model: { providerID: "fake", modelID: "fixture" },
      content: [{ type: "text", text: "" }],
    });
    return { prompt, assistantID };
  }

  emitTextStarted(turn: FakeTurn) {
    this.emit({
      type: "session.text.started",
      id: randomID(),
      created: Date.now(),
      data: { sessionID: nativeSessionID, assistantMessageID: turn.assistantID, ordinal: 0 },
    });
  }

  emitTextDelta(turn: FakeTurn, delta: string) {
    this.updateAssistant(turn, delta);
    this.emit({
      type: "session.text.delta",
      id: randomID(),
      created: Date.now(),
      data: { sessionID: nativeSessionID, assistantMessageID: turn.assistantID, ordinal: 0, delta },
    });
  }

  askPermission(turn: FakeTurn) {
    const permission = {
      id: "fake-permission",
      sessionID: nativeSessionID,
      action: "read",
      resources: ["src/index.ts"],
      message: "Read the source file?",
    };
    this.permissions.push(permission);
    this.emit({
      type: "permission.asked",
      id: randomID(),
      created: Date.now(),
      data: permission,
    });
    assert.equal(turn.prompt.sessionID, nativeSessionID);
  }

  async waitForPermissionReply() {
    if (this.permissionReplies.length) return this.permissionReplies.at(-1)!;
    return new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Timed out waiting for fake permission reply.")),
        15_000,
      );
      this.permissionReplyWaiters.push((decision) => {
        clearTimeout(timeout);
        resolve(decision);
      });
    });
  }

  completeTurn(turn: FakeTurn, reply: string, emitSettled = true) {
    this.updateAssistant(turn, reply, true);
    this.active = false;
    if (emitSettled) {
      this.emit({
        type: "session.execution.succeeded",
        id: randomID(),
        created: Date.now(),
        data: { sessionID: nativeSessionID },
      });
    } else {
      for (const response of this.eventStreams) response.end();
      this.eventStreams.clear();
    }
  }

  async close() {
    for (const response of this.eventStreams) response.end();
    this.eventStreams.clear();
    if (!this.server.listening) return;
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private async handle(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;
    if (path === "/api/info" && request.method === "GET")
      return json(response, 200, {
        version: "2.4.1",
        pid: process.pid,
        urls: [this.url],
        paths: { tmp: "/tmp" },
      });
    if (path === "/api/event" && request.method === "GET") {
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      this.eventStreams.add(response);
      response.on("close", () => this.eventStreams.delete(response));
      response.write(
        `data: ${JSON.stringify({ type: "server.connected", id: randomID(), data: {} })}\n\n`,
      );
      return;
    }
    if (path === "/api/session" && request.method === "POST") {
      await readJson(request);
      this.sessionCreates += 1;
      return json(response, 200, { data: { id: nativeSessionID } });
    }
    if (path === "/api/session/active" && request.method === "GET")
      return json(response, 200, { data: this.active ? { [nativeSessionID]: {} } : {} });

    const promptMatch = path.match(/^\/api\/session\/([^/]+)\/prompt$/);
    if (promptMatch && request.method === "POST") {
      const sessionID = decodeURIComponent(promptMatch[1]!);
      const body = await readJson(request);
      if (sessionID !== nativeSessionID)
        return json(response, 409, { errors: [{ message: "Unexpected native session." }] });
      const prompt: FakePrompt = {
        sessionID,
        id: String(body.id ?? `user-${this.prompts.length + 1}`),
        text: String(body.text ?? ""),
      };
      assert.match(prompt.id, /^msg_[0-9a-f]{32}$/);
      this.prompts.push(prompt);
      this.sessionMessages.push({
        id: prompt.id,
        sessionID,
        type: "user",
        time: { created: Date.now() },
        payload: { text: prompt.text },
        delivery: { status: "delivered" },
      });
      for (const waiter of this.promptWaiters.splice(0)) {
        const item = this.prompts[waiter.count - 1];
        if (item) waiter.resolve(item);
        else this.promptWaiters.push(waiter);
      }
      return json(response, 200, {
        data: {
          id: prompt.id,
          sessionID,
          type: "user",
          time: { created: Date.now() },
          payload: { text: prompt.text },
          delivery: { status: "delivered" },
        },
      });
    }

    const interruptMatch = path.match(/^\/api\/session\/([^/]+)\/interrupt$/);
    if (interruptMatch && request.method === "POST") {
      assert.equal(decodeURIComponent(interruptMatch[1]!), nativeSessionID);
      this.interruptions += 1;
      if (!this.active) return json(response, 200, { interrupted: false });
      this.active = false;
      const assistant = [...this.sessionMessages]
        .reverse()
        .find((message) => message.type === "assistant");
      if (assistant) {
        assistant.finish = "interrupted";
        assistant.time = { created: Date.now(), completed: Date.now() };
      }
      this.emit({
        type: "session.execution.interrupted",
        id: randomID(),
        created: Date.now(),
        data: { sessionID: nativeSessionID },
      });
      return json(response, 200, { interrupted: true });
    }

    const permissionReplyMatch = path.match(
      /^\/api\/session\/([^/]+)\/permission\/([^/]+)\/reply$/,
    );
    if (permissionReplyMatch && request.method === "POST") {
      assert.equal(decodeURIComponent(permissionReplyMatch[1]!), nativeSessionID);
      const body = await readJson(request);
      const index = this.permissions.findIndex(
        ({ id }) => id === decodeURIComponent(permissionReplyMatch[2]!),
      );
      if (index < 0) return json(response, 409, { errors: [{ message: "Permission is stale." }] });
      assert.ok(
        body.decision === "once" || body.decision === "always" || body.decision === "reject",
      );
      this.permissions.splice(index, 1);
      this.permissionReplies.push(body.decision);
      for (const waiter of this.permissionReplyWaiters.splice(0)) waiter(body.decision);
      response.writeHead(204);
      return response.end();
    }

    const permissionListMatch = path.match(/^\/api\/session\/([^/]+)\/permission$/);
    if (permissionListMatch && request.method === "GET") {
      assert.equal(decodeURIComponent(permissionListMatch[1]!), nativeSessionID);
      return json(response, 200, { data: this.permissions });
    }

    const messageMatch = path.match(/^\/api\/session\/([^/]+)\/message$/);
    if (messageMatch && request.method === "GET") {
      const cursor = url.searchParams.get("cursor");
      assert.equal(url.searchParams.has("order"), !cursor);
      this.messageListCount += 1;
      for (const waiter of this.messageListWaiters.splice(0)) {
        if (this.messageListCount >= waiter.count) waiter.resolve();
        else this.messageListWaiters.push(waiter);
      }
      return json(response, 200, {
        data: cursor ? [] : this.sessionMessages,
        cursor: cursor ? {} : { next: "fake-next-page" },
      });
    }

    const sessionMatch = path.match(/^\/api\/session\/([^/]+)$/);
    if (sessionMatch && request.method === "GET")
      return json(response, 200, { data: { id: decodeURIComponent(sessionMatch[1]!) } });

    return json(response, 404, { errors: [{ message: "Fake OpenCode route not found." }] });
  }

  private updateAssistant(turn: FakeTurn, text: string, finished = false) {
    const message = this.sessionMessages.find((entry) => entry.id === turn.assistantID)!;
    message.content = [{ type: "text", text }];
    if (finished) {
      message.finish = "stop";
      message.time = { created: Date.now(), completed: Date.now() };
    }
  }

  private emit(event: object) {
    for (const response of this.eventStreams) response.write(`data: ${JSON.stringify(event)}\n\n`);
  }
}

function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function randomID() {
  return crypto.randomUUID();
}

await main();
