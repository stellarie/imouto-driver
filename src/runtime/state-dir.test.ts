import { createHash } from "node:crypto";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultStateHome, normalizeRoot, projectKey, stateDirFor } from "./state-dir.js";

const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex").slice(0, 12);

describe("state directory derivation", () => {
  it("normalizes Windows roots and derives stable keys", () => {
    const expected = `proj-${hash("c:/users/x/proj")}`;
    expect(projectKey("C:\\Users\\x\\proj", "win32")).toBe(expected);
    expect(projectKey("c:/Users/X/proj/", "win32")).toBe(expected);
    expect(projectKey("C:\\Users\\x\\proj\\", "win32")).toBe(expected);
    expect(projectKey("C:\\", "win32")).toBe(`c_-${hash("c:/")}`);
  });

  it("keeps Linux case and sanitizes the final segment", () => {
    expect(projectKey("/home/x/proj", "linux")).toBe(`proj-${hash("/home/x/proj")}`);
    expect(projectKey("/home/x/Proj", "linux")).not.toBe(projectKey("/home/x/proj", "linux"));
    expect(projectKey("/home/x/my proj!", "linux")).toBe(`my_proj_-${hash("/home/x/my proj!")}`);
    expect(normalizeRoot("/", "linux")).toBe("/");
  });

  it("uses the configured state home or the home default", () => {
    expect(defaultStateHome({ IMOUTO_STATE_HOME: "/custom" }, "/home/x")).toBe("/custom");
    expect(defaultStateHome({ IMOUTO_STATE_HOME: "" }, "/home/x")).toBe(join("/home/x", ".imouto", "projects"));
    expect(stateDirFor("/home/x/proj", "/state", "linux")).toBe(join("/state", `proj-${hash("/home/x/proj")}`));
  });
});
