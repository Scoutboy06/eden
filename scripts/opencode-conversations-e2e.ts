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
    await firstPage.addInitScript(() => {
      const sockets: WebSocket[] = [];
      Object.defineProperty(window, "__edenConversationSockets", { value: sockets });
      const NativeWebSocket = window.WebSocket;
      window.WebSocket = new Proxy(NativeWebSocket, {
        construct(target, args) {
          const socket = Reflect.construct(target, args) as WebSocket;
          sockets.push(socket);
          return socket;
        },
      });
    });
    const conversationCollectionGets: string[] = [];
    const modelDiscoveryGets: string[] = [];
    firstPage.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname === "/api/conversations" && request.method() === "GET")
        conversationCollectionGets.push(request.url());
      if (url.pathname.endsWith("/models") && request.method() === "GET")
        modelDiscoveryGets.push(request.url());
    });
    await openDoingPage(firstPage, vite.url, registered.key, basename(projectPath));
    await verifyNavigationVariants(firstPage);
    if (process.env.EDEN_NAVIGATION_E2E_ONLY === "1") {
      console.log(JSON.stringify({ result: "passed", fixture: "navigation variants" }));
      return;
    }
    await firstPage.waitForFunction(() =>
      (
        window as Window & { __edenConversationSockets?: WebSocket[] }
      ).__edenConversationSockets?.some((socket) => socket.readyState === WebSocket.OPEN),
    );
    await firstPage.waitForTimeout(2600);
    assert.deepEqual(conversationCollectionGets, [], "idle Doing views do not poll conversations");
    if (process.env.EDEN_CONVERSATION_E2E_SKIP_DIFF !== "1") {
      await firstPage.setViewportSize({ width: 390, height: 844 });
      await firstPage.getByRole("button", { name: "Hide worktrees sidebar" }).click();
      const diffProfiler = await firstContext.newCDPSession(firstPage);
      await diffProfiler.send("Emulation.setCPUThrottlingRate", { rate: 4 });
      await diffProfiler.send("Profiler.enable");
      await diffProfiler.send("Profiler.start");
      const fileReads: string[] = [];
      firstPage.on("request", (request) => {
        const url = new URL(request.url());
        if (url.pathname === "/api/worktree-diff" && url.searchParams.has("file"))
          fileReads.push(url.searchParams.get("file")!);
      });
      try {
        const diffResponsePromise = firstPage.waitForResponse((response) => {
          const url = new URL(response.url());
          return url.pathname === "/api/worktree-diff" && !url.searchParams.has("file");
        });
        await firstPage.getByRole("tab", { name: "Diff" }).click();
        const diffResponse = await diffResponsePromise;
        if (!diffResponse.ok())
          throw new Error(
            `Worktree diff returned ${diffResponse.status()}: ${await diffResponse.text()}`,
          );
        await firstPage.getByText("excludes commit history").waitFor();
        const changedPaths = [
          "modified.ts",
          "staged.txt",
          "new-staged.txt",
          "deleted.txt",
          "renamed.txt",
          "untracked.txt",
          "binary.dat",
          "large.txt",
          "outside-link",
          "odd\nname.txt",
        ];
        for (const path of changedPaths) {
          const panel = firstPage.getByTitle(path, { exact: true });
          await panel.waitFor();
          assert.equal(
            await panel.evaluate((element) =>
              element.closest("button")?.getAttribute("aria-expanded"),
            ),
            "false",
            `${JSON.stringify(path)} starts collapsed`,
          );
        }
        assert.deepEqual(fileReads, [], "collapsed diff panels do not fetch per-file content");

        for (const path of changedPaths) {
          const fileResponsePromise = firstPage.waitForResponse((response) => {
            const url = new URL(response.url());
            return url.pathname === "/api/worktree-diff" && url.searchParams.get("file") === path;
          });
          await firstPage.getByTitle(path, { exact: true }).click();
          const fileResponse = await fileResponsePromise;
          assert.ok(fileResponse.ok(), `expanded diff panel reads ${JSON.stringify(path)}`);
        }
        assert.deepEqual(fileReads, changedPaths, "each expanded panel fetches only its own file");
        await firstPage.getByText(/state = 'working'/).waitFor();
        await firstPage.getByText(/state = 'before'/).waitFor();
        await firstPage.getByText("staged only").waitFor();
        await firstPage.getByText("staged addition").waitFor();
        await firstPage.getByText("untracked addition").waitFor();
        await firstPage.getByText("Binary file; text preview is not available.").waitFor();
        await firstPage.getByText("File exceeds the preview size limit.").waitFor();
        await firstPage.getByText("outside-link").waitFor();
        await firstPage.getByTitle("rename-old.txt", { exact: true }).waitFor();
        await firstPage.getByText("unusual filename", { exact: true }).waitFor();
        if (process.env.EDEN_WORKTREE_DIFF_E2E_SCREENSHOT)
          await firstPage.screenshot({ path: process.env.EDEN_WORKTREE_DIFF_E2E_SCREENSHOT });
        const documentWidth = await firstPage.evaluate(
          () => [document.documentElement.scrollWidth, window.innerWidth] as const,
        );
        assert.ok(
          documentWidth[0] <= documentWidth[1] + 1,
          "the diff viewer stays within a phone viewport",
        );
      } finally {
        const { profile } = await diffProfiler.send("Profiler.stop");
        await diffProfiler.send("Profiler.disable");
        await diffProfiler.send("Emulation.setCPUThrottlingRate", { rate: 1 });
        await diffProfiler.detach();
        console.log(
          JSON.stringify({
            worktreeDiffCpuProfileSamples: profile.samples?.length ?? 0,
            worktreeDiffCpuProfileNodes: profile.nodes.length,
            worktreeDiffFileReads: fileReads.length,
            cpuThrottleRate: 4,
            viewport: "390x844",
          }),
        );
      }
    }
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
    if (process.env.EDEN_CONVERSATION_E2E_SKIP_MODEL !== "1") {
      const modelPicker = firstPage.getByRole("combobox", { name: "Choose OpenCode model" });
      assert.deepEqual(modelDiscoveryGets, [], "model discovery stays lazy until the picker opens");
      const modelListResponse = firstPage.waitForResponse(
        (response) =>
          response.url().includes(`/api/conversations/${conversationID}/models`) &&
          response.request().method() === "GET",
      );
      await modelPicker.click();
      assert.equal((await modelListResponse).status(), 200);
      const modelOptions = firstPage.getByRole("option");
      assert.equal(await modelOptions.first().innerText(), "Default model");
      await firstPage.getByRole("group", { name: "Anthropic" }).waitFor();
      await firstPage.getByRole("group", { name: "OpenCode" }).waitFor();
      if (process.env.EDEN_OPENCODE_MODEL_E2E_SCREENSHOT)
        await firstPage.screenshot({ path: process.env.EDEN_OPENCODE_MODEL_E2E_SCREENSHOT });
      await firstPage.getByRole("option", { name: "Claude Fixture" }).click();
      await firstPage.getByRole("option", { name: "Claude Fixture" }).waitFor({ state: "hidden" });
      await modelPicker.getByText("Claude Fixture").waitFor();
      await modelPicker.focus();
      await modelPicker.press("ArrowDown");
      await firstPage.keyboard.press("ArrowDown");
      await firstPage.keyboard.press("Enter");
      await modelPicker.getByText("Fake Free").waitFor();
      await modelPicker.press("ArrowDown");
      await firstPage.keyboard.press("ArrowUp");
      await firstPage.keyboard.press("Enter");
      await modelPicker.getByText("Claude Fixture").waitFor();
    }

    await firstComposer.click();
    await firstComposer.evaluate((element) => element.blur());
    await firstPage.evaluate(() =>
      Promise.all(document.getAnimations().map((animation) => animation.finished)),
    );
    await firstPage.setViewportSize({ width: 1400, height: 950 });
    if (process.env.EDEN_OPENCODE_COMPOSER_DESKTOP_SCREENSHOT)
      await firstPage.screenshot({
        path: process.env.EDEN_OPENCODE_COMPOSER_DESKTOP_SCREENSHOT,
      });
    await firstPage.setViewportSize({ width: 390, height: 844 });
    const mobileComposerBounds = await firstPage.evaluate(() => ({
      documentWidth: document.documentElement.scrollWidth,
      composerRight: document.querySelector('[data-slot="input-group"]')!.getBoundingClientRect()
        .right,
      viewportWidth: window.innerWidth,
    }));
    assert.ok(
      mobileComposerBounds.documentWidth <= mobileComposerBounds.viewportWidth + 1,
      "the composer fits a phone viewport without horizontal overflow",
    );
    assert.ok(
      mobileComposerBounds.composerRight <= mobileComposerBounds.viewportWidth + 1,
      "the composer stays inside the phone viewport",
    );
    if (process.env.EDEN_OPENCODE_COMPOSER_MOBILE_SCREENSHOT)
      await firstPage.screenshot({
        path: process.env.EDEN_OPENCODE_COMPOSER_MOBILE_SCREENSHOT,
      });
    const initialComposerHeight = await firstComposer.evaluate((element) => element.clientHeight);
    await firstComposer.fill(
      Array.from({ length: 12 }, (_, index) => `draft line ${index}`).join("\n"),
    );
    const expandedComposerHeight = await firstComposer.evaluate((element) => element.clientHeight);
    assert.ok(
      expandedComposerHeight > initialComposerHeight && expandedComposerHeight <= 160,
      "the mobile composer grows with the draft up to its bounded height",
    );
    await firstComposer.fill("");

    await firstComposer.fill("**first fake prompt**");
    await firstComposer.press("Enter");
    const firstPrompt = await fake.waitForPromptCount(1);
    let messageListCount = fake.messageLists;
    const firstTurn = fake.startTurn(firstPrompt);
    fake.emitTextStarted(firstTurn);
    fake.startTool(firstTurn, "fake-tool");
    await firstPage.getByText("Running fake-tool", { exact: true }).waitFor();
    assert.equal(
      await firstPage.getByText("fake secret input", { exact: true }).count(),
      0,
      "native tool inputs are not shown in the transcript",
    );
    fake.finishTool(firstTurn, "fake-tool");
    await firstPage.getByText("Completed fake-tool", { exact: true }).waitFor();
    fake.failTool(firstTurn, "fake-failing-tool");
    await firstPage.getByText("Failed fake-failing-tool", { exact: true }).waitFor();
    assert.equal(
      await firstPage.getByText(/fake secret (result|failure output)/).count(),
      0,
      "native tool results and errors are not shown in the transcript",
    );
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
    const socketCountBeforeReconnect = await firstPage.evaluate(() => {
      const sockets = (window as unknown as Window & { __edenConversationSockets: WebSocket[] })
        .__edenConversationSockets;
      sockets
        .filter((socket) => socket.readyState === WebSocket.OPEN)
        .at(-1)!
        .close();
      return sockets.length;
    });
    fake.emitTextDelta(firstTurn, "\nreconnected transcript update");
    await firstPage.waitForFunction(
      (count) =>
        (window as Window & { __edenConversationSockets?: WebSocket[] }).__edenConversationSockets
          ?.slice(count)
          .some((socket) => socket.readyState === WebSocket.OPEN),
      socketCountBeforeReconnect,
    );
    await firstPage.getByText("reconnected transcript update", { exact: true }).waitFor();
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
    await secondPage.getByText("Completed fake-tool", { exact: true }).waitFor();
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
    assert.equal(
      await secondPage.getByRole("menuitem", { name: /Reopen OpenCode conversation/ }).count(),
      0,
      "hidden conversations are no longer listed in the session menu",
    );
    await secondPage.getByRole("menuitem", { name: "OpenCode conversation" }).press("Escape");
    await secondPage.locator('[data-slot="dropdown-menu-content"]').waitFor({ state: "hidden" });
    await secondPage.waitForFunction(
      () => document.querySelectorAll("[data-base-ui-inert]").length === 0,
    );
    await secondPage.setViewportSize({ width: 390, height: 844 });
    await secondPage.getByRole("button", { name: "Hide worktrees sidebar" }).click();
    await secondPage.getByRole("button", { name: "Hidden conversations" }).click();
    await secondPage.getByRole("heading", { name: "Hidden conversations" }).waitFor();
    const hiddenConversation = secondPage.getByRole("button", {
      name: "Reopen OpenCode conversation 1",
    });
    await hiddenConversation.waitFor({ state: "visible" });
    const sidebarWidth = await secondPage.evaluate(
      () => [document.documentElement.scrollWidth, window.innerWidth] as const,
    );
    assert.ok(sidebarWidth[0] <= sidebarWidth[1] + 1, "the hidden-conversation sheet fits mobile");
    await Promise.all(
      ["sheet-overlay", "sheet-content"].map((slot) =>
        secondPage
          .locator(`[data-slot="${slot}"]`)
          .evaluate((element) =>
            Promise.all(element.getAnimations().map((animation) => animation.finished)),
          ),
      ),
    );
    if (process.env.EDEN_HIDDEN_CONVERSATIONS_MOBILE_SCREENSHOT)
      await secondPage.screenshot({
        path: process.env.EDEN_HIDDEN_CONVERSATIONS_MOBILE_SCREENSHOT,
      });
    await hiddenConversation.click();
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
    await reopenedPage.getByText("Completed fake-tool", { exact: true }).waitFor();
    await reopenedPage.getByText("Failed fake-failing-tool", { exact: true }).waitFor();
    await reopenedPage.route(`**/api/conversations/${conversationID}/models`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          models: [
            {
              key: JSON.stringify(["anthropic", "claude-fixture"]),
              id: "claude-fixture",
              providerID: "anthropic",
              name: "Claude Fixture",
            },
            ...Array.from({ length: 40 }, (_, index) => ({
              key: JSON.stringify(["fake", `scroll-model-${index}`]),
              id: `scroll-model-${index}`,
              providerID: "fake",
              name: `Scroll Model ${index}`,
            })),
          ],
        }),
      }),
    );
    const reopenedModelPicker = reopenedPage.getByRole("combobox", {
      name: "Choose OpenCode model",
    });
    await reopenedModelPicker.getByText("Claude Fixture", { exact: true }).waitFor();
    assert.equal(
      modelDiscoveryGets.length,
      1,
      "reopening shows the stored model label without discovering models",
    );
    await reopenedModelPicker.click();
    await reopenedPage.getByRole("option", { name: "Claude Fixture · anthropic" }).waitFor();
    const modelPopup = reopenedPage.locator('[data-slot="select-content"]');
    await modelPopup.waitFor();
    const desktopPopup = await modelPopup.evaluate((element) => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
    }));
    assert.ok(
      desktopPopup.scrollHeight > desktopPopup.clientHeight,
      "a long model list scrolls inside its desktop popup",
    );
    assert.ok(desktopPopup.clientHeight <= 384, "the desktop model popup has a bounded height");
    assert.equal(
      await reopenedPage.getByRole("listbox").getByRole("group").count(),
      0,
      "ungrouped models stay flat",
    );
    await reopenedPage.setViewportSize({ width: 390, height: 844 });
    const mobilePopup = await modelPopup.evaluate((element) => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
    }));
    assert.ok(
      mobilePopup.scrollHeight > mobilePopup.clientHeight,
      "a long model list scrolls inside its mobile popup",
    );
    assert.ok(mobilePopup.clientHeight <= 506, "the mobile model popup fits the viewport");
    await reopenedPage.keyboard.press("Escape");
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

