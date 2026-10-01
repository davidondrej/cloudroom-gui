// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ThreadListEntry, ThreadWithRuntime } from "@bb/domain";
import { makeThreadWithRuntime as makeThreadWithRuntimeFixture } from "@bb/test-helpers/domain-fixtures";
import type {
  SidebarBootstrapResponse,
  ThreadResponse,
} from "@bb/server-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sdk } from "@/lib/sdk";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { makeThreadListEntry as makeThreadListEntryFixture } from "@bb/test-helpers/domain-fixtures";
import { makeThreadResponse as makeThreadResponseFixture } from "@/test/fixtures/thread-responses";
import {
  makeProjectWithThreadsResponse,
  makeSidebarBootstrapResponse,
} from "@/test/fixtures/projects";
import {
  sidebarNavigationQueryKey,
  threadListQueryKey,
  threadQueryKey,
} from "../queries/query-keys";
import {
  useMoveThreadToSection,
  useUnpinAndMoveThread,
  useUpdateThread,
} from "./thread-state-mutations";

vi.mock("@/lib/sdk", () => ({
  sdk: {
    threads: { unpin: vi.fn(), update: vi.fn(), unpinAndMove: vi.fn() },
  },
}));

function makeThreadWithRuntime(
  thread: Partial<ThreadWithRuntime> = {},
): ThreadWithRuntime {
  return makeThreadWithRuntimeFixture({
    id: "thread-1",
    projectId: "project-1",
    environmentId: "env-1",
    title: null,
    titleFallback: null,
    status: "active",
    lastReadAt: null,
    latestAttentionAt: 50,
    createdAt: 1,
    updatedAt: 1,
    runtime: {
      displayStatus: "waiting-for-host",
      hostReconnectGraceExpiresAt: null,
    },
    ...thread,
  });
}

function makeThreadResponse(
  thread: Partial<ThreadResponse> = {},
): ThreadResponse {
  return makeThreadResponseFixture({
    ...makeThreadWithRuntime(thread),
    ...thread,
  });
}

function makeThreadListEntry(
  thread: Partial<ThreadListEntry> = {},
): ThreadListEntry {
  return makeThreadListEntryFixture({
    ...makeThreadWithRuntime(),
    environmentHostId: "host-1",
    environmentName: "Environment",
    environmentBranchName: "main",
    ...thread,
  });
}

