import { describe, expect, it } from "vitest";

import { auditFile, classify, summarise, type AuditFileInput } from "../../packages/audit/src/index.js";

function audit(text: string, kind: AuditFileInput["kind"] = "scene") {
  return auditFile({ file: "engine/scenes/probe.js", text, kind });
}

function rules(text: string, kind: AuditFileInput["kind"] = "scene"): string[] {
  return audit(text, kind).map((f) => f.rule);
}

function errors(text: string, kind: AuditFileInput["kind"] = "scene"): string[] {
  return audit(text, kind)
    .filter((f) => f.severity === "error")
    .map((f) => f.rule);
}

/**
 * The point of these tests is not that the rules exist, but that they cannot be evaded by the
 * rewrite a competent author would naturally write. Every prior-art project scanned for
 * `Math.random(` as text; a one-line alias passes that scan and produces the same bug.
 */
describe("audit — determinism rules catch what a textual scan misses", () => {
  it("flags a direct Math.random() call", () => {
    expect(errors("const x = Math.random();")).toContain("determinism.bannedApi");
  });

  it("flags a direct Date.now() call", () => {
    expect(errors("const t = Date.now();")).toContain("determinism.bannedApi");
  });

  it("flags an ALIASED Math.random, which a regex scan cannot see", () => {
    const src = `const r = Math.random;\nconst x = r();`;
    const found = audit(src);
    expect(found.map((f) => f.rule)).toContain("determinism.bannedApi");
    expect(found.some((f) => f.hint.includes("alias"))).toBe(true);
  });

  it("flags an aliased Date.now stored for later", () => {
    expect(rules("const clock = Date.now;")).toContain("determinism.bannedGlobal");
  });

  it("flags access through globalThis, which a regex on `Date.` would miss", () => {
    const src = `const t = globalThis.Date.now();`;
    expect(errors(src)).toContain("determinism.bannedApi");
  });

  it("flags access through window", () => {
    expect(errors("const p = window.performance.now();")).toContain("determinism.bannedApi");
  });

  it("flags a bare performance reference", () => {
    expect(rules("const p = performance;")).toContain("determinism.bannedGlobal");
  });

  it("flags timers, which make a frame order-dependent", () => {
    expect(errors("setTimeout(() => {}, 16);")).toContain("determinism.bannedGlobal");
    expect(errors("requestAnimationFrame(draw);")).toContain("determinism.bannedGlobal");
  });

  it("flags crypto entropy", () => {
    expect(errors("const b = crypto.getRandomValues(new Uint8Array(4));")).toContain("determinism.bannedApi");
  });

  it("does NOT flag the seeded generators, which are the intended replacement", () => {
    const src = `import { hash1, mulberry32, rng } from "@cvpw/kernel";
const a = hash1("spark", 3);
const b = mulberry32(7);
const c = rng("shot");
const d = Math.floor(a * 10);
const e = Math.sin(b() * 6.28);`;
    expect(errors(src)).toEqual([]);
  });

  it("does NOT flag a legitimate numeric literal of 1920 in a comment or a string", () => {
    const src = `const note = "rendered at 1920 wide";\n// 1080 is the design height\nconst x = 1;`;
    expect(rules(src)).not.toContain("layout.rawDimension");
  });

  it("flags a raw design-space literal in code", () => {
    const src = `const halfW = 1920 / 2;`;
    expect(rules(src)).toContain("layout.rawDimension");
  });
});

describe("audit — layout and time warnings", () => {
  it("warns on a bare numeric time on a time-like key", () => {
    const src = `const shot = { id: "s01", at: 4.02, scene: "beat" };`;
    const found = audit(src);
    expect(found.map((f) => f.rule)).toContain("time.absoluteLiteral");
    // It is a warning by default, because a stub project has no timebase yet.
    expect(found.find((f) => f.rule === "time.absoluteLiteral")?.severity).toBe("warning");
  });

  it("promotes the same warning to an error in strict mode", () => {
    const found = auditFile(
      { file: "engine/scenes/probe.js", text: `const s = { at: 4.02 };`, kind: "scene" },
      { strict: true },
    );
    expect(found.find((f) => f.rule === "time.absoluteLiteral")?.severity).toBe("error");
  });

  it("does not warn on a time expression string", () => {
    const src = `const shot = { id: "s01", at: "b(1,0)", scene: "beat" };`;
    expect(rules(src)).not.toContain("time.absoluteLiteral");
  });

  it("does not warn on an unrelated numeric property", () => {
    const src = `const opts = { radius: 120, hue: 0.4, count: 30 };`;
    expect(rules(src)).not.toContain("time.absoluteLiteral");
  });
});

