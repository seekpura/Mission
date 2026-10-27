import { DatabaseSync } from "node:sqlite";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export class MissionDatabase {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
  }

  migrate(schemaPath: string) {
    this.db.exec(readFileSync(schemaPath, "utf8"));
  }

  close() {
    this.db.close();
  }
}
