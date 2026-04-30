#!/usr/bin/env bun

import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import { Effect, Exit, Layer, Runtime } from "effect";
import { bunCliPlatformLayer, runCliMainEffect } from "./index";

const entrypointPath = decodeURIComponent(new URL(import.meta.url).pathname);
const main = runCliMainEffect({ entrypointPath }).pipe(
  Effect.provide(
    Layer.mergeAll(BunServices.layer, bunCliPlatformLayer.pipe(Layer.provide(BunServices.layer))),
  ),
);

BunRuntime.runMain(main, {
  teardown: (exit, onExit) => {
    if (Exit.isSuccess(exit)) {
      onExit(exit.value);
      return;
    }

    Runtime.defaultTeardown(exit, onExit);
  },
});