describe("audit — module state", () => {
  it("flags module-level `let` that a function writes", () => {
    const src = `let phase = 0;\nexport function draw() { phase += 0.1; }`;
    expect(rules(src)).toContain("state.moduleMutable");
  });

  it("allows a `const` lookup table, which is the intended way to share data", () => {
    const src = `const LUT = [1, 2, 3];\nexport function draw(f) { return LUT[f.frame % 3]; }`;
    expect(rules(src)).not.toContain("state.moduleMutable");
  });

  it("allows a module-level `let` that is never written", () => {
    const src = `let cached;\nexport function draw() { return cached ?? 0; }`;
    expect(rules(src)).not.toContain("state.moduleMutable");
  });
});

describe("audit — encoding integrity", () => {
  it("flags a UTF-8 BOM", () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x61]);
    const found = auditFile({ file: "a.js", text: "a", bytes, kind: "scene" });
    expect(found.map((f) => f.rule)).toContain("encoding.bom");
  });

  it("flags CRLF line endings", () => {
    const found = auditFile({ file: "a.js", text: "const a = 1;\r\nconst b = 2;\r\n", kind: "scene" });
    expect(found.map((f) => f.rule)).toContain("encoding.crlf");
  });

  it("flags the replacement character, which means the text was already destroyed", () => {
    // U+FFFD is what a mis-decoded byte becomes; retyping it by hand silently changes the text.
    const text = `const label = "\uFFFD\uFFFD\uFFFD";`;
    const found = auditFile({ file: "engine/scenes/a.js", text, kind: "scene" });
    expect(found.map((f) => f.rule)).toContain("encoding.replacementChar");
  });

  it("flags private-use characters, the classic wrong-codepage artefact", () => {
    const text = `const label = "\uE123\uE456";`;
    const found = auditFile({ file: "engine/scenes/a.js", text, kind: "scene" });
    expect(found.map((f) => f.rule)).toContain("encoding.problemChar");
  });

  it("does not flag ordinary CJK text, which is the point of the whole framework", () => {
    const text = `const title = "达拉崩吧 · 抽象代数";`;
    const found = auditFile({ file: "engine/scenes/a.js", text, kind: "scene" });
    expect(found.map((f) => f.rule)).not.toContain("encoding.problemChar");
    expect(found.map((f) => f.rule)).not.toContain("encoding.replacementChar");
  });
});

describe("audit — scope", () => {
  it("does not apply determinism rules to tools, which legitimately use clocks", () => {
    expect(errors("const t = Date.now();", "tool")).toEqual([]);
  });

  it("does not apply determinism rules to the player, which legitimately uses rAF", () => {
    expect(errors("requestAnimationFrame(loop);", "other")).toEqual([]);
  });

  it("still checks encoding integrity in a tool", () => {
    const found = auditFile({ file: "tools/x.mjs", text: "const s = '\uFFFD';", kind: "tool" });
    expect(found.map((f) => f.rule)).toContain("encoding.replacementChar");
  });

  it("flags an import the kernel may not make", () => {
    expect(errors(`import { x } from "@cvpw/render";`, "engine-lib")).toContain("import.forbiddenSubpackage");
  });

  it("reports a parse error rather than silently passing", () => {
    const found = audit("const = ;");
    expect(found.map((f) => f.rule)).toContain("syntax.parseError");
  });
});

describe("audit — classification", () => {
  it("classifies paths by role", () => {
    expect(classify("engine/scenes/b01_intro.js")).toBe("scene");
    expect(classify("engine/timeline.js")).toBe("timeline");
    expect(classify("engine/lib/time.js")).toBe("engine-lib");
    expect(classify("engine/core/engine.js")).toBe("engine-lib");
    expect(classify("tools/render.mjs")).toBe("tool");
    expect(classify("src/player/main.js")).toBe("other");
    expect(classify("engine/scenes/b01.test.js")).toBe("other");
  });
});

describe("audit — summary", () => {
  it("counts by rule and by severity", () => {
    const findings = audit(`const a = Math.random();\nconst b = { at: 4.02 };\nconst c = 1920;`);
    const s = summarise(findings, 1);
    expect(s.files).toBe(1);
    expect(s.errors).toBeGreaterThanOrEqual(1);
    expect(s.warnings).toBeGreaterThanOrEqual(1);
    expect(Object.keys(s.byRule)).toContain("determinism.bannedApi");
  });
});
