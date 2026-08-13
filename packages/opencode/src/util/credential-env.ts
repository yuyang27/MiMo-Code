/**
 * Env vars that carry the user's credentials in cleartext.
 *
 * `MIMOCODE_AUTH_CONTENT` is the whole `auth.json` (model provider keys, OAuth refresh tokens);
 * `MIMOCODE_CONFIG_CONTENT` can embed MCP `environment` values and request `headers`.
 *
 * Neither may reach a child process the engine spawns. The bash tool and the shell part run
 * agent-authored commands, local MCP servers and language servers are third-party binaries, and all
 * of them run as the user — so plain inheritance means `echo $MIMOCODE_AUTH_CONTENT` exfiltrates the
 * provider key.
 */
const CREDENTIAL_ENV = new Set(["MIMOCODE_AUTH_CONTENT", "MIMOCODE_CONFIG_CONTENT"])

/**
 * Environment for a child process: merge the parts left to right, then drop the credential vars.
 *
 * Scrubbing the *merged* result is the point. Scrubbing only the inherited half leaves the door
 * open, because the later parts are not ours: MCP `environment`, LSP `env` and formatter settings all
 * come from project config, and config supports `{env:VAR}` substitution — so a checked-out
 * repository could put `{ MIMOCODE_AUTH_CONTENT: "{env:MIMOCODE_AUTH_CONTENT}" }` in its own config
 * and hand the credentials right back to a command it controls. Plugin `shell.env` hooks are another
 * such part.
 *
 * Call this with an explicit inherited part; never let `env` reach `spawn` as `undefined`, which
 * makes the child inherit the parent's environment wholesale, credentials included.
 *
 * A child that legitimately needs credentials must be given them by name (see
 * `control-plane/workspace.ts`, which builds its own env), not by relying on merge order here.
 *
 * This closes inheritance, not every path: a child running as the same user can still read
 * `/proc/<parent-pid>/environ`, so a credential that must not leak should not be in the environment
 * at all — see `Auth.inject`.
 */
export function childEnv(...parts: (NodeJS.ProcessEnv | undefined)[]): Record<string, string> {
  // Undefined values are dropped too: `spawn` ignores them anyway, and the concrete
  // `Record<string, string>` is what the MCP stdio transport and node-pty want.
  return Object.fromEntries(
    Object.entries(Object.assign({}, ...parts) as NodeJS.ProcessEnv).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && !CREDENTIAL_ENV.has(entry[0]),
    ),
  )
}

/** Copy of `env` with the credential vars removed. Prefer `childEnv` when building a child's env. */
export function withoutCredentials(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !CREDENTIAL_ENV.has(key)))
}

/** Credential var names, for tests and diagnostics that must not hardcode the list. */
export function credentialEnvKeys() {
  return [...CREDENTIAL_ENV]
}
