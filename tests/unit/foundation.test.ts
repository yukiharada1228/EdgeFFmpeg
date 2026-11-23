import { describe, it, expect } from "vitest";
import { rational, rescale } from "@edge-ffmpeg/avutil";
import { parseArgv } from "@edge-ffmpeg/cli";
describe("integer time", () => {
  it("normalizes signs and zero", () => {
    expect(rational(6n, -8n)).toEqual({ num: -3n, den: 4n });
    expect(rational(0n, 9n)).toEqual({ num: 0n, den: 1n });
    expect(() => rational(1n, 0n)).toThrow();
  });
  it("preserves timestamps beyond number precision", () => {
    const n = 9007199254740993n;
    expect(rescale(n, rational(1n, 90000n), rational(1n, 90000n))).toBe(n);
    expect(rescale(-3n, rational(1n, 2n), rational(1n, 1n))).toBe(-2n);
    expect(rescale(-3n, rational(1n, 2n), rational(1n, 1n), "zero")).toBe(-1n);
  });
});
describe("CLI file scopes", () => {
  it("separates input, output and global options without losing order", () => {
    const parsed = parseArgv(["-ss", "2", "-i", "a.mp4", "-c:v", "copy", "b.mp4", "-y", "-an", "c.mp4"]);
    expect(parsed.inputs[0]?.options).toEqual([{ name: "-ss", value: "2" }]);
    expect(parsed.outputs.map(x => x.options)).toEqual([[{ name: "-c:v", value: "copy" }], [{ name: "-an", value: null }]]);
    expect(parsed.global).toEqual([{ name: "-y", value: null }]);
  });
  it("rejects unsupported and incomplete requests", () => {
    for (const args of [["-unknown"], ["-i"], ["-c:v"], ["-an"]]) expect(() => parseArgv(args)).toThrow();
  });
});
