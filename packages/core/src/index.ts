// @mill/core — Effect-native supervised task runtime

// Schemas
export * from "./schemas/task-command";
export * from "./schemas/task-event";
export * from "./schemas/task-state";
export * from "./schemas/supervision";

// Pure functions
export * from "./task-reducer";
export * from "./ids";

// Services
export { Mill, MillLive, MillError } from "./services/Mill";
export {
  EventAppender,
  EventAppenderLive,
  EventAppendError,
  LifecycleValidationError,
} from "./services/EventAppender";
export { TaskEntity, TaskEntityError } from "./services/TaskEntity";
export { EntityRegistry, EntityRegistryLive, EntityRegistryError } from "./services/EntityRegistry";
export { ProgramHost, ProgramHostLive, ProgramHostError } from "./services/ProgramHost";
export {
  AgentRuntime,
  AgentRuntimeError,
  AgentRuntimeStub,
  makeStubAgentRuntime,
} from "./services/AgentRuntime";
export type { AgentRuntimeInput, AgentRuntimeEmit } from "./services/AgentRuntime";
export { ShellRuntime, ShellRuntimeError, ShellRuntimeLive } from "./services/ShellRuntime";
export type { ShellRuntimeEmit, ShellRuntimeInput } from "./services/ShellRuntime";
export { PathService, PathServiceLive } from "./services/PathService";
export { IdGenerator, IdGeneratorLive } from "./services/IdGenerator";

// Public APIs
export { task, shell, codex, claude, pi, ProgramContextError } from "./program.api";
export type {
  Agent,
  ProgramContext,
  ShellOptions,
  ShellOutput,
  SpawnInput,
  TaskHandle,
  TaskOptions,
} from "./program.api";
export { createMillRuntime } from "./runtime.api";
export type { MillRuntime } from "./runtime.api";
