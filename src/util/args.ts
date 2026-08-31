/** Minimal flag parsing: `--flag`, `--key value`, `--key=value`, plus positionals. */
export interface ParsedArgs {
  positionals: string[];
  flags: Set<string>;
  options: Map<string, string>;
}

export function parseArgs(argv: string[] = process.argv.slice(2)): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Set<string>();
  const options = new Map<string, string>();

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }

    const body = arg.slice(2);
    const eq = body.indexOf('=');
    if (eq !== -1) {
      options.set(body.slice(0, eq), body.slice(eq + 1));
      continue;
    }

    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      options.set(body, next);
      i++;
    } else {
      flags.add(body);
    }
  }

  return { positionals, flags, options };
}
