import { MultiFileDiff, type DiffFileInput } from "@pierre/diffs/react";

import type { WorktreeDiffFile } from "../../shared/worktree-diff";

export type DiffViewerFile = WorktreeDiffFile;

export function DiffViewerContent({ file }: { file: DiffViewerFile }) {
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
  );
}
