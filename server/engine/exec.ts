export interface RunOptions {
  timeoutMs?: number;
  cwd?: string;
  /** text piped to the child's stdin, then closed (piper reads its input this way) */
  stdin?: string;
  /** grace after SIGTERM before SIGKILL (tests shrink this) */
  killGraceMs?: number;
  /** grace after exit for output pipes to close before giving up on them */
  pipeDrainMs?: number;
}

/** Run an external binary, capture stdout, and fail loudly:
 * - missing binary -> error naming the command
 * - non-zero exit -> error with the stderr tail
 * - timeout -> SIGTERM, then SIGKILL after a grace — termination is
 *   guaranteed even for children that ignore SIGTERM (a hung whisper must
 *   never wedge the serial ingest queue)
 * - pipes held open past exit (grandchildren) -> bounded wait, loud error */
export async function run(cmd: string[], opts: RunOptions = {}): Promise<string> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(cmd, {
      cwd: opts.cwd,
      stdin: opts.stdin === undefined ? undefined : new TextEncoder().encode(opts.stdin),
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (err) {
    throw new Error(`${cmd[0]} could not be started — is it installed and on PATH? (${(err as Error).message})`);
  }

  let timedOut = false;
  let termTimer: ReturnType<typeof setTimeout> | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  if (opts.timeoutMs) {
    termTimer = setTimeout(() => {
      timedOut = true;
      proc.kill();
      killTimer = setTimeout(() => proc.kill(9), opts.killGraceMs ?? 5000);
    }, opts.timeoutMs);
  }

  const collected = Promise.all([
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
    proc.exited,
  ]).then(([stdout, stderr, exitCode]) => ({ done: true as const, stdout, stderr, exitCode }));

  const exitedButPipesStuck = (async () => {
    const exitCode = await proc.exited;
    await new Promise((r) => setTimeout(r, opts.pipeDrainMs ?? 2000));
    return { done: false as const, exitCode };
  })();

  const outcome = await Promise.race([collected, exitedButPipesStuck]);
  clearTimeout(termTimer);
  clearTimeout(killTimer);

  if (timedOut) {
    throw new Error(`${cmd[0]} timed out after ${Math.round((opts.timeoutMs as number) / 1000)}s and was killed`);
  }
  if (!outcome.done) {
    throw new Error(
      `${cmd[0]} exited ${outcome.exitCode} but its output pipes never closed — a grandchild process may be holding them`,
    );
  }
  if (outcome.exitCode !== 0) {
    const tail = outcome.stderr.trim().slice(-500);
    throw new Error(`${cmd[0]} exited ${outcome.exitCode}: ${tail || "(no stderr)"}`);
  }
  return outcome.stdout;
}
