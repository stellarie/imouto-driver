import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeAtomic } from "./atomic.js";
import type { ImoutoRecord } from "./imouto.js";

/** One JSON file per imouto under `<stateDir>/imoutos/`. */
export class ImoutoStore {
  private readonly dir: string;

  constructor(stateDir: string) {
    this.dir = join(stateDir, "imoutos");
  }

  save(rec: ImoutoRecord): void {
    rec.updatedAt = new Date().toISOString();
    writeAtomic(join(this.dir, `${rec.id}.json`), JSON.stringify(rec));
  }

  /** Every saved record. A record saved mid-activation loads as `tucked`. */
  loadAll(): ImoutoRecord[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        const rec = JSON.parse(readFileSync(join(this.dir, f), "utf8")) as ImoutoRecord;
        if (rec.state !== "tucked") rec.state = "tucked";
        return rec;
      });
  }
}
