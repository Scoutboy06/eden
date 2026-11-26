import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

import { Button } from "@/components/ui/button";
import { sendTerminal, subscribeTerminals, terminalClientId } from "@/pages/terminal-socket";

type Mode = "connecting" | "controller" | "viewer";

export function TerminalPane({
  sessionId,
  claimLaunchFocus,
}: {
  sessionId: string;
  claimLaunchFocus: (sessionId: string) => boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<Mode>("connecting");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!host.current) return;
    return openTerminal(host.current, sessionId, claimLaunchFocus, setMode, setError);
  }, [sessionId, claimLaunchFocus]);

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
  claimLaunchFocus: (sessionId: string) => boolean,
  setMode: (mode: Mode) => void,
  setError: (error: string | null) => void,
) {
  const terminal = new Terminal({
    cursorBlink: true,
    fontFamily: "'JetBrains Mono Variable', monospace",
    fontSize: 13,
    scrollback: 2000,
    disableStdin: true,
  });
  const fit = new FitAddon();
  const requestId = `pane:${sessionId}`;
  terminal.loadAddon(fit);
  terminal.open(host);
  terminal.attachCustomWheelEventHandler(
    () => terminal.buffer.active.type === "normal" || terminal.modes.mouseTrackingMode !== "none",
  );

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

  function finishAttach(controller: unknown) {
    setController(controller);
    if (!terminal.options.disableStdin && claimLaunchFocus(sessionId)) terminal.focus();
  }

  function attach() {
    setError(null);
    sendTerminal({ type: "attach", sessionId, requestId });
  }

  function disconnect() {
    terminal.options.disableStdin = true;
    setMode("connecting");
  }

  function handleError(message: Record<string, unknown>) {
    if (message.requestId === requestId) setError(String(message.error));
  }

  function handleSessionMessage(message: Record<string, unknown>) {
    switch (message.type) {
      case "attached":
        terminal.reset();
        terminal.resize(Number(message.cols), Number(message.rows));
        if (typeof message.screen === "string" && message.screen) {
          terminal.write(message.screen, () => finishAttach(message.controller));
        } else finishAttach(message.controller);
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

  const unsubscribe = subscribeTerminals((message) => {
    if (message.type === "connected") {
      attach();
    } else if (message.type === "disconnected") {
      disconnect();
    } else if (message.type === "error") {
      handleError(message);
    } else if (message.sessionId === sessionId) {
      handleSessionMessage(message);
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
