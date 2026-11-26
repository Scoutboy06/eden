import { lazy, Suspense, useEffect, useState } from "react";

import type { WorktreeDiffFile } from "../../shared/worktree-diff";
import type { DiffViewerFile } from "./diff-viewer-content";

const DiffViewerContent = lazy(async () => ({
  default: (await import("./diff-viewer-content")).DiffViewerContent,
}));

export function DiffViewer({
  files,
  omittedFileCount = 0,
  defaultOpen = false,
  loadFile,
}: {
  files: DiffViewerFile[];
  omittedFileCount?: number;
  defaultOpen?: boolean;
  loadFile: (path: string, signal?: AbortSignal) => Promise<WorktreeDiffFile>;
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
        <DiffFile
          key={`${file.previousPath ?? ""}\0${file.path}`}
          file={file}
          defaultOpen={defaultOpen}
          loadFile={loadFile}
        />
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

function DiffFile({
  file,
  defaultOpen,
  loadFile,
}: {
  file: DiffViewerFile;
  defaultOpen: boolean;
  loadFile: (path: string, signal?: AbortSignal) => Promise<WorktreeDiffFile>;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [content, setContent] = useState<WorktreeDiffFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || content) return;
    const controller = new AbortController();
    setLoading(true);
    void loadFile(file.path, controller.signal)
      .then(setContent)
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : "Could not read this change.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [content, file.path, loadFile, open]);

  return (
    <article className="overflow-hidden rounded-lg border border-border">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((expanded) => !expanded)}
        className="flex w-full items-center justify-between gap-3 border-b border-border bg-muted/30 px-4 py-2 text-left hover:bg-muted/50"
      >
        <span className="flex min-w-0 items-center gap-2">
          <span aria-hidden="true" className="shrink-0 text-muted-foreground">
            {open ? "⌄" : "›"}
          </span>
          <span className="truncate font-mono text-xs" title={file.path}>
            {file.path}
          </span>
        </span>
        <span className="shrink-0 text-[10px] capitalize text-muted-foreground">{file.change}</span>
      </button>
      {open ? (
        <>
          {file.previousPath ? (
            <p className="border-b border-border px-4 py-1 font-mono text-[10px] text-muted-foreground">
              Renamed from <span title={file.previousPath}>{file.previousPath}</span>
            </p>
          ) : null}
          <ExpandedDiffContent content={content} error={error} loading={loading} />
        </>
      ) : null}
    </article>
  );
}

function ExpandedDiffContent({
  content,
  error,
  loading,
}: {
  content: WorktreeDiffFile | null;
  error: string | null;
  loading: boolean;
}) {
  if (loading) return <p className="px-4 py-5 text-sm text-muted-foreground">Loading file…</p>;
  if (error)
    return (
      <p role="alert" className="px-4 py-5 text-sm text-destructive">
        {error}
      </p>
    );
  if (content?.fallback)
    return <p className="px-4 py-5 text-sm text-muted-foreground">{fallbackMessage(content)}</p>;
  if (!content) return null;
  return (
    <Suspense
      fallback={<p className="px-4 py-5 text-sm text-muted-foreground">Loading renderer…</p>}
    >
      <DiffViewerContent file={content} />
    </Suspense>
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
