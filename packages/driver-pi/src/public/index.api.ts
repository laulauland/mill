import { Effect } from "effect";
import type { DriverCodec, DriverProcessConfig, DriverRegistration } from "@mill/core";
import { makePiProcessDriver } from "../process-driver.effect";

const PI_MODELS: ReadonlyArray<string> = ["openai/gpt-5.3-codex", "anthropic/claude-sonnet-4-6"];

const DEFAULT_PI_PROCESS_SCRIPT =
  "const input=JSON.parse(process.argv[1]);" +
  "console.log(JSON.stringify({type:'milestone',message:'spawn:'+input.agent}));" +
  "console.log(JSON.stringify({type:'final',text:'pi:'+input.prompt,sessionRef:'session/'+input.agent,agent:input.agent,model:input.model,exitCode:0,stopReason:'complete'}));";

export interface CreatePiDriverRegistrationInput {
  readonly process?: DriverProcessConfig;
}

export const createPiCodec = (): DriverCodec => ({
  modelCatalog: Effect.succeed(PI_MODELS),
});

export const createPiDriverConfig = (): DriverProcessConfig => ({
  command: "bun",
  args: ["-e", DEFAULT_PI_PROCESS_SCRIPT],
  env: {},
});

export const createPiDriverRegistration = (
  input?: CreatePiDriverRegistrationInput,
): DriverRegistration => {
  const process = input?.process ?? createPiDriverConfig();

  return {
    description: "Local process driver",
    modelFormat: "provider/model-id",
    process,
    codec: createPiCodec(),
    runtime: makePiProcessDriver(process),
  };
};
