#!/usr/bin/env bun

const args = process.argv.slice(2);
const mode = process.env.EDEN_SBX_RUN_MODE;
const name = process.env.EDEN_SBX_RUN_NAME ?? "example";
const log = process.env.EDEN_SBX_RUN_LOG;
const kitFlags: string[] = JSON.parse(process.env.EDEN_SBX_RUN_KIT_FLAGS ?? "[]");
const firstArgument = kitFlags.indexOf("--kit-arg");
const split = firstArgument < 0 ? kitFlags.length : firstArgument;

if (log) {
  const { appendFile } = await import("node:fs/promises");
  await appendFile(log, `${JSON.stringify(args)}\n`);
}

if (JSON.stringify(args) === JSON.stringify(["ls", "--json"])) {
  if (process.env.EDEN_SBX_LIST_FAILURE) {
    process.stderr.write(process.env.EDEN_SBX_LIST_FAILURE);
    process.exit(1);
  }

  process.stdout.write(
    process.env.EDEN_SBX_LIST_RESULT ??
      (mode === "malformed"
        ? "invalid json"
        : JSON.stringify(mode === "missing" ? [] : [{ name, status: mode ?? "running" }])),
  );
} else if (JSON.stringify(args) === JSON.stringify(["policy", "ls", "--json"])) {
  if (process.env.EDEN_SBX_POLICY_FAILURE) {
    process.stderr.write(process.env.EDEN_SBX_POLICY_FAILURE);
    process.exit(1);
  }

  process.stdout.write("[]");
} else if (
  JSON.stringify(args) ===
  JSON.stringify([
    "create",
    "--name",
    name,
    ...(process.env.EDEN_SBX_RUN_IMAGE ? ["--template", process.env.EDEN_SBX_RUN_IMAGE] : []),
    ...(process.env.EDEN_SBX_PULL ? ["--pull", process.env.EDEN_SBX_PULL] : []),
    ...kitFlags.slice(0, split),
    ...JSON.parse(process.env.EDEN_SBX_MCP_FLAGS ?? "[]"),
    ...kitFlags.slice(split),
    "--skills",
    "off",
    ...(args.includes("--no-progress") ? ["--no-progress"] : []),
    ...(process.env.EDEN_SBX_WORKSPACE_MODE === "clone" ? ["--clone"] : []),
    process.env.EDEN_SBX_AGENT ?? "shell",
    ...(process.env.EDEN_SBX_WORKSPACE_PATH ? [process.env.EDEN_SBX_WORKSPACE_PATH] : []),
    ...JSON.parse(process.env.EDEN_SBX_MOUNT_PATHS ?? "[]"),
  ])
) {
  if (process.env.EDEN_SBX_CREDENTIAL_MODE === "missing") {
    if (process.stdin.isTTY && process.stdout.isTTY && process.stderr.isTTY) {
      process.stdout.write("Approve kit credential? ");
      const response = await new Response(Bun.stdin.stream()).text();
      if (!response.trim().startsWith("y")) process.exit(3);
    } else {
      process.stderr.write("required credential has no binding; sandbox will start without it\n");
    }
  }
  if (process.env.EDEN_SBX_CREDENTIAL_MODE === "wait") {
    await waitForInterrupt();
  }
  if (process.env.EDEN_SBX_ENV_LOG) {
    await Bun.write(
      process.env.EDEN_SBX_ENV_LOG,
      JSON.stringify({
        root: process.env.DOCKER_SANDBOXES_ROOT_SIZE,
        docker: process.env.DOCKER_SANDBOXES_DOCKER_SIZE,
        inherited: process.env.EDEN_INHERITED,
      }),
    );
  }

  if (process.env.EDEN_SBX_CREATE_FAILURE) {
    process.stderr.write(process.env.EDEN_SBX_CREATE_FAILURE);
    process.exit(1);
  }

  process.stdout.write("created\n");
} else if (
  JSON.stringify(args) === JSON.stringify(["rm", "--force", "--", name]) ||
  JSON.stringify(args) === JSON.stringify(["rm", "--", name])
) {
  if (process.env.EDEN_SBX_REQUIRE_TTY && !args.includes("--force")) {
    if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stderr.isTTY) process.exit(98);
    process.stdout.write("Confirm removal? ");
    const input = await new Response(Bun.stdin.stream()).text();
    if (!input.trim().startsWith("y")) process.exit(3);
  }
  if (process.env.EDEN_SBX_REMOVE_WAIT) {
    await waitForInterrupt();
  }
  if (process.env.EDEN_SBX_REMOVE_FAILURE) {
    process.stderr.write(process.env.EDEN_SBX_REMOVE_FAILURE);
    process.exit(7);
  }
  process.stdout.write("removed\n");
} else if (JSON.stringify(args) === JSON.stringify(["stop", "--", name])) {
  if (process.env.EDEN_SBX_STOP_FAILURE) {
    process.stderr.write(process.env.EDEN_SBX_STOP_FAILURE);
    process.exit(7);
  }

  if (mode === "interrupt") {
    process.on("SIGINT", () => process.exit(130));
    await Bun.write(process.env.EDEN_SBX_RUN_READY!, String(process.pid));
    setInterval(() => {}, 1000);
  } else {
    process.stdout.write("stopped\n");
  }
} else if (args[0] === "exec") {
  if (mode === "interrupt") await waitForInterrupt();
  if (mode === "terminal") process.stdin.setRawMode(true);
  if (mode === "stdin") process.stdout.write(`input:${await Bun.stdin.text()}`);
  else {
    process.stdout.write("command stdout\n");
    process.stderr.write("command stderr\n");
    process.exitCode = mode === "failure" ? 7 : mode === "provider-failure" ? 125 : 0;
  }
} else if (JSON.stringify(args) === JSON.stringify(["run", "--name", name])) {
  if (mode === "interrupt" || mode === "ignore" || mode === "terminal") {
    if (mode === "terminal") process.stdin.setRawMode(true);
    process.on("SIGINT", () => {
      if (mode !== "ignore") process.exit(130);
    });
    await Bun.write(process.env.EDEN_SBX_RUN_READY!, String(process.pid));
    setInterval(() => {}, 1000);
  } else if (mode === "stdin") {
    process.stdout.write(`input:${await Bun.stdin.text()}`);
  } else {
    process.stdout.write("attached\n");
    process.stderr.write("provider stderr\n");
    process.exitCode = mode === "failure" ? 7 : 0;
  }
} else {
  process.stderr.write(`Unexpected provider command: ${JSON.stringify(args)}\n`);
  process.exitCode = 99;
}

async function waitForInterrupt() {
  process.on("SIGINT", () => process.exit(130));
  await Bun.write(process.env.EDEN_SBX_RUN_READY!, "ready");
  setInterval(() => {}, 1000);
}
