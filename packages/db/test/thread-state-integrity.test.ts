import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import fc from "fast-check";
import { createConnection, type DbConnection } from "../src/connection.js";
import { migrate } from "../src/migrate.js";
import {
  createThread,
  pinThread,
  threadSearchSegments,
  threads,
  unpinAndMoveThread,
  updateThread,
  type DbNotifier,
} from "../src/index.js";
import { projects, threadSections } from "../src/schema.js";

/**
 * SP-4 state integrity (HI-3, ME-2 / TG8.5, 8.8): title and search-segment
 * state commit in one transaction, and pin + section membership commit in
 * one transaction. Injected failures at the database layer must roll back
 * the whole mutation — never leave title and search index divergent, or
 * pin and section half-applied.
 */

const noopNotifier: DbNotifier = {
  notifyThread: () => {},
  notifyProject: () => {},
  notifyEnvironment: () => {},
  notifyHost: () => {},
  notifySystem: () => {},
};

function createTestDb(): DbConnection {
  const db = createConnection(":memory:");
  migrate(db);
  return db;
}

function seedProjectAndThread(
  db: DbConnection,
  args: { title: string | null; sectionId?: string | null },
): string {
  const now = Date.now();
  db.insert(projects)
    .values({
      id: "project-1",
      name: "Project",
      createdAt: now,
      updatedAt: now,
    })
    .run();
  db.insert(threadSections)
    .values([
      { id: "sec_work", name: "Work", createdAt: now, updatedAt: now },
      { id: "sec_personal", name: "Personal", createdAt: now, updatedAt: now },
    ])
    .run();
  const thread = createThread(db, noopNotifier, {
    projectId: "project-1",
    providerId: "codex",
    title: args.title,
    ...(args.sectionId !== undefined ? { sectionId: args.sectionId } : {}),
  });
  return thread.id;
}

function titleSegments(
  db: DbConnection,
  threadId: string,
): {
  title: string | null;
  titleFallback: string | null;
} {
  const rows = db
    .select()
    .from(threadSearchSegments)
    .where(eq(threadSearchSegments.threadId, threadId))
    .all();
  const byKind = (kind: string): string | null =>
    rows.find((row) => row.sourceKind === kind)?.text ?? null;
  return { title: byKind("title"), titleFallback: byKind("title_fallback") };
}

function getTitle(
  db: DbConnection,
  threadId: string,
): {
  title: string | null;
  titleFallback: string | null;
  sectionId: string | null;
  pinnedAt: number | null;
} {
  const row = db.select().from(threads).where(eq(threads.id, threadId)).get();
  if (!row) {
    throw new Error("Expected thread row");
  }
  return {
    title: row.title,
    titleFallback: row.titleFallback,
    sectionId: row.sectionId,
    pinnedAt: row.pinnedAt,
  };
}

describe("SP-4 title/search-segment atomicity (ME-2, TG8.5)", () => {
  it("rolls the title back when the search-segment write fails", () => {
    const db = createTestDb();
    const threadId = seedProjectAndThread(db, { title: "Before" });

    // Real injected failure at the database layer: abort the segment write.
    db.$client.exec(
      "CREATE TRIGGER fail_segments BEFORE INSERT ON thread_search_segments " +
        "BEGIN SELECT RAISE(ABORT, 'injected segment failure'); END;",
    );

    expect(() =>
      updateThread(db, noopNotifier, threadId, { title: "After" }),
    ).toThrow();

    expect(getTitle(db, threadId).title).toBe("Before");
    expect(titleSegments(db, threadId)).toEqual({
      title: "Before",
      titleFallback: null,
    });

    db.$client.exec("DROP TRIGGER fail_segments");
    const updated = updateThread(db, noopNotifier, threadId, {
      title: "After",
    });
    expect(updated?.title).toBe("After");
    expect(titleSegments(db, threadId)).toEqual({
      title: "After",
      titleFallback: null,
    });
  });

  it("rolls the search segments back when the row update fails", () => {
    const db = createTestDb();
    const threadId = seedProjectAndThread(db, { title: "Before" });

    db.$client.exec(
      "CREATE TRIGGER fail_thread_update BEFORE UPDATE ON threads " +
        "BEGIN SELECT RAISE(ABORT, 'injected thread failure'); END;",
    );

    expect(() =>
      updateThread(db, noopNotifier, threadId, { title: "After" }),
    ).toThrow();

    expect(getTitle(db, threadId).title).toBe("Before");
    expect(titleSegments(db, threadId)).toEqual({
      title: "Before",
      titleFallback: null,
    });
  });
});

