export function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function quotePowerShell(value: string): string {
  return `'${value.replace(/['‘’‚‛]/g, "$&$&")}'`;
}
