import * as Schema from "effect/Schema";

export const StringRecordJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.String));

export const decodeStringRecordJsonEffect = Schema.decodeUnknownEffect(StringRecordJson);