async function verifyNavigationVariants(page: Page) {
  const navigation = page.getByRole("navigation", { name: "Main" });
  const routeLabels = ["Board", "Doing", "PRs", "Health"];
  const assertSingleRouteSet = async () => {
    for (const label of routeLabels) {
      assert.equal(
        await navigation.getByRole("link", { name: label }).count(),
        1,
        `${label} appears once in main navigation`,
      );
    }
    assert.equal(
      await navigation.getByRole("button", { name: "Settings" }).count(),
      1,
      "Settings remains available from the navigation rail",
    );
  };
  const railWidth = async () =>
    navigation.evaluate((element) => element.getBoundingClientRect().width);

  await assertSingleRouteSet();
  assert.equal(await railWidth(), 48, "Classic retains its 48px icon rail");
  await page.getByRole("button", { name: "Settings" }).click();
  const appearance = page.getByRole("dialog").getByRole("combobox", { name: "Navigation" });
  await appearance.click();
  await page.getByRole("option", { name: "Sidebar 09" }).click();
  await page.locator('[data-slot="dialog-close"]').click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await assertSingleRouteSet();
  assert.equal(await railWidth(), 48, "Sidebar 09 uses a compact 48px icon rail");
  assert.equal(
    await page.getByRole("button", { name: "Hide worktrees sidebar" }).count(),
    1,
    "the distinct Doing worktree sidebar remains available",
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  assert.equal(await railWidth(), 48, "Sidebar 09 stays 48px wide at the comparison viewport");
  if (process.env.EDEN_NAVIGATION_E2E_SCREENSHOT)
    await page.screenshot({ path: process.env.EDEN_NAVIGATION_E2E_SCREENSHOT, fullPage: true });
  await page.setViewportSize({ width: 1400, height: 950 });
  await page.reload();
  await page.getByRole("navigation", { name: "Main" }).waitFor();
  await assertSingleRouteSet();
  assert.equal(
    await page.evaluate(() => {
      const stored = JSON.parse(localStorage.getItem("eden.theme-settings") ?? "{}");
      return stored.navigationStyle;
    }),
    "sidebar-09",
    "Sidebar 09 selection persists across reloads",
  );
  await page.getByRole("button", { name: "Settings" }).click();
  const persistedAppearance = page
    .getByRole("dialog")
    .getByRole("combobox", { name: "Navigation" });
  await persistedAppearance.click();
  await page.getByRole("option", { name: "Classic (recommended)" }).click();
  await page.locator('[data-slot="dialog-close"]').click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await assertSingleRouteSet();
  assert.equal(await railWidth(), 48, "Classic can be restored from Appearance");
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

  startTool(turn: FakeTurn, name: string) {
    this.updateTool(turn, name, "running");
    this.emit({
      type: "session.tool.input.started",
      id: randomID(),
      created: Date.now(),
      data: {
        sessionID: nativeSessionID,
        assistantMessageID: turn.assistantID,
        id: "tool-1",
        name,
      },
    });
    this.emit({
      type: "session.tool.called",
      id: randomID(),
      created: Date.now(),
      data: {
        sessionID: nativeSessionID,
        assistantMessageID: turn.assistantID,
        id: "tool-1",
        input: { secret: "fake secret input" },
        executed: true,
      },
    });
  }

  finishTool(turn: FakeTurn, name: string) {
    this.updateTool(turn, name, "completed");
    this.emit({
      type: "session.tool.success",
      id: randomID(),
      created: Date.now(),
      data: {
        sessionID: nativeSessionID,
        assistantMessageID: turn.assistantID,
        id: "tool-1",
        content: [{ type: "text", text: "fake secret result" }],
        executed: true,
      },
    });
  }

  failTool(turn: FakeTurn, name: string) {
    this.updateTool(turn, name, "failed", "tool-2");
    this.emit({
      type: "session.tool.input.started",
      id: randomID(),
      created: Date.now(),
      data: {
        sessionID: nativeSessionID,
        assistantMessageID: turn.assistantID,
        id: "tool-2",
        name,
      },
    });
    this.emit({
      type: "session.tool.failed",
      id: randomID(),
      created: Date.now(),
      data: {
        sessionID: nativeSessionID,
        assistantMessageID: turn.assistantID,
        id: "tool-2",
        error: { name: "Error", message: "fake secret failure output" },
        executed: true,
      },
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
    if (path === "/api/model/default" && request.method === "GET")
      return json(response, 200, {
        data: {
          id: "fake-free",
          modelID: "fake-free",
          providerID: "opencode",
          type: "chat",
          name: "Fake Free",
        },
      });
    if (path === "/api/model" && request.method === "GET")
      return json(response, 200, {
        data: [
          {
            id: "claude-fixture",
            modelID: "claude-fixture",
            providerID: "anthropic",
            type: "chat",
            name: "Claude Fixture",
            enabled: true,
          },
          {
            id: "fake-free",
            modelID: "fake-free",
            providerID: "opencode",
            type: "chat",
            name: "Fake Free",
            enabled: true,
          },
        ],
      });
    if (path === "/api/provider" && request.method === "GET")
      return json(response, 200, {
        data: [
          { id: "anthropic", name: "Anthropic" },
          { id: "opencode", name: "OpenCode" },
        ],
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
    const modelMatch = path.match(/^\/api\/session\/([^/]+)\/model$/);
    if (modelMatch && request.method === "POST") {
      assert.equal(decodeURIComponent(modelMatch[1]!), nativeSessionID);
      const body = await readJson(request);
      assert.deepEqual(
        body.model,
        process.env.EDEN_CONVERSATION_E2E_SKIP_MODEL === "1"
          ? { id: "fake-free", providerID: "opencode" }
          : { id: "claude-fixture", providerID: "anthropic" },
      );
      return response.writeHead(204).end();
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
    const parts = message.content as Record<string, unknown>[];
    message.content = [{ type: "text", text }, ...parts.filter((part) => part.type === "tool")];
    if (finished) {
      message.finish = "stop";
      message.time = { created: Date.now(), completed: Date.now() };
    }
  }

  private updateTool(
    turn: FakeTurn,
    name: string,
    status: "running" | "completed" | "failed",
    id = "tool-1",
  ) {
    const message = this.sessionMessages.find((entry) => entry.id === turn.assistantID)!;
    const parts = message.content as Record<string, unknown>[];
    message.content = [
      ...parts.filter((part) => part.type !== "tool" || part.id !== id),
      {
        type: "tool",
        id,
        name,
        state:
          status === "completed"
            ? {
                status,
                input: { secret: "fake secret input" },
                content: [{ type: "text", text: "fake secret result" }],
              }
            : status === "failed"
              ? {
                  status: "error",
                  input: { secret: "fake secret input" },
                  error: { name: "Error", message: "fake secret failure output" },
                }
              : { status, input: { secret: "fake secret input" } },
      },
    ];
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