describe("SP-4 pin/section atomicity (HI-3, TG8.5)", () => {
  it("rolls pin and section back together when the update fails", () => {
    const db = createTestDb();
    const threadId = seedProjectAndThread(db, {
      title: "Pinned thread",
      sectionId: "sec_work",
    });
    pinThread(db, noopNotifier, { threadId });
    expect(getTitle(db, threadId).pinnedAt).not.toBeNull();

    db.$client.exec(
      "CREATE TRIGGER fail_thread_update BEFORE UPDATE ON threads " +
        "BEGIN SELECT RAISE(ABORT, 'injected move failure'); END;",
    );

    expect(() =>
      unpinAndMoveThread(db, noopNotifier, {
        threadId,
        sectionId: "sec_personal",
      }),
    ).toThrow();

    const before = getTitle(db, threadId);
    expect(before.pinnedAt).not.toBeNull();
    expect(before.sectionId).toBe("sec_work");

    db.$client.exec("DROP TRIGGER fail_thread_update");
    const moved = unpinAndMoveThread(db, noopNotifier, {
      threadId,
      sectionId: "sec_personal",
    });
    expect(moved?.pinnedAt ?? null).toBeNull();
    expect(moved?.sectionId).toBe("sec_personal");
  });
});

describe("SP-4 stateful property (TG8.8)", () => {
  it("keeps title, segments, pin, and section consistent across generated operation sequences", () => {
    const db = createTestDb();
    const threadId = seedProjectAndThread(db, { title: "Seed" });
    pinThread(db, noopNotifier, { threadId });

    let segmentFailures = 0;
    let threadFailures = 0;
    db.$client.exec(
      "CREATE TABLE injection (kind TEXT NOT NULL);" +
        "CREATE TRIGGER fail_segments_cond BEFORE INSERT ON thread_search_segments " +
        "WHEN EXISTS (SELECT 1 FROM injection WHERE kind = 'segments') " +
        "BEGIN SELECT RAISE(ABORT, 'injected segment failure'); END;" +
        "CREATE TRIGGER fail_threads_cond BEFORE UPDATE ON threads " +
        "WHEN EXISTS (SELECT 1 FROM injection WHERE kind = 'threads') " +
        "BEGIN SELECT RAISE(ABORT, 'injected thread failure'); END;",
    );
    const setInjection = (kind: string | null): void => {
      db.$client.exec("DELETE FROM injection");
      if (kind !== null) {
        db.$client.prepare("INSERT INTO injection (kind) VALUES (?)").run(kind);
      }
    };

    const titles = ["Alpha", "Beta", "Gamma", "Delta"];
    const sections = ["sec_a", "sec_b", null];

    const opArb = fc.oneof(
      fc
        .record({
          kind: fc.constant("rename"),
          title: fc.constantFrom(...titles),
          fail: fc.boolean(),
        })
        .map((op) => op),
      fc
        .record({
          kind: fc.constant("move"),
          sectionId: fc.constantFrom(...sections),
          fail: fc.boolean(),
        })
        .map((op) => op),
    );

    fc.assert(
      fc.property(
        fc.array(opArb, { minLength: 1, maxLength: 10 }),
        (operations) => {
          for (const op of operations) {
            const before = getTitle(db, threadId);
            const segmentsBefore = titleSegments(db, threadId);
            let failed = false;
            if (op.kind === "rename") {
              setInjection(op.fail ? "segments" : null);
              try {
                updateThread(db, noopNotifier, threadId, { title: op.title });
              } catch {
                failed = true;
              }
            } else {
              setInjection(op.fail ? "threads" : null);
              try {
                unpinAndMoveThread(db, noopNotifier, {
                  threadId,
                  sectionId: op.sectionId,
                });
              } catch {
                failed = true;
              }
            }
            setInjection(null);

            const after = getTitle(db, threadId);
            const segmentsAfter = titleSegments(db, threadId);

            // Invariant 1: title and search segments never diverge (a
            // null title is stored as an empty segment text).
            expect(segmentsAfter.title ?? "").toBe(after.title ?? "");
            expect(segmentsAfter.titleFallback ?? "").toBe(
              after.titleFallback ?? "",
            );

            if (failed) {
              // Invariant 2: a failed mutation commits neither half.
              expect(after.title).toBe(before.title);
              expect(after.pinnedAt).toBe(before.pinnedAt);
              expect(after.sectionId).toBe(before.sectionId);
              expect(segmentsAfter).toEqual(segmentsBefore);
            } else if (op.kind === "rename") {
              expect(after.title).toBe(op.title);
            } else {
              // Moves unpin: the atomic mutation's defined outcome.
              expect(after.pinnedAt ?? null).toBeNull();
              expect(after.sectionId).toBe(op.sectionId);
            }
            segmentFailures += failed && op.kind === "rename" ? 1 : 0;
            threadFailures += failed && op.kind === "move" ? 1 : 0;
          }
        },
      ),
      { numRuns: 60 },
    );
    // The property must actually exercise both failure injections.
    expect(segmentFailures).toBeGreaterThan(0);
    expect(threadFailures).toBeGreaterThan(0);
  });
});
