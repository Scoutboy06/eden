import { MultiFileDiff, type DiffFileInput } from "@pierre/diffs/react";

import type { WorktreeDiffFile } from "../../shared/worktree-diff";

export type DiffViewerFile = WorktreeDiffFile;

export function DiffViewer({
  files,
  omittedFileCount = 0,
}: {
  files: DiffViewerFile[];
  omittedFileCount?: number;
}) {
  if (files.length === 0 && omittedFileCount === 0)
    return (
      <div className="rounded-lg border border-dashed border-border p-8 text-center">
        <h3 className="text-sm font-medium">Working tree clean</h3>
        <p className="mt-2 text-xs text-muted-foreground">
          No staged, unstaged, or untracked changes.
        </p>
      </div>
    );

  return (
    <div className="space-y-4">
      {files.map((file) => (
        <DiffFile key={`${file.previousPath ?? ""}\0${file.path}`} file={file} />
      ))}
      {omittedFileCount > 0 ? (
        <p role="status" className="rounded border border-border p-3 text-xs text-muted-foreground">
          Showing the first {files.length} changed files. {omittedFileCount} more were omitted to
          keep the response bounded.
        </p>
      ) : null}
    </div>
  );
}

function DiffFile({ file }: { file: DiffViewerFile }) {
  if (file.fallback || (file.oldContents === null && file.newContents === null))
    return (
      <article className="overflow-hidden rounded-lg border border-border">
        <FileHeader file={file} />
        <p className="px-4 py-5 text-sm text-muted-foreground">{fallbackMessage(file)}</p>
      </article>
    );

  const oldFile =
    file.oldContents === null
      ? null
      : { name: file.previousPath ?? file.path, contents: file.oldContents };
  const newFile =
    file.newContents === null ? null : { name: file.path, contents: file.newContents };
  const fileInput: DiffFileInput =
    oldFile === null
      ? { oldFile: null, newFile: newFile! }
      : newFile === null
        ? { oldFile, newFile: null }
        : { oldFile, newFile };

  return (
    <article className="overflow-hidden rounded-lg border border-border">
      <div className="flex items-center justify-between gap-3 border-b border-border bg-muted/30 px-4 py-2">
        <span className="truncate font-mono text-xs" title={file.path}>
          {file.path}
        </span>
        <span className="shrink-0 text-[10px] capitalize text-muted-foreground">{file.change}</span>
      </div>
      {file.previousPath ? (
        <p className="border-b border-border px-4 py-1 font-mono text-[10px] text-muted-foreground">
          Renamed from <span title={file.previousPath}>{file.previousPath}</span>
        </p>
      ) : null}
      <MultiFileDiff
        {...fileInput}
        className="block max-w-full overflow-x-auto text-xs"
        options={{
          collapsed: false,
          diffStyle: "unified",
          themeType: "system",
          overflow: "scroll",
        }}
      />
    </article>
  );
}

function FileHeader({ file }: { file: DiffViewerFile }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border bg-muted/30 px-4 py-2">
      <span className="truncate font-mono text-xs" title={file.path}>
        {file.path}
      </span>
      <span className="shrink-0 text-[10px] capitalize text-muted-foreground">{file.change}</span>
    </div>
  );
}

function fallbackMessage(file: DiffViewerFile): string {
  if (file.fallback === "binary") return "Binary file; text preview is not available.";
  if (file.fallback === "too-large") return "File exceeds the preview size limit.";
  if (file.fallback === "conflict")
    return "Unmerged file; resolve the conflict before reviewing a text diff.";
  if (file.fallback === "unavailable") return "File could not be read safely from this worktree.";
  return "Diff contents are unavailable.";
}
