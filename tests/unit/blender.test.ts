import { describe, expect, it } from "vitest";

import {
  BLENDER_MIN,
  compareVersions,
  isSupported,
  parseBlenderVersion,
  selectBlender,
  type BlenderInstall,
  type BlenderVersion,
} from "../../packages/cli/src/blender.js";

/** The exact banner the reference machine prints. Not invented: copied from `blender --version`. */
const REAL_BANNER = "Blender 5.2.2 LTS\n\tbuild date: 2026-09-15\n\tbuild time: 01:37:04\n";

const version = (major: number, minor: number, patch = 0, lts = false): BlenderVersion => ({
  major,
  minor,
  patch,
  lts,
  banner: `Blender ${major}.${minor}.${patch}${lts ? " LTS" : ""}`,
});

const install = (v: BlenderVersion, directory = `blender ${v.major}.${v.minor}.${v.patch}`): BlenderInstall => ({
  directory,
  executable: `${directory}/blender.exe`,
  version: v,
  supported: isSupported(v),
});

describe("parseBlenderVersion", () => {
  it("reads the version and the LTS flag from the real banner", () => {
    expect(parseBlenderVersion(REAL_BANNER)).toEqual({
      major: 5,
      minor: 2,
      patch: 2,
      lts: true,
      banner: "Blender 5.2.2 LTS",
    });
  });

  it("accepts a two-part version, because not every build prints three", () => {
    expect(parseBlenderVersion("Blender 5.3")).toMatchObject({ major: 5, minor: 3, patch: 0, lts: false });
  });

  it("returns null rather than guessing when the output is not a Blender banner", () => {
    // A bridge that silently accepted this would gate on nothing at all.
    expect(parseBlenderVersion("")).toBeNull();
    expect(parseBlenderVersion("Some other tool 5.2.2")).toBeNull();
    expect(parseBlenderVersion("blender crashed before printing")).toBeNull();
  });

  it("ignores leading blank lines, which a redirected stdout can produce on Windows", () => {
    expect(parseBlenderVersion("\r\n\r\nBlender 5.0.0\n")?.major).toBe(5);
  });
});

describe("the 5.0 floor", () => {
  it("supports exactly 5.0.0, because the floor is inclusive", () => {
    expect(isSupported(version(5, 0, 0))).toBe(true);
  });

  it("refuses 4.x, which is the whole point of the gate", () => {
    expect(isSupported(version(4, 5, 0))).toBe(false);
    expect(isSupported(version(4, 9, 9))).toBe(false);
  });

  it("names the floor in one place so it cannot drift between the gate and the docs", () => {
    expect(BLENDER_MIN).toEqual([5, 0, 0]);
  });
});

describe("compareVersions", () => {
  it("compares numerically, not lexically", () => {
    // "5.10" < "5.9" as strings, which would pick the wrong build the month 5.10 ships.
    expect(compareVersions([5, 10, 0], [5, 9, 0])).toBeGreaterThan(0);
  });

  it("reports equality for the same version", () => {
    expect(compareVersions([5, 2, 2], [5, 2, 2])).toBe(0);
  });
});

describe("selectBlender", () => {
  it("picks the highest supported version, not the first found", () => {
    const chosen = selectBlender([install(version(5, 0)), install(version(5, 2, 2)), install(version(5, 1))]);
    expect(chosen?.version).toMatchObject({ major: 5, minor: 2, patch: 2 });
  });

  it("prefers an LTS build when two installs share a version", () => {
    const chosen = selectBlender([install(version(5, 2, 2, false), "a"), install(version(5, 2, 2, true), "b")]);
    expect(chosen?.version.lts).toBe(true);
    expect(chosen?.directory).toBe("b");
  });

  it("returns null when nothing meets the floor, rather than driving 4.x anyway", () => {
    expect(selectBlender([install(version(4, 9)), install(version(3, 6))])).toBeNull();
  });

  it("ignores an unsupported install even when it is the only one present", () => {
    expect(selectBlender([install(version(4, 5))])).toBeNull();
  });
});
