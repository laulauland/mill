import * as Schema from "effect/Schema";

// Default supervision policy is implicit:
// - Parent cancellation cascades to descendants.
// - Terminal parent rejects new child spawns.
// - Root program task cancellation cancels the entire tree.
// - Agent child failure does not fail the program unless user code awaits or propagates it.
//
// Explicit policies (cascade_cancel, isolate_failures, etc.) may be added later
// under plain-English names; OTP terms (one_for_one, rest_for_one) are NOT adopted.

export const SupervisionPolicy = Schema.Literal("default");
export type SupervisionPolicy = Schema.Schema.Type<typeof SupervisionPolicy>;
