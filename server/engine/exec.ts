export interface RunOptions {
  timeoutMs?: number;
  cwd?: string;
}

/** Run an external binary, capture stdout, and fail loudly:
 * - missing binary -> error naming the command
 * - non-zero exit -> error with the stderr tail
 * - timeout -> process killed, error names the elapsed budget */
export async function run(cmd: string[], opts: RunOptions = {}): Promise<string> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(cmd, { cwd: opts.cwd, stdout: "pipe", stderr: "pipe" });
  } catch (err) {
    throw new Error(`${cmd[0]} could not be started — is it installed and on PATH? (${(err as Error).message})`);
  }

  let timedOut = false;
  const timer = opts.timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        proc.kill();
      }, opts.timeoutMs)
    : undefined;

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
    proc.exited,
  ]);
  if (timer) clearTimeout(timer);

  if (timedOut) {
    throw new Error(`${cmd[0]} timed out after ${Math.round((opts.timeoutMs as number) / 1000)}s and was killed`);
  }
  if (exitCode !== 0) {
    const tail = stderr.trim().slice(-500);
    throw new Error(`${cmd[0]} exited ${exitCode}: ${tail || "(no stderr)"}`);
  }
  return stdout;
}
