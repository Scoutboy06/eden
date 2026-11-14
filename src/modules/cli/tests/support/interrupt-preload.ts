import { existsSync } from "node:fs";

const trigger = process.env.EDEN_TEST_INTERRUPT_FILE;

if (trigger) {
  const timer = setInterval(() => {
    if (!existsSync(trigger)) return;

    clearInterval(timer);
    process.emit("SIGINT");
  }, 10);
  timer.unref();
}
