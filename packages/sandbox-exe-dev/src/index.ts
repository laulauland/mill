import { Effect } from "effect";
import { SandboxError, type Credentials, type SandboxFactory } from "@mill/sandbox-core";

export interface ExeDevSandboxOptions {
  readonly credentials?: Credentials;
  readonly template?: string;
  readonly pool?: { readonly size: number; readonly template?: string };
}

export const exeDev =
  (_options: ExeDevSandboxOptions = {}): SandboxFactory =>
  () =>
    Effect.fail(
      new SandboxError({
        message:
          "@mill/sandbox-exe-dev is a placeholder package; the exe.dev adapter is not implemented yet.",
      }),
    );
