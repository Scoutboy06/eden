import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

import { Button } from "@/components/ui/button";
import { sendTerminal, subscribeTerminals, terminalClientId } from "@/pages/terminal-socket";

type Mode = "connecting" | "controller" | "viewer";

export function TerminalPane({ sessionId }: { sessionId: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<Mode>("connecting");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!host.current) return;
    return openTerminal(host.current, sessionId, setMode, setError);
  }, [sessionId]);

  return (
    <div className="absolute inset-0 bg-[#101214] text-[#e8e8e8]">
      <div ref={host} className="absolute inset-3 overflow-auto" />
      {mode !== "controller" && (
        <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center bg-black/35 p-3">
          <div className="pointer-events-auto rounded-lg border border-white/15 bg-[#101214] px-4 py-3 text-center shadow-lg">
            {mode === "viewer" ? (
              <>
                <p className="mb-2 text-xs text-white/75">Viewing only</p>
                <Button size="sm" onClick={() => sendTerminal({ type: "take-control", sessionId })}>
                  Take control
                </Button>
              </>
            ) : (
              <p role={error ? "alert" : "status"} className="text-sm">
                {error ?? "Connecting to terminal…"}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function openTerminal(
  host: HTMLDivElement,
  sessionId: string,
  setMode: (mode: Mode) => void,
  setError: (error: string | null) => void,
) {
  const terminal = new Terminal({
    cursorBlink: true,
    fontFamily: "'JetBrains Mono Variable', monospace",
    fontSize: 13,
    scrollback: 0,
    disableStdin: true,
  });
  const fit = new FitAddon();
  const requestId = `pane:${sessionId}`;
  terminal.loadAddon(fit);
  terminal.open(host);

  function resize() {
    if (terminal.options.disableStdin || !host.clientWidth || !host.clientHeight) return;
    fit.fit();
    sendTerminal({ type: "resize", sessionId, cols: terminal.cols, rows: terminal.rows });
  }

  function setController(controller: unknown) {
    const controls = controller === terminalClientId();
    terminal.options.disableStdin = !controls;
    setMode(controls ? "controller" : "viewer");
    if (controls) resize();
  }

  const unsubscribe = subscribeTerminals((message) => {
    if (message.type === "connected") {
      setError(null);
      sendTerminal({ type: "attach", sessionId, requestId });
    } else if (message.type === "disconnected") {
      terminal.options.disableStdin = true;
      setMode("connecting");
    } else if (message.type === "error" && message.requestId === requestId) {
      setError(String(message.error));
    } else if (message.sessionId === sessionId) {
      switch (message.type) {
        case "attached":
          terminal.reset();
          terminal.resize(Number(message.cols), Number(message.rows));
          if (typeof message.screen === "string" && message.screen) {
            terminal.write(message.screen, () => setController(message.controller));
          } else setController(message.controller);
          break;
        case "resize":
          terminal.resize(Number(message.cols), Number(message.rows));
          break;
        case "state":
          setController(message.controller);
          if (message.controller === terminalClientId()) terminal.focus();
          break;
        case "output":
          if (typeof message.data === "string") {
            terminal.write(Uint8Array.from(atob(message.data), (char) => char.charCodeAt(0)));
          }
          break;
      }
    }
  });
  const input = terminal.onData((value) => {
    if (terminal.options.disableStdin) return;
    const bytes = new TextEncoder().encode(value);
    const data = btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
    sendTerminal({ type: "input", sessionId, data });
  });
  const observer = new ResizeObserver(resize);
  observer.observe(host);

  return () => {
    observer.disconnect();
    input.dispose();
    unsubscribe();
    sendTerminal({ type: "detach", sessionId });
    terminal.dispose();
  };
}
