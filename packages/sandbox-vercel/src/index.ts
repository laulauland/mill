import { Effect } from "effect";
import { SandboxError, type Credentials, type SandboxFactory } from "@mill/sandbox-core";

export interface VercelSandboxOptions {
  readonly credentials?: Credentials;
  readonly template?: string;
}

export const vercel =
  (_options: VercelSandboxOptions = {}): SandboxFactory =>
  () =>
    Effect.fail(
      new SandboxError({
        message:
          "@mill/sandbox-vercel is a placeholder package; the Vercel Sandbox adapter is not implemented yet.",
      }),
    );
