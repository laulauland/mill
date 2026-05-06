import { Effect } from "effect";
import { SandboxError, type Credentials, type SandboxFactory } from "@mill/sandbox-core";

export interface E2bSandboxOptions {
  readonly credentials?: Credentials;
  readonly template?: string;
}

export const e2b =
  (_options: E2bSandboxOptions = {}): SandboxFactory =>
  () =>
    Effect.fail(
      new SandboxError({
        message:
          "@mill/sandbox-e2b is a placeholder package; the E2B adapter is not implemented yet.",
      }),
    );
