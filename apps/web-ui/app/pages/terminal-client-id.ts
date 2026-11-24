import { randomId } from "@/pages/random-id";

type IdentityMessage =
  | { type: "probe"; clientId: string; documentId: string }
  | { type: "occupied"; documentId: string };

export async function claimTerminalClientId() {
  const key = "eden-terminal-client";
  const navigation = performance.getEntriesByType("navigation")[0] as
    | PerformanceNavigationTiming
    | undefined;
  const stored = navigation?.type === "reload" ? sessionStorage.getItem(key) : null;
  let clientId = stored ?? randomId();

  if (typeof BroadcastChannel !== "undefined") {
    const channel = new BroadcastChannel("eden-terminal-client-id");
    const documentId = randomId();
    let probing = stored !== null;
    let occupied = false;
    channel.onmessage = ({ data }: MessageEvent<IdentityMessage>) => {
      if (data.type === "occupied" && data.documentId === documentId) occupied = true;
      if (data.type !== "probe" || data.clientId !== clientId) return;
      if (!probing || documentId < data.documentId) {
        channel.postMessage({ type: "occupied", documentId: data.documentId });
      }
    };
    window.addEventListener("pagehide", ({ persisted }) => {
      if (!persisted) channel.close();
    });

    if (probing) {
      channel.postMessage({ type: "probe", documentId, clientId });
      await new Promise<void>((resolve) => window.setTimeout(resolve, 100));
      if (occupied) clientId = randomId();
      probing = false;
    }
  }

  sessionStorage.setItem(key, clientId);
  return clientId;
}
