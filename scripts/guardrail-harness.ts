export interface GuardrailCheck {
  readonly name: string;
  readonly cmd: ReadonlyArray<string>;
}

export interface GuardrailCommandInput {
  readonly cwd: string;
  readonly cmd: ReadonlyArray<string>;
}

export interface GuardrailCommandResult {
  readonly cwd: string;
  readonly cmd: ReadonlyArray<string>;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly combinedOutput: string;
}

export interface GuardrailSuiteInput {
  readonly cwd: string;
  readonly checks: ReadonlyArray<GuardrailCheck>;
}

export interface GuardrailSuiteResult {
  readonly results: ReadonlyArray<{
    readonly check: GuardrailCheck;
    readonly result: GuardrailCommandResult;
  }>;
  readonly failures: ReadonlyArray<{
    readonly check: GuardrailCheck;
    readonly result: GuardrailCommandResult;
  }>;
}

export const runGuardrailCommand = async (
  input: GuardrailCommandInput,
): Promise<GuardrailCommandResult> => {
  const subprocess = Bun.spawn({
    cmd: [...input.cmd],
    cwd: input.cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ]);

  return {
    cwd: input.cwd,
    cmd: input.cmd,
    exitCode,
    stdout,
    stderr,
    combinedOutput: [stdout, stderr].filter((entry) => entry.length > 0).join("\n"),
  };
};

export const runGuardrailSuite = async (
  input: GuardrailSuiteInput,
): Promise<GuardrailSuiteResult> => {
  const results: Array<{
    readonly check: GuardrailCheck;
    readonly result: GuardrailCommandResult;
  }> = [];

  for (const check of input.checks) {
    const result = await runGuardrailCommand({ cwd: input.cwd, cmd: check.cmd });
    results.push({ check, result });
  }

  const failures = results.filter(({ result }) => result.exitCode !== 0);
  return { results, failures };
};
