import type { ThreadEvent } from "./provider-event.js";

const ROOM_THREAD_NAME_PREFIX = "[room] ";
const LEGACY_THREAD_NAME_PREFIX = "[bb] ";

export function toProviderExternalThreadName(title: string): string {
  return `${ROOM_THREAD_NAME_PREFIX}${title}`;
}

export function fromProviderExternalThreadName(name: string): string {
  for (const prefix of [ROOM_THREAD_NAME_PREFIX, LEGACY_THREAD_NAME_PREFIX]) {
    if (name.startsWith(prefix)) return name.slice(prefix.length);
  }
  return name;
}

export function normalizeProviderThreadNameEvent(
  event: ThreadEvent,
): ThreadEvent {
  if (event.type !== "thread/name/updated") {
    return event;
  }
  return {
    ...event,
    threadName: fromProviderExternalThreadName(event.threadName),
  };
}
