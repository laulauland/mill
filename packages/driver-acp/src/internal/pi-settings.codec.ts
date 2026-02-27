const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const readStringArrayField = (
  record: Record<string, unknown>,
  key: string,
): ReadonlyArray<string> | undefined => {
  const value = record[key];

  if (!Array.isArray(value)) {
    return undefined;
  }

  return value.filter((entry): entry is string => typeof entry === "string");
};

const normalizeModelCatalog = (models: ReadonlyArray<string>): ReadonlyArray<string> =>
  Array.from(new Set(models.map((model) => model.trim()).filter((model) => model.length > 0)));

export const parsePiSettingsModels = (raw: string): ReadonlyArray<string> => {
  const parsed = JSON.parse(raw) as unknown;

  if (!isRecord(parsed)) {
    return [];
  }

  return normalizeModelCatalog(readStringArrayField(parsed, "enabledModels") ?? []);
};
