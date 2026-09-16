/**
 * Caching (SPEC 6).
 *
 * The point of this cache is not speed, it is immutability. `data/prices/`
 * and `data/briefs/` are the point-in-time record of what the agents actually
 * saw; Yahoo revises history, so a second fetch of the same day can disagree
 * with the first. Once a key is written it is never rewritten.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ResponseCache } from "./port.js";

/** Process-lifetime cache. Deduplicates repeat calls inside a single run. */
export class MemoryCache implements ResponseCache {
  private readonly entries = new Map<string, unknown>();

  get<T>(key: string): Promise<T | undefined> {
    return Promise.resolve(this.entries.get(key) as T | undefined);
  }

  set<T>(key: string, value: T): Promise<void> {
    this.entries.set(key, value);
    return Promise.resolve();
  }

  has(key: string): Promise<boolean> {
    return Promise.resolve(this.entries.has(key));
  }

  get size(): number {
    return this.entries.size;
  }
}

/**
 * Write-once cache on disk, one JSON file per key.
 *
 * A second `set` for a key that already exists is ignored rather than
 * overwriting: rewriting a committed snapshot would rewrite what the agent
 * saw, and every conclusion drawn from that day with it.
 */
export class PointInTimeCache implements ResponseCache {
  constructor(private readonly root: string) {}

  private pathFor(key: string): string {
    // Keys carry colons and symbols like "^GSPC" or "EURUSD=X"; keep the file
    // name readable but safe on every filesystem.
    const safe = key.replace(/[^A-Za-z0-9._-]+/g, "_");
    return join(this.root, `${safe}.json`);
  }

  get<T>(key: string): Promise<T | undefined> {
    const file = this.pathFor(key);
    if (!existsSync(file)) return Promise.resolve(undefined);
    return Promise.resolve(JSON.parse(readFileSync(file, "utf8")) as T);
  }

  set<T>(key: string, value: T): Promise<void> {
    const file = this.pathFor(key);
    if (existsSync(file)) return Promise.resolve();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    return Promise.resolve();
  }

  has(key: string): Promise<boolean> {
    return Promise.resolve(existsSync(this.pathFor(key)));
  }
}
