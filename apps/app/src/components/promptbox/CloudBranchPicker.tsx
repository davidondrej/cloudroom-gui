import { useDeferredValue, useState } from "react";
import { StartBranchPicker } from "@bb/shared-ui/branch-picker-primitives";
import { useProjectSourceBranches } from "@/hooks/queries/project-queries";

interface CloudBranchPickerProps {
  projectId: string;
  /** The Mac whose checkout lists the GitHub branches. */
  hostId: string | null;
  /** null starts from the repository's default branch. */
  value: string | null;
  onChange: (branch: string | null) => void;
  disabled?: boolean;
}

/** Cloud threads clone from GitHub, so only branches on GitHub can be picked (docs/scopes/sandboxes.md). */
export function CloudBranchPicker({
  projectId,
  hostId,
  value,
  onChange,
  disabled = false,
}: CloudBranchPickerProps) {
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const branches = useProjectSourceBranches(projectId, hostId, {
    query: deferredQuery.trim().toLowerCase(),
    selectedBranch: "",
  });
  const defaultBranch =
    branches.data?.originDefaultBranch?.replace(/^origin\//, "") ??
    branches.data?.defaultBranch ??
    null;
  const githubBranches = (branches.data?.remoteBranches ?? [])
    .filter((branch) => branch.startsWith("origin/"))
    .map((branch) => branch.slice("origin/".length))
    .filter((branch) => branch !== "HEAD");
  const selected = value ?? defaultBranch;

  return (
    <StartBranchPicker
      label={selected ?? "Default branch"}
      sections={[{ label: "On GitHub", icon: "Globe", branches: githubBranches }]}
      selected={selected}
      badges={defaultBranch ? { [defaultBranch]: "default" } : undefined}
      note="Not on GitHub? Push it first, or use Teleport."
      isLoading={branches.isFetching}
      disabled={disabled}
      onSelect={(branch) => onChange(branch === defaultBranch ? null : branch)}
      onOpen={() => void branches.refreshFromRemote().catch(() => undefined)}
      onQueryChange={setQuery}
    />
  );
}
