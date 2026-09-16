/**
 * The workflows, asserted as data (SPEC 13).
 *
 * A workflow is the one piece of this system that CI cannot exercise by
 * running it — a broken `daily.yml` is discovered at 20:30 UTC, in the dark,
 * by a ledger that did not get written. So its guarantees are asserted here
 * from the YAML itself.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const workflowDir = join(repoRoot, ".github", "workflows");

const readWorkflow = (name: string): string =>
  readFileSync(join(workflowDir, name), "utf8");

// `on:` is the YAML 1.1 boolean `true`, so js-yaml-style loaders key it as
// `true` rather than the string "on". The `yaml` package parses 1.2, where it
// stays a string — assert both so this does not depend on that detail.
const triggersOf = (doc: Record<string, unknown>): Record<string, unknown> =>
  (doc["on"] ?? doc[String(true)] ?? {}) as Record<string, unknown>;

const dailyText = readWorkflow("daily.yml");
const daily = parseYaml(dailyText) as Record<string, unknown>;
const deployText = readWorkflow("deploy.yml");
const deploy = parseYaml(deployText) as Record<string, unknown>;

describe("daily.yml", () => {
  it("runs on a weekday cron and can be dispatched by hand", () => {
    const on = triggersOf(daily);
    const schedule = on["schedule"] as { cron: string }[];
    expect(schedule.map((entry) => entry.cron)).toEqual(["30 20 * * 1-5"]);
    expect(on).toHaveProperty("workflow_dispatch");
  });

  it("serialises runs so two jobs never race the append-only ledger", () => {
    const concurrency = daily["concurrency"] as Record<string, unknown>;
    expect(concurrency).toBeDefined();
    expect(concurrency["group"]).toBe("ledger");
    // Cancelling mid-run would abandon a half-written session.
    expect(concurrency["cancel-in-progress"]).toBe(false);
  });

  it("can write the session back to the repository", () => {
    const permissions = daily["permissions"] as Record<string, unknown>;
    expect(permissions["contents"]).toBe("write");
  });

  it("keeps the checkout credentials, or the push at the end cannot work", () => {
    const steps = (daily["jobs"] as Record<string, { steps: Record<string, unknown>[] }>)["run"]
      ?.steps;
    const checkout = steps?.find((step) => String(step["uses"] ?? "").startsWith("actions/checkout"));
    expect(checkout).toBeDefined();
    const withBlock = checkout?.["with"] as Record<string, unknown>;
    expect(withBlock["persist-credentials"]).toBe(true);
    expect(withBlock["fetch-depth"]).toBe(0);
  });

  it("installs from the committed lockfile", () => {
    expect(dailyText).toContain("pnpm install --frozen-lockfile");
  });

  it("commits as github-actions[bot]", () => {
    expect(dailyText).toContain('github-actions[bot]');
  });

  it("does not leave an empty commit when the session wrote nothing", () => {
    // A holiday, a stale fetch or a shut market must not put a commit in the
    // history claiming a session happened.
    expect(dailyText).toContain('git status --porcelain data');
  });

  /**
   * The tripwire.
   *
   * Phase 4 runs no model, so this workflow needs no credential. When phase 5
   * wires the `value` agent into the nightly run it will have to add the key
   * here — and this test will fail, forcing that change to be looked at rather
   * than merged. When you are here because of that: decide deliberately, then
   * update this test in the same commit that adds the key.
   */
  it("has no ANTHROPIC_API_KEY, and fails when one is added", () => {
    expect(dailyText).not.toContain("ANTHROPIC_API_KEY: ");
    expect(dailyText).not.toMatch(/secrets\.ANTHROPIC_API_KEY/);
    expect(dailyText).not.toMatch(/^\s*ANTHROPIC_API_KEY\s*:/m);
  });

  it("names no repository secret at all yet", () => {
    expect(dailyText).not.toMatch(/\$\{\{\s*secrets\./);
  });
});

describe("deploy.yml", () => {
  it("rebuilds the site when the committed data or the site itself changes", () => {
    const on = triggersOf(deploy);
    const push = on["push"] as Record<string, unknown>;
    expect(push["branches"]).toEqual(["main"]);
    expect(push["paths"]).toEqual(["data/**", "web/**"]);
    expect(on).toHaveProperty("workflow_dispatch");
  });

  it("asks for exactly the Pages permissions and no repository write", () => {
    const permissions = deploy["permissions"] as Record<string, unknown>;
    expect(permissions["pages"]).toBe("write");
    expect(permissions["id-token"]).toBe("write");
    expect(permissions["contents"]).toBe("read");
  });

  it("publishes one deployment at a time", () => {
    const concurrency = deploy["concurrency"] as Record<string, unknown>;
    expect(concurrency["group"]).toBe("pages");
  });

  it("deploys with actions/deploy-pages", () => {
    expect(deployText).toContain("actions/deploy-pages@");
  });
});
