const normalizeExportEntries = (value: unknown): Array<string> => {
  if (typeof value === "string") {
    return [value];
  }

  if (typeof value === "object" && value !== null) {
    return Object.values(value).flatMap((entry) => normalizeExportEntries(entry));
  }

  return [];
};

const run = async (): Promise<void> => {
  const exportViolations: Array<string> = [];

  for await (const path of new Bun.Glob("packages/*/package.json").scan(".")) {
    const packageJson = await Bun.file(path).json();
    const exportsField = packageJson.exports as unknown;
    const exportPaths = normalizeExportEntries(exportsField);
    const invalidPaths = exportPaths.filter(
      (entry) =>
        /\/src\/(internal|runtime|domain)\//.test(entry) ||
        /\/(internal|runtime|domain)\//.test(entry),
    );

    if (invalidPaths.length > 0) {
      exportViolations.push(`${packageJson.name}: ${invalidPaths.join(", ")}`);
    }
  }

  if (exportViolations.length > 0) {
    console.error("Invalid package exports detected:");
    for (const violation of exportViolations) {
      console.error(`- ${violation}`);
    }
    process.exit(1);
  }

  console.log("Package export boundary check passed.");
};

void run();
