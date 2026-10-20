import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8").replace(/\s+/g, " ");
const sentences = (text: string) => text.split(/(?<=[.!?])\s+(?=[A-Z`(])/);

const guide = read("./references/thread-creation.md");
const skill = read("./SKILL.md");
const guideSentences = sentences(guide);
const parentSandbox = /parent'?s sandbox/i;
const explicitShare = /--shared-sandbox/;
const noAnswer = /(doesn't|does not|didn't|did not) answer/i;
const conditional = /\b(if|only|unless|instead)\b/i;
const find = (...patterns: RegExp[]) =>
  guideSentences.filter((sentence) =>
    patterns.every((pattern) => pattern.test(sentence)),
  );

describe("Cloud child sandbox in the thread-creation guide", () => {
  it("mentions the parent's sandbox only as the --shared-sandbox or no-answer case", () => {
    expect(
      find(parentSandbox).filter(
        (sentence) =>
          !(
            conditional.test(sentence) &&
            (explicitShare.test(sentence) || noAnswer.test(sentence))
          ),
      ),
    ).toEqual([]);
    expect(find(/\b(by default|normally|usually)\b/i, parentSandbox)).toEqual(
      [],
    );
  });

  it("says a Cloud parent's child gets its own sandbox with a copy of the parent's code", () => {
    expect(
      find(
        /Cloud parent/i,
        /own sandbox/i,
        /cop(y|ies) of the parent'?s code/i,
      ),
    ).not.toEqual([]);
  });

  it("says the child does not see the parent's later edits", () => {
    expect(guide).toMatch(
      /(doesn't|does not) see (the parent'?s )?later edits/i,
    );
  });

  it("scopes --shared-sandbox to a Cloud agent's own room-cli", () => {
    expect(
      find(explicitShare, /Cloud agent|Core/i, parentSandbox, conditional),
    ).not.toEqual([]);
  });

  it("falls back to the parent's sandbox only when the app does not answer", () => {
    expect(find(noAnswer, parentSandbox, conditional)).not.toEqual([]);
  });

  it("says an error from the app fails the spawn instead of falling back", () => {
    expect(
      find(
        /\berror\b/i,
        /\bapp\b/i,
        /\b(child|spawn)\b/i,
        /\b(fails|is refused|(doesn't|does not|never) fall back|instead of falling back)\b/i,
      ),
    ).not.toEqual([]);
  });

  it("agrees with its parent skill that a Cloud parent's child gets its own sandbox", () => {
    const ownSandbox = /Cloud parent[^.]*own sandbox/i;
    expect(skill).toMatch(ownSandbox);
    expect(guide).toMatch(ownSandbox);
  });
});
