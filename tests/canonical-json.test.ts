import { describe, expect, it } from "vitest";
import { canonicalJson } from "../src/domain/index.js";

describe("canonical JSON", () => {
  it("orders keys with locale-independent UTF-16 comparison at every depth", () => {
    expect(
      canonicalJson({
        "\uE000": 5,
        "😀": 4,
        é: 3,
        a: { é: 2, Z: 1 },
        Z: 0,
      }),
    ).toBe('{"Z":0,"a":{"Z":1,"é":2},"é":3,"😀":4,"":5}');
  });

  it("preserves array order while canonicalizing nested objects", () => {
    expect(
      canonicalJson([
        { b: 2, a: 1 },
        { d: 4, c: 3 },
      ]),
    ).toBe('[{"a":1,"b":2},{"c":3,"d":4}]');
  });
});
