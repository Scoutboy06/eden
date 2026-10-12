export function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

// Shell quoting and _arguments' specification grammar are separate layers.
export function specText(value: string): string {
  return value.replace(/[\\:[\]]/g, "\\$&");
}

// _describe uses the first unescaped colon to separate a name from its label.
export function describeEntry(name: string, description: string): string {
  return quote(`${name.replace(/[\\:]/g, "\\$&")}:${description}`);
}
