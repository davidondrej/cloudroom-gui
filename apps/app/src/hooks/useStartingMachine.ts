import { useAtom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { createLocalStorageEnumStorage } from "@/lib/browser-storage";

export type StartingMachine = "cloud" | "last";

const STARTING_MACHINE_KEY = "cloudroom.startingMachine";

const startingMachineAtom = atomWithStorage<StartingMachine>(
  STARTING_MACHINE_KEY,
  "cloud",
  createLocalStorageEnumStorage<StartingMachine>(
    (value): value is StartingMachine => value === "cloud" || value === "last",
  ),
  { getOnInit: true },
);

export function useStartingMachine() {
  return useAtom(startingMachineAtom);
}

export function startingExecutionTarget(newThread: boolean): "local" | "cloud" {
  const startInCloud =
    newThread && localStorage.getItem(STARTING_MACHINE_KEY) !== "last";
  return startInCloud ||
    localStorage.getItem("cloudroom.executionTarget") === "cloud"
    ? "cloud"
    : "local";
}
