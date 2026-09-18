import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { resolveInJail } from "./pathjail.js";

const root = process.platform === "win32" ? "C:\\jail" : "/jail";

describe("resolveInJail", () => {
  it("allows nested paths", () => {
    expect(resolveInJail(root, "a/b.txt")).toContain("b.txt");
  });
  it("allows the root itself", () => {
    expect(resolveInJail(root, ".")).toBe(resolve(root));
  });
  it("rejects parent escapes", () => {
    expect(() => resolveInJail(root, "../secret")).toThrow(/escapes jail/);
  });
  it("rejects absolute paths outside the jail", () => {
    const outside = process.platform === "win32" ? "D:\\other" : "/etc/passwd";
    expect(() => resolveInJail(root, outside)).toThrow(/escapes jail/);
  });
});
