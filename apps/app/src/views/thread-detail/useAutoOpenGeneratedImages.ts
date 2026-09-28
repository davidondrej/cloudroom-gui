import { useEffect, useRef } from "react";
import type { TimelineRow } from "@bb/server-contract";
import {
  parseLocalFileHref,
  resolveRelativeLocalFileHref,
  type MarkdownPreviewLocalFileLink,
} from "@/components/ui/markdown-local-file-link";

const MAX_AUTO_OPENED_IMAGES = 5;
const MARKDOWN_CODE_PATTERN = /```[\s\S]*?```|`[^`\n]*`/g;
const MARKDOWN_IMAGE_PATTERN = /!\[[^\]]*\]\(\s*(?:<([^>]+)>|([^)\s]+))/g;
const TRUSTED_HOST = { kind: "trusted-host" } as const;

interface ShownImage {
  key: string;
  link: MarkdownPreviewLocalFileLink;
}

interface FindShownImagesArgs {
  afterSeq: number;
  rows: readonly TimelineRow[];
  workspaceRootPath: string | null;
}

interface UseAutoOpenGeneratedImagesArgs {
  enabled: boolean;
  isTurnRunning: boolean;
  openImage: (link: MarkdownPreviewLocalFileLink) => void;
  rows: readonly TimelineRow[] | null;
  threadId: string;
  workspaceRootPath: string | null;
}

interface AutoOpenState {
  afterSeq: number;
  openedKeys: Set<string>;
  threadId: string;
}

function toLocalImageLink(
  href: string,
  workspaceRootPath: string | null,
): MarkdownPreviewLocalFileLink | null {
  const absolute = parseLocalFileHref({ absoluteLinks: TRUSTED_HOST, href });
  if (absolute !== null || workspaceRootPath === null) return absolute;
  const resolved = resolveRelativeLocalFileHref({
    baseDir: workspaceRootPath,
    href,
    rootPath: workspaceRootPath,
  });
  return resolved === null
    ? null
    : parseLocalFileHref({ absoluteLinks: TRUSTED_HOST, href: resolved });
}

export function findShownImages({
  afterSeq,
  rows,
  workspaceRootPath,
}: FindShownImagesArgs): ShownImage[] {
  const images: ShownImage[] = [];
  const visit = (row: TimelineRow): void => {
    if (row.kind === "turn") {
      row.children?.forEach(visit);
      return;
    }
    if (
      row.kind !== "conversation" ||
      row.role !== "assistant" ||
      row.sourceSeqEnd <= afterSeq
    ) {
      return;
    }
    const prose = row.text.replace(MARKDOWN_CODE_PATTERN, "");
    for (const match of prose.matchAll(MARKDOWN_IMAGE_PATTERN)) {
      const link = toLocalImageLink(
        match[1] ?? match[2] ?? "",
        workspaceRootPath,
      );
      if (link === null) continue;
      const key = `${row.turnId ?? row.id}:${link.path}`;
      if (!images.some((image) => image.key === key))
        images.push({ key, link });
    }
  };
  rows.forEach(visit);
  return images;
}

export function useAutoOpenGeneratedImages({
  enabled,
  isTurnRunning,
  openImage,
  rows,
  threadId,
  workspaceRootPath,
}: UseAutoOpenGeneratedImagesArgs): void {
  const stateRef = useRef<AutoOpenState | null>(null);

  useEffect(() => {
    if (rows === null) return;
    const state = stateRef.current;
    if (state === null || state.threadId !== threadId) {
      stateRef.current = {
        afterSeq: rows.reduce(
          (max, row) => Math.max(max, row.sourceSeqEnd),
          -1,
        ),
        openedKeys: new Set(),
        threadId,
      };
      return;
    }
    if (isTurnRunning) return;

    const fresh = findShownImages({
      afterSeq: state.afterSeq,
      rows,
      workspaceRootPath,
    }).filter((image) => !state.openedKeys.has(image.key));
    for (const image of fresh) state.openedKeys.add(image.key);
    if (!enabled) return;

    const images = fresh.slice(0, MAX_AUTO_OPENED_IMAGES);
    for (const image of images) openImage(image.link);
    const [first] = images;
    if (images.length > 1 && first !== undefined) openImage(first.link);
  }, [enabled, isTurnRunning, openImage, rows, threadId, workspaceRootPath]);
}
