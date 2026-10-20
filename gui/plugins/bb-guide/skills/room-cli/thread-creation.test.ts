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
  it("never says a child keeps receiving the parent's future changes", () => {
    for (const sentence of find(
      all,
      /\b(child|children|subagents?)\b/i,
      /\b(future|later|new|every|subsequent|ongoing)\b[^.;]*\b(commits?|edits?|changes?|files?|saves?)\b/i,
    )) {
      expect(sentence).toMatch(/\b(doesn't|does not|don't|never|not)\b/i);
    }
  });

  it("qualifies a Local parent's Cloud child sandbox the same way", () => {
    const local = find(all, /Local parent'?s Cloud child/i, /own sandbox/i);
    expect(local).not.toEqual([]);
    for (const sentence of local) {
      expect(sentence).toMatch(/per-thread Cloud sandboxes/i);
    }
  });

  it("says a Local parent's Cloud child starts from the project, not the parent's uncommitted work", () => {
    const start = find(all, /\bstarts? from\b/i, /GitHub/);
    expect(start).not.toEqual([]);
    for (const sentence of start) {
      expect(sentence).not.toMatch(/not local files/i);
      expect(sentence).toMatch(/small project/i);
      expect(sentence).toMatch(/uncommitted/i);
    }
  });

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
        /cop(y|ies) of the parent'?s code \(commits and uncommitted changes\)/i,
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
        /\b(mirror|sync|live|until|unless|except|before they|automatic\w*|subsequent|copied to)/i,
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

  it("never presents leaving out --shared-sandbox as the way to share", () => {
    for (const sentence of find(all, /--shared-sandbox/)) {
      expect(sentence).not.toMatch(
        /\b(without|omit\w*|unless|no)\W+`?--shared-sandbox/i,
      );
    }
  });

  it("does not call Cloud forks disabled outright", () => {
    for (const sentence of find(
      all,
      /\bforks?\b/i,
      /\bnot (enabled|supported)\b|\bunsupported\b/i,
    )) {
      expect(sentence).not.toMatch(
        /\bCloud forks?\b[^.;]*\bnot enabled\b|\bForks are not enabled\b/i,
      );
    }
    expect(
      find(docs.guide, /Cloud forks/i, /Claude Code/, /Codex/),
    ).not.toEqual([]);
    expect(
      find(docs.skill, /Cloud forks/i, /Claude Code/, /Codex/),
    ).not.toEqual([]);
  });

  it("says a Cloud child's controls and turn reports reach it through the website once started", () => {
    expect(
      find(docs.skill, /through the GUI backend while it is running/i),
    ).toEqual([]);
    expect(
      find(
        docs.skill,
        /\bwebsite\b/i,
        /\b(tell|stop|archive)\b/,
        /turn reports?/i,
        /app is closed|Mac is off/i,
      ),
    ).not.toEqual([]);
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
      expect(sentence).not.toMatch(
        /finishes a turn,? (but|except|unless)|only (reports?|messages?|tells?|the first)|first (finished )?turn|\bonce\b/i,
      );
    }
  });

  it("routes vm --thread to a subagent's own sandbox, or its parent's only when it shares", () => {
    const vm = find(docs.index, /--thread ID/, /subagent/i);
    expect(vm).not.toEqual([]);
    for (const sentence of vm) {
      expect(sentence).toMatch(
        /its own sandbox, or its parent'?s when it shares/i,
      );
      expect(sentence).toMatch(/--shared-sandbox/);
      expect(sentence).toMatch(noAnswer);
      expect(sentence).not.toMatch(/\berror\b|\b(still|even)\b/i);
    }
  });
});