function makeSidebarNavigation(
  threads: ThreadListEntry[],
): SidebarBootstrapResponse {
  return makeSidebarBootstrapResponse({
    projects: [
      makeProjectWithThreadsResponse({
        id: "project-1",
        name: "Project",
        createdAt: 1,
        updatedAt: 1,
        threads,
      }),
    ],
  });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("thread state mutations", () => {
  it.each([
    ["leaves the current section unchanged", null, "sec_work", "none"],
    ["moves an unpinned thread to Threads", null, null, "update"],
    ["unpins into the stored section", 10, "sec_work", "unpin"],
    ["unpins and moves to another section", 10, "sec_personal", "atomic"],
  ] as const)("%s", async (_name, pinnedAt, sectionId, route) => {
    const { queryClient, wrapper } = createQueryClientTestHarness();
    const thread = makeThreadListEntry({ pinnedAt, sectionId: "sec_work" });
    vi.mocked(sdk.threads.unpinAndMove).mockResolvedValue(
      makeThreadResponse({ pinnedAt: null, sectionId }),
    );
    vi.mocked(sdk.threads.update).mockResolvedValue(
      makeThreadResponse({ pinnedAt: null, sectionId }),
    );
    const { result } = renderHook(() => useMoveThreadToSection(), { wrapper });

    act(() => result.current({ thread, sectionId }));

    await waitFor(() => expect(queryClient.isMutating()).toBe(0));
    expect(sdk.threads.update).toHaveBeenCalledTimes(
      route === "update" ? 1 : 0,
    );
    expect(sdk.threads.unpin).toHaveBeenCalledTimes(route === "unpin" ? 1 : 0);
    // HI-3 (TG8): a pinned thread moving to another section takes the one
    // atomic mutation, not an unpin -> update pair.
    expect(sdk.threads.unpinAndMove).toHaveBeenCalledTimes(
      route === "atomic" ? 1 : 0,
    );
    if (route === "atomic") {
      expect(sdk.threads.unpinAndMove).toHaveBeenCalledWith({
        threadId: thread.id,
        sectionId,
      });
    }
  });

  it("rolls back consistently when the atomic unpin-and-move fails (8.6)", async () => {
    const { queryClient, wrapper } = createQueryClientTestHarness();
    const thread = makeThreadListEntry({ pinnedAt: 10, sectionId: "sec_work" });
    const threadListKey = threadListQueryKey({
      archived: false,
      projectId: "project-1",
    });
    queryClient.setQueryData(threadListKey, [thread]);
    queryClient.setQueryData(
      sidebarNavigationQueryKey(),
      makeSidebarNavigation([thread]),
    );
    vi.mocked(sdk.threads.unpinAndMove).mockRejectedValue(
      new Error("request failed"),
    );
    const { result } = renderHook(() => useUnpinAndMoveThread(), { wrapper });

    act(() => {
      result.current.mutate({ id: thread.id, sectionId: "sec_personal" });
    });

    await waitFor(() => expect(queryClient.isMutating()).toBe(0));
    // Nothing committed server-side, so the rollback must land on the
    // original pinned state in the original section.
    const entries = queryClient.getQueryData<ThreadListEntry[]>(threadListKey);
    expect(entries?.[0]?.pinnedAt).toBe(10);
    expect(entries?.[0]?.sectionId).toBe("sec_work");
  });

  it("tolerates a duplicate unpin-and-move click (8.6)", async () => {
    const { queryClient, wrapper } = createQueryClientTestHarness();
    const thread = makeThreadListEntry({ pinnedAt: 10, sectionId: "sec_work" });
    const threadListKey = threadListQueryKey({
      archived: false,
      projectId: "project-1",
    });
    queryClient.setQueryData(threadListKey, [thread]);
    vi.mocked(sdk.threads.unpinAndMove).mockResolvedValue(
      makeThreadResponse({ pinnedAt: null, sectionId: "sec_personal" }),
    );
    const { result } = renderHook(() => useUnpinAndMoveThread(), { wrapper });

    act(() => {
      result.current.mutate({ id: thread.id, sectionId: "sec_personal" });
      result.current.mutate({ id: thread.id, sectionId: "sec_personal" });
    });

    await waitFor(() => expect(queryClient.isMutating()).toBe(0));
    expect(sdk.threads.unpinAndMove).toHaveBeenCalledTimes(2);
    // The second application is idempotent: the same target section, the
    // same unpinned end state.
    const entries = queryClient.getQueryData<ThreadListEntry[]>(threadListKey);
    const moved = entries?.find((entry) => entry.id === thread.id);
    expect(moved?.pinnedAt ?? null).toBeNull();
    expect(moved?.sectionId).toBe("sec_personal");
  });

  it("optimistically renames a thread while the update request is pending", async () => {
    const { queryClient, wrapper } = createQueryClientTestHarness();
    const threadId = "thread-1";
    const thread = makeThreadWithRuntime({
      id: threadId,
      title: "Old title",
    });
    const listEntry = makeThreadListEntry({
      id: threadId,
      title: "Old title",
    });
    const threadListKey = threadListQueryKey({
      archived: false,
      projectId: "project-1",
    });
    let resolveUpdate: (thread: ThreadResponse) => void = () => {};

    queryClient.setQueryData(threadQueryKey(threadId), thread);
    queryClient.setQueryData(threadListKey, [listEntry]);
    queryClient.setQueryData(
      sidebarNavigationQueryKey(),
      makeSidebarNavigation([listEntry]),
    );
    vi.mocked(sdk.threads.update).mockImplementation(
      () =>
        new Promise<ThreadResponse>((resolve) => {
          resolveUpdate = resolve;
        }),
    );

    const { result } = renderHook(() => useUpdateThread(), { wrapper });

    act(() => {
      result.current.mutate({ id: threadId, title: "New title" });
    });

    await waitFor(() => {
      expect(
        queryClient.getQueryData<ThreadWithRuntime>(threadQueryKey(threadId))
          ?.title,
      ).toBe("New title");
    });
    expect(
      queryClient.getQueryData<ThreadListEntry[]>(threadListKey)?.[0]?.title,
    ).toBe("New title");
    expect(
      queryClient.getQueryData<SidebarBootstrapResponse>(
        sidebarNavigationQueryKey(),
      )?.projects[0]?.threads[0]?.title,
    ).toBe("New title");
    expect(sdk.threads.update).toHaveBeenCalledWith({
      threadId,
      title: "New title",
    });

    act(() => {
      resolveUpdate(
        makeThreadResponse({
          id: threadId,
          title: "New title",
          updatedAt: 2,
        }),
      );
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
  });

  it("optimistically moves a thread between sections while the update request is pending", async () => {
    const { queryClient, wrapper } = createQueryClientTestHarness();
    const threadId = "thread-1";
    const thread = makeThreadWithRuntime({
      id: threadId,
      sectionId: "sec_work",
    });
    const listEntry = makeThreadListEntry({
      id: threadId,
      sectionId: "sec_work",
    });
    const threadListKey = threadListQueryKey({
      archived: false,
      projectId: "project-1",
    });
    let resolveUpdate: (thread: ThreadResponse) => void = () => {};

    queryClient.setQueryData(threadQueryKey(threadId), thread);
    queryClient.setQueryData(threadListKey, [listEntry]);
    queryClient.setQueryData(
      sidebarNavigationQueryKey(),
      makeSidebarNavigation([listEntry]),
    );
    vi.mocked(sdk.threads.update).mockImplementation(
      () =>
        new Promise<ThreadResponse>((resolve) => {
          resolveUpdate = resolve;
        }),
    );

    const { result } = renderHook(() => useUpdateThread(), { wrapper });

    act(() => {
      result.current.mutate({ id: threadId, sectionId: "sec_personal" });
    });

    await waitFor(() => {
      expect(
        queryClient.getQueryData<ThreadWithRuntime>(threadQueryKey(threadId))
          ?.sectionId,
      ).toBe("sec_personal");
    });
    expect(
      queryClient.getQueryData<ThreadListEntry[]>(threadListKey)?.[0]
        ?.sectionId,
    ).toBe("sec_personal");
    expect(
      queryClient.getQueryData<SidebarBootstrapResponse>(
        sidebarNavigationQueryKey(),
      )?.projects[0]?.threads[0]?.sectionId,
    ).toBe("sec_personal");
    expect(sdk.threads.update).toHaveBeenCalledWith({
      threadId,
      sectionId: "sec_personal",
    });

    act(() => {
      resolveUpdate(
        makeThreadResponse({
          id: threadId,
          sectionId: "sec_personal",
          updatedAt: 2,
        }),
      );
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
  });

  it("optimistically applies the atomic unpin-and-move and settles on the response", async () => {
    const { queryClient, wrapper } = createQueryClientTestHarness();
    const threadId = "thread-1";
    const destinationSectionId = "sec_personal";
    const thread = makeThreadWithRuntime({
      id: threadId,
      sectionId: null,
      pinnedAt: 10,
    });
    const listEntry = makeThreadListEntry({
      id: threadId,
      sectionId: null,
      pinnedAt: 10,
      pinSortKey: "a0",
    });
    const threadListKey = threadListQueryKey({
      archived: false,
      projectId: "project-1",
    });
    let resolveMove: (thread: ThreadResponse) => void = () => {};

    queryClient.setQueryData(threadQueryKey(threadId), thread);
    queryClient.setQueryData(threadListKey, [listEntry]);
    queryClient.setQueryData(
      sidebarNavigationQueryKey(),
      makeSidebarNavigation([listEntry]),
    );
    vi.mocked(sdk.threads.unpinAndMove).mockImplementation(
      () =>
        new Promise<ThreadResponse>((resolve) => {
          resolveMove = resolve;
        }),
    );

    const { result } = renderHook(() => useUnpinAndMoveThread(), { wrapper });

    act(() => {
      result.current.mutate({ id: threadId, sectionId: destinationSectionId });
    });

    await waitFor(() => {
      expect(
        queryClient.getQueryData<ThreadListEntry[]>(threadListKey)?.[0],
      ).toMatchObject({
        sectionId: destinationSectionId,
        pinnedAt: null,
        pinSortKey: null,
      });
    });
    expect(
      queryClient.getQueryData<ThreadWithRuntime>(threadQueryKey(threadId)),
    ).toMatchObject({
      sectionId: destinationSectionId,
      pinnedAt: null,
    });
    // HI-3 (TG8): a single atomic call replaces the serialized unpin ->
    // update pair, so there is no window in which the backend is unpinned
    // but not yet moved.
    expect(sdk.threads.unpinAndMove).toHaveBeenCalledWith({
      threadId,
      sectionId: destinationSectionId,
    });
    expect(sdk.threads.unpin).not.toHaveBeenCalled();
    expect(sdk.threads.update).not.toHaveBeenCalled();

    act(() => {
      resolveMove(
        makeThreadResponse({
          id: threadId,
          sectionId: destinationSectionId,
          pinnedAt: null,
          updatedAt: 2,
        }),
      );
    });

    await waitFor(() => {
      expect(
        queryClient.getQueryData<ThreadListEntry[]>(threadListKey)?.[0],
      ).toMatchObject({ sectionId: destinationSectionId, pinnedAt: null });
    });
  });
});
