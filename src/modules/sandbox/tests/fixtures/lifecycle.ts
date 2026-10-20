import { getEventListeners } from "node:events";
import { DockerSandboxProvider } from "../../providers/docker-sbx";

const readiness = process.argv[2] === "readiness";
const controller = new AbortController();
const abort = () => controller.abort();
const initialInterruptListeners = process.listenerCount("SIGINT");
const chunks: string[] = [];
const provider = new DockerSandboxProvider((text) => chunks.push(text));
let error: { code?: string; message: string } | undefined;

if (readiness) process.on("SIGUSR1", abort);

try {
  if (readiness) await provider.readinessChecks()[1]!.run(controller.signal);
  else await provider.create({ name: "test" });
} catch (cause) {
  error = {
    code: cause instanceof Error && "code" in cause ? String(cause.code) : undefined,
    message: cause instanceof Error ? cause.message : String(cause),
  };
} finally {
  if (readiness) process.off("SIGUSR1", abort);
}

console.log(
  JSON.stringify({
    error,
    output: chunks.join(""),
    interruptListeners: process.listenerCount("SIGINT") - initialInterruptListeners,
    abortListeners: getEventListeners(controller.signal, "abort").length,
  }),
);
