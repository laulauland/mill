#!/usr/bin/env bun

import { Effect } from "effect";
import { ProcessControlError } from "@mill/core";
import { runCli } from "./index";

const bootstrapArgv = process.argv;
const code = await runCli(bootstrapArgv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  argv: bootstrapArgv,
  executablePath: process.execPath,
  pid: process.pid,
  processControl: {
    isAlive: (pid) =>
      Effect.try({
        try: () => process.kill(pid, 0),
        catch: (cause) => new ProcessControlError({ operation: "isAlive", pid, cause }),
      }).pipe(Effect.as(true)),
    sendSignal: (pid, signal) =>
      Effect.try({
        try: () => process.kill(pid, signal),
        catch: (cause) => new ProcessControlError({ operation: "sendSignal", pid, signal, cause }),
      }).pipe(Effect.as(true)),
  },
});
process.exit(code);
