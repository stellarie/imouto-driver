import { fsTool } from "./fs-tool.js";
import { makeGatesTool } from "./gates-tool.js";
import { grepTool } from "./grep-tool.js";
import { sendTool, spawnTool, waitTool } from "./imouto-tools.js";
import { memoryNoteTool, memoryReadTool, memoryRecallTool, searchTool } from "./memory-tools.js";
import { ToolRegistry } from "./registry.js";
import { shellTool } from "./shell-tool.js";
import { viewImageTool } from "./view-image-tool.js";
import { webTool } from "./web-tool.js";

export function defaultRegistry(): ToolRegistry {
  return new ToolRegistry()
    .register(fsTool)
    .register(shellTool)
    .register(grepTool)
    .register(webTool)
    .register(viewImageTool)
    .register(makeGatesTool())
    .register(spawnTool)
    .register(sendTool)
    .register(waitTool)
    .register(searchTool)
    .register(memoryRecallTool)
    .register(memoryReadTool)
    .register(memoryNoteTool);
}
