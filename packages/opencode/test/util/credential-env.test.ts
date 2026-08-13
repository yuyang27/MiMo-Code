import { test, expect } from "bun:test"
import path from "path"
import { childEnv, credentialEnvKeys, withoutCredentials } from "../../src/util/credential-env"

const SRC = path.join(import.meta.dir, "..", "..", "src")
const files = () => [...new Bun.Glob("**/*.ts").scanSync(SRC)]
const secret = () => Object.fromEntries(credentialEnvKeys().map((key) => [key, "sk-secret"]))

async function scan(pattern: RegExp, skip: Set<string>, allow = /childEnv|withoutCredentials/) {
  const hits = await Promise.all(
    files()
      .filter((file) => !skip.has(file))
      .map(async (file) =>
        (await Bun.file(path.join(SRC, file)).text())
          .split("\n")
          .flatMap((line, index) => (pattern.test(line) && !allow.test(line) ? [`${file}:${index + 1}`] : [])),
      ),
  )
  return hits.flat()
}

test("withoutCredentials drops every credential var and keeps the rest", () => {
  const env = withoutCredentials({ PATH: "/usr/bin", HOME: "/home/user", ...secret() })
  expect(Object.keys(env).sort()).toEqual(["HOME", "PATH"])
  expect(JSON.stringify(env)).not.toContain("sk-secret")
})

// The regression this pins down: scrubbing only the inherited half is not enough. MCP `environment`,
// LSP `env` and formatter settings come from project config, and config supports `{env:VAR}` — so a
// checked-out repository could hand the credentials back to a command it controls.
test("childEnv drops credentials no matter which part they came from", () => {
  const fromConfig = childEnv({ PATH: "/usr/bin" }, secret())
  expect(fromConfig.PATH).toBe("/usr/bin")
  for (const key of credentialEnvKeys()) expect(fromConfig[key]).toBeUndefined()

  // and the same when they are inherited, overridden, or spread across several parts
  expect(childEnv(secret(), { A: "1" }, secret())["A"]).toBe("1")
  expect(JSON.stringify(childEnv(secret(), secret()))).not.toContain("sk-secret")
})

test("childEnv merges left to right", () => {
  expect(childEnv({ A: "1", B: "1" }, { B: "2" }, undefined).B).toBe("2")
})

// Structural guard. The bug this catches is a *new* spawn site building a child's environment by
// hand — no behavioral test of the helper would notice. Two shapes are forbidden:
//   - spreading the inherited env (`...process.env`, also written `...globalThis.process.env`);
//   - handing the inherited env over directly (`env: process.env`).
// A call that omits `env` entirely inherits by default and matches neither, which is why the spawner
// funnel now always returns an explicit env instead of `undefined`.
test("no spawn site builds a child environment without the credential scrub", async () => {
  const offenders = await scan(
    /\.\.\.\s*(?:globalThis\.)?process\.env|env:\s*(?:globalThis\.)?process\.env\b/,
    // In-process snapshot for the Env service, not an environment handed to a child.
    new Set(["env/index.ts"]),
  )
  expect(offenders).toEqual([])
})

// `sanitizedProcessEnv` only filters undefined values (it exists to satisfy `Record<string, string>`)
// so it is a full copy of the environment. Legitimate for the TUI worker — itself an engine process
// that needs the credentials — hence the allowlist rather than a rewrite.
test("sanitizedProcessEnv is only used for engine processes, or scrubbed at the call site", async () => {
  const unscrubbed = await scan(/sanitizedProcessEnv\(/, new Set(["util/mimo-process.ts", "cli/cmd/tui/thread.ts"]))
  expect(unscrubbed).toEqual([])
})
