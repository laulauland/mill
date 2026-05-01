import * as Schema from "effect/Schema";

export const StringArrayJson = Schema.fromJsonString(Schema.Array(Schema.String));
export const StringRecordJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.String));

export const decodeStringArrayJson = Schema.decodeUnknownOption(StringArrayJson);
export const decodeStringRecordJson = Schema.decodeUnknownOption(StringRecordJson);
export const decodeStringRecordJsonEffect = Schema.decodeUnknownEffect(StringRecordJson);
