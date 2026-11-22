const service = "eden-tailscale";
const entry = "eden";

export function get(): Promise<string | null> {
  return Bun.secrets.get({ service, name: entry });
}

export function set(value: string): Promise<void> {
  return Bun.secrets.set({ service, name: entry, value });
}

export function remove(): Promise<boolean> {
  return Bun.secrets.delete({ service, name: entry });
}
