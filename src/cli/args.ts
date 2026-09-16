/**
 * A very small argument parser.
 *
 * The CLI takes a handful of `--key value` flags and nothing else — no
 * subcommand trees, no short options, no negation. A dependency for this would
 * be more code to audit than the twenty lines below.
 */
export interface Args {
  readonly command: string;
  readonly flags: ReadonlyMap<string, string>;
  readonly positional: readonly string[];
}

export function parseArgs(argv: readonly string[]): Args {
  const flags = new Map<string, string>();
  const positional: string[] = [];
  const [command = "", ...rest] = argv;

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === undefined) continue;
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const equals = token.indexOf("=");
    if (equals !== -1) {
      flags.set(token.slice(2, equals), token.slice(equals + 1));
      continue;
    }
    const next = rest[index + 1];
    // A flag followed by another flag is a boolean: `--check` means true.
    if (next === undefined || next.startsWith("--")) {
      flags.set(token.slice(2), "true");
      continue;
    }
    flags.set(token.slice(2), next);
    index += 1;
  }

  return { command, flags, positional };
}

export function flag(args: Args, name: string, fallback: string): string {
  return args.flags.get(name) ?? fallback;
}

export function boolFlag(args: Args, name: string): boolean {
  const value = args.flags.get(name);
  return value === "true" || value === "";
}

export function optionalFlag(args: Args, name: string): string | undefined {
  return args.flags.get(name);
}
