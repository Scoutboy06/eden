export type WorktreeDiffFile = {
  path: string;
  previousPath?: string;
  change: "added" | "deleted" | "modified" | "renamed";
  oldContents: string | null;
  newContents: string | null;
  contentLoaded?: boolean;
  fallback?: "binary" | "too-large" | "conflict" | "unavailable";
};

export type WorktreeDiff = {
  files: WorktreeDiffFile[];
  base: "HEAD" | "empty tree";
  omittedFileCount: number;
};
