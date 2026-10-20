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
  it("never says a child in its own sandbox keeps receiving the parent's future changes", () => {
    const future =
      /\b(future|later|new|every|subsequent|ongoing)\b[^.;]*\b(commits?|edits?|changes?|files?|saves?)\b/i;
    for (const sentence of find(
      all,
      /\b(child|children|subagents?)\b/i,
      future,
    )) {
      if (
        /\bshar(e|es|ed|ing)\b[^.;]*\bparent'?s (sandbox|folder)\b|--shared-sandbox/i.test(
          sentence,
        )
      )
        continue;
      expect(sentence).toMatch(
        /\b(doesn't|does not|don't|do not|never)\s+(see|get|receive)s?\b[^.;]*\b(future|later|new|every|subsequent|ongoing)\b/i,
      );
    }
  });

  it("qualifies a Local parent's Cloud child sandbox the same way", () => {
    const local = find(all, /Local parent'?s Cloud child/i, /own sandbox/i);
    expect(local).not.toEqual([]);
    for (const sentence of local) {
      expect(sentence).toMatch(/per-thread Cloud sandboxes/i);
    }
  });

  it("says a Local parent's Cloud child starts from pushed GitHub work, or a small project's current files", () => {
    const github = find(all, /pushed GitHub branch/i);
    expect(github.length).toBeGreaterThanOrEqual(2);
    for (const sentence of github) {
      expect(sentence).toMatch(
        /pushed GitHub branch,? without uncommitted work/i,
      );
    }
    const small = find(all, /small project that isn't on GitHub/i);
    expect(small.length).toBeGreaterThanOrEqual(2);
    for (const sentence of small) {
      expect(sentence).toMatch(/copied from its folder on the Mac/i);
      expect(sentence).toMatch(/as the files are now/i);
    }
    for (const sentence of find(all, /uncommitted work/i)) {
      expect(sentence).toMatch(/without uncommitted work/i);
      expect(sentence).not.toMatch(/\binclud\w*/i);
    }
    expect(find(all, /starts? from GitHub, not local files/i)).toEqual([]);
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
    const fresh = find(docs.guide, /later edits/i).filter(
      (sentence) =>
        !/\bshar(e|es|ed|ing)\b[^.;]*\bparent'?s (sandbox|folder)\b|--shared-sandbox/i.test(
          sentence,
        ),
    );
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

  it("keeps Cloud forks to Claude Code and Codex on a core that supports them", () => {
    expect(find(docs.guide, /Cloud forks/i)).not.toEqual([]);
    expect(find(docs.skill, /Cloud forks/i)).not.toEqual([]);
    for (const sentence of find(all, /Cloud forks?/i)) {
      expect(sentence).toMatch(/Claude Code and Codex/);
      expect(sentence).toMatch(/when the connected core supports them/i);
      expect(sentence).not.toMatch(
        /\b(every|any|all|regardless|even when|refuse\w*|lacks?|unsupported|not supported)\b/i,
      );
    }
    for (const sentence of find(all, /\bCloud\b/, /\bforks?\b/i)) {
      expect(sentence).not.toMatch(/\b(no|not|without)\b[^.;]*\bforks?\b/i);
    }
    for (const sentence of find(all, /\bforks?\b/i, /\bcores?\b/i)) {
      expect(sentence).not.toMatch(
        /\b(refuse\w*|never|even when|regardless|lacks?)\b/i,
      );
    }
  });

  it("says the website carries a started child's controls only when its parent has a sandbox of its own", () => {
    expect(
      find(docs.skill, /through the GUI backend while it is running/i),
    ).toEqual([]);
    const relay = find(
      docs.skill,
      /\bwebsite\b/i,
      /\b(tell|stop|archive)\b/,
      /turn reports?/i,
    );
    expect(relay).not.toEqual([]);
    for (const sentence of relay) {
      expect(sentence).toMatch(/parent has a sandbox of its own/i);
      expect(sentence).toMatch(/app is closed|Mac is off/i);
      expect(sentence).toMatch(
        /shares? another thread'?s sandbox[^.]*\bapp\b/i,
      );
      expect(sentence).not.toMatch(
        /website (never|doesn't|does not|won't|cannot|can't)\b/i,
      );
    }
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
