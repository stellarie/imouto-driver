import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import { resolveInJail } from "./pathjail.js";
import type { Tool, ToolContext, ToolResult } from "./types.js";

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

async function execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const path = String(args.path ?? "");
  const abs = resolveInJail(ctx.root, path);
  const mime = MIME[extname(abs).toLowerCase()];
  if (!mime) return { ok: false, output: "", error: "unsupported image type (png, jpg, jpeg, gif, webp)" };
  const size = (await stat(abs)).size;
  if (size > MAX_IMAGE_BYTES) return { ok: false, output: "", error: `image too large: ${size} bytes (max 8 MiB)` };
  const data = (await readFile(abs)).toString("base64");
  return { ok: true, output: `attached ${path}`, images: [`data:${mime};base64,${data}`] };
}

export const viewImageTool: Tool = {
  name: "view_image",
  description: "Look at an image file (png, jpg, gif, webp; max 8 MiB). The image is attached to your next turn.",
  parameters: {
    type: "object",
    properties: { path: { type: "string", description: "Relative to your scope." } },
    required: ["path"],
  },
  execute,
};
