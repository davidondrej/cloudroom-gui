import type { Thread } from "@bb/domain";
import { useAppCommandHandler } from "@/components/commands/AppCommandProvider";
import { useThreadActions } from "@/components/thread/ThreadActionsProvider";
import { usePaneContext } from "./PaneContext";

export function ThreadPinCommandHandler({ thread }: { thread: Thread }) {
  const { isFocused } = usePaneContext();
  const { togglePin } = useThreadActions();

  useAppCommandHandler("thread.pin", () => {
    if (!isFocused) return false;
    togglePin(thread);
    return true;
  });

  return null;
}
