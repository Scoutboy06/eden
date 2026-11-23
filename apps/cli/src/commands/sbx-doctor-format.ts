import type { SandboxDoctorReport } from "../../../../src/modules/sandbox/provider";

export function formatDoctor(
  provider: string,
  report: SandboxDoctorReport,
  problemCount: number,
): string {
  if (!report.applicable) {
    return `The sandboxd link check does not apply to ${provider} on this host.`;
  }
  const lines = [
    `State folder: ${report.stateDir}`,
    `Current TEMP: ${report.temp ?? "unknown"}`,
    "",
    ...report.links.map(formatDoctorLink),
    "",
  ];
  const hasMissing = report.links.some((link) => link.status === "missing");
  if (problemCount === 0) {
    lines.push(
      report.links.some((link) => link.status === "created")
        ? "Missing links were recreated."
        : "All sandboxd links are in place.",
    );
  } else {
    lines.push(`${problemCount} sandboxd link problem${problemCount === 1 ? "" : "s"} found.`);
    if (hasMissing) lines.push("Recreate missing links with: eden sbx doctor --fix");
    lines.push("Existing links with the wrong target are never changed; fix them manually.");
  }

  return lines.join("\n");
}

function formatDoctorLink(link: SandboxDoctorReport["links"][number]): string {
  const detail =
    link.status === "wrong-target"
      ? ` (points to: ${link.actual})`
      : link.status === "failed"
        ? ` (${link.error})`
        : "";

  return `  ${link.status.padEnd(12)} ${link.path}${detail}`;
}
