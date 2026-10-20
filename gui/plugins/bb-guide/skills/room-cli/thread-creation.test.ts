import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8").replace(/\s+/g, " ");
const sentences = (text: string) => text.split(/(?<=[.!?])\s+(?=[A-Z`(])/);

const docs = {
  guide: sentences(read("./references/thread-creation.md")),
  skill: sentences(read("./SKILL.md")),
  index: sentences(read("./references/command-index.md")),
};
const all = Object.values(docs).flat();
const parentSandbox = /parent'?s sandbox|shares? (their|its|the) parent'?s\b/i;
const noAnswer = /(doesn't|does not|didn't|did not) answer/i;
const find = (list: string[], ...patterns: RegExp[]) =>
  list.filter((sentence) =>
    patterns.every((pattern) => pattern.test(sentence)),
  );

describe("Cloud child sandbox in the bundled room-cli guide", () => {
  it("describes the managed default: own sandbox, a copy of the parent's code, its own branch", () => {
    for (const list of [docs.guide, docs.skill]) {
      expect(
        find(
          list,
          /per-thread Cloud sandboxes/i,
          /Cloud parent/i,
          /own sandbox/i,
          /cop(y|ies) of the parent'?s code/i,
        ),
      ).not.toEqual([]);
    }
    expect(
      find(
        docs.guide,
        /commits and uncommitted changes/i,
        /on its own branch/i,
      ),
    ).not.toEqual([]);
  });

  it("says the copy is not kept in sync with the parent's later edits", () => {
    const fresh = find(docs.guide, /later edits/i);
    expect(fresh).not.toEqual([]);
    for (const sentence of fresh) {
      expect(sentence).toMatch(
        /(doesn't|does not) see the parent'?s later edits(?=[;,.])/i,
      );
      expect(sentence).not.toMatch(
        /\b(mirror|sync|live|until|unless|except|before they)/i,
      );
    }
  });

  it("puts a child in the parent's sandbox only with --shared-sandbox or when the app does not answer", () => {
    for (const sentence of find(
      all,
      /\b(child|children|subagents?)\b/i,
      parentSandbox,
    )) {
      expect(/--shared-sandbox/.test(sentence) || noAnswer.test(sentence)).toBe(
        true,
      );
      expect(sentence).not.toMatch(/\b(by default|normally|usually)\b/i);
      expect(sentence).not.toMatch(
        /(without|omit\w*|unless)[^.;]*--shared-sandbox/i,
      );
    }
    expect(
      find(
        docs.guide,
        /Cloud agent|Core/i,
        /parent'?s sandbox[^.]*\bonly if\b[^.]*--shared-sandbox/i,
        noAnswer,
      ),
    ).not.toEqual([]);
    expect(find(all, /--shared-sandbox[^.;]*own sandbox/i)).toEqual([]);
  });

  it("treats an app error as a failed spawn, not a fallback", () => {
    const errors = find(docs.guide, /\berror\b/i, /\bapp\b/i, /\bspawn\b/i);
    expect(errors).not.toEqual([]);
    for (const sentence of errors) {
      expect(sentence).toMatch(/\bfails\b/i);
      expect(sentence).not.toMatch(
        /parent'?s sandbox|retr(y|ies)|runs? (it|the child)/i,
      );
    }
  });

  it("says the parent hears about each finished child turn", () => {
    const notices = find(all, /messages the parent/i);
    expect(notices).not.toEqual([]);
    for (const sentence of notices) {
      expect(sentence).toMatch(/each time the child finishes a turn/i);
    }
  });

  it("routes vm --thread to a subagent's own sandbox unless it shares its parent's", () => {
    const vm = find(docs.index, /--thread ID/, /subagent/i);
    expect(vm).not.toEqual([]);
    for (const sentence of vm) expect(sentence).toMatch(/its own sandbox/i);
  });
});
