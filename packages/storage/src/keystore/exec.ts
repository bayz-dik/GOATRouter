import { execFileSync } from "node:child_process";

/**
 * The single choke point for every keystore subprocess.
 *
 * Keeping `node:child_process` to one file makes the argv-array rule reviewable:
 * a source-scan test asserts no other adapter imports it, so no adapter can
 * quietly grow a shell string. Every call passes an argument array and secret
 * material travels on stdin, never in argv, because `/proc/<pid>/cmdline` and
 * `ps` are readable by other processes on the same device.
 */

export type CommandResult = {
  /** Exit status, or null when the process was killed or never ran. */
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** True when the binary does not exist or could not be launched at all. */
  readonly failedToSpawn: boolean;
};

export type CommandOptions = {
  /** Written to the child's stdin and closed. */
  readonly input?: string;
  readonly timeoutMs?: number;
};

export type CommandRunner = (
  file: string,
  args: readonly string[],
  options?: CommandOptions,
) => CommandResult;

const DEFAULT_TIMEOUT_MS = 5_000;

type SpawnFailure = {
  status?: number | null;
  code?: string;
  stdout?: Buffer | string;
  stderr?: Buffer | string;
};

function text(value: Buffer | string | undefined): string {
  if (value === undefined) {
    return "";
  }
  return typeof value === "string" ? value : value.toString("utf8");
}

export const runCommand: CommandRunner = (file, args, options = {}) => {
  try {
    const stdout = execFileSync(file, [...args], {
      encoding: "utf8",
      input: options.input ?? "",
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBuffer: 1 << 20,
      windowsHide: true,
      // No `shell` option: the argument array is passed to the binary verbatim.
    });
    return { status: 0, stdout, stderr: "", failedToSpawn: false };
  } catch (error) {
    const failure = error as SpawnFailure;
    const spawnFailed =
      failure.code === "ENOENT" ||
      failure.code === "EACCES" ||
      failure.code === "ETIMEDOUT" ||
      typeof failure.status !== "number";
    return {
      status: typeof failure.status === "number" ? failure.status : null,
      stdout: text(failure.stdout),
      stderr: text(failure.stderr),
      failedToSpawn: spawnFailed,
    };
  }
};
