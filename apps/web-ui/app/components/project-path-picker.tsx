import { useEffect, useId, useRef, useState } from "react";
import { ArrowUp01Icon, Folder01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

type Listing = {
  directory: string;
  parent: string | null;
  prefix: string;
  directories: { name: string; path: string }[];
  truncated: boolean;
};

type BrowseResult = { path: string; listing: Listing } | { path: string; error: string };

export function ProjectPathPicker({
  path,
  onChange,
  disabled,
}: {
  path: string;
  onChange: (path: string) => void;
  disabled: boolean;
}) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const current = useFolderListing(path);
  const listing = current && "listing" in current ? current.listing : null;
  const status = folderStatus(current);

  function select(folder: string) {
    onChange(folder);
    input.current?.focus();
  }

  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id}>Repository path</label>
      <input
        id={id}
        ref={input}
        autoFocus
        required
        autoComplete="off"
        spellCheck={false}
        value={path}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
          event.preventDefault();
          if (!listing?.prefix) return;
          const [match, next] = listing.directories;
          if (match && !next) select(match.path);
        }}
        placeholder="~/src/my-project"
        disabled={disabled}
        aria-describedby={`${id}-hint`}
        className="rounded-md border bg-background px-3 py-2 font-mono"
      />
      <p id={`${id}-hint`} className="text-xs text-muted-foreground">
        Type to filter, or open a folder below. Enter completes a single match.
      </p>
      <div
        className="overflow-hidden rounded-md border bg-background"
        aria-label="Folders on the Eden host"
        role="group"
      >
        <div className="flex min-w-0 items-center gap-2 border-b bg-muted/50 px-2 py-1.5">
          <button
            type="button"
            disabled={disabled || !listing?.parent}
            onClick={() => listing?.parent && select(listing.parent)}
            aria-label="Parent folder"
            className="rounded p-1 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
          >
            <HugeiconsIcon icon={ArrowUp01Icon} className="size-4" />
          </button>
          <span className="min-w-0 flex-1 truncate font-mono text-xs" title={listing?.directory}>
            {listing?.directory ?? "Folders"}
          </span>
          <button
            type="button"
            disabled={disabled}
            onClick={() => select("~/")}
            className="rounded px-2 py-1 text-xs hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
          >
            Home
          </button>
        </div>
        <div className="h-32 overflow-y-auto p-1">
          <ul>
            {listing?.directories.map((folder) => (
              <li key={folder.path}>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => select(folder.path)}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-muted focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                >
                  <HugeiconsIcon
                    icon={Folder01Icon}
                    className="size-4 shrink-0 text-muted-foreground"
                  />
                  <span className="truncate" title={folder.name}>
                    {folder.name}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {status && (
            <p role="status" className="px-2 py-1.5 text-xs text-muted-foreground">
              {status}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function useFolderListing(path: string) {
  const [result, setResult] = useState<BrowseResult | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      const next = await fetchFolders(path, controller.signal);
      if (!controller.signal.aborted) setResult(next);
    }, 150);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [path]);

  return result?.path === path ? result : null;
}

async function fetchFolders(path: string, signal: AbortSignal): Promise<BrowseResult> {
  try {
    const response = await fetch(`/api/projects/directories?${new URLSearchParams({ path })}`, {
      headers: { "X-Eden-Directory-Browser": "1" },
      signal,
    });
    const body = (await response.json()) as Listing & { error?: string };
    if (!response.ok) throw new Error(body.error ?? "Could not load folders.");
    return { path, listing: body };
  } catch (error) {
    return { path, error: error instanceof Error ? error.message : "Could not load folders." };
  }
}

function folderStatus(result: BrowseResult | null) {
  if (!result) return "Looking for folders…";
  if ("error" in result) return result.error;
  const { directories, prefix, truncated } = result.listing;
  if (directories.length === 0) return prefix ? "No matching folders." : "No subfolders.";
  return truncated ? "Showing the first 100 folders. Type to narrow the list." : null;
}
