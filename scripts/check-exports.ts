import { join } from "node:path";

export interface ExportBoundaryViolation {
  readonly packageName: string;
  readonly packageJsonPath: string;
  readonly invalidExports: ReadonlyArray<string>;
}

export interface ExportBoundaryCheckResult {
  readonly packageCount: number;
  readonly violations: ReadonlyArray<ExportBoundaryViolation>;
}

const workspaceGlobsFrom = (value: unknown): ReadonlyArray<string> => {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string");
  }

  if (typeof value === "object" && value !== null) {
    const packages = (value as { readonly packages?: unknown }).packages;
    if (Array.isArray(packages)) {
      return packages.filter((entry): entry is string => typeof entry === "string");
    }
  }

  return [];
};

const toPackageJsonGlob = (workspaceGlob: string): string => {
  if (workspaceGlob.endsWith("package.json")) {
    return workspaceGlob;
  }

  const normalized = workspaceGlob.endsWith("/") ? workspaceGlob.slice(0, -1) : workspaceGlob;
  return `${normalized}/package.json`;
};

export const collectWorkspacePackageJsonPaths = async (
  rootDirectory: string,
): Promise<ReadonlyArray<string>> => {
  const rootPackageJsonPath = join(rootDirectory, "package.json");
  const rootPackageJson = (await Bun.file(rootPackageJsonPath).json()) as {
    readonly workspaces?: unknown;
  };

  const workspaceGlobs = workspaceGlobsFrom(rootPackageJson.workspaces);
  const packageJsonPaths = new Set<string>();

  for (const workspaceGlob of workspaceGlobs) {
    const packageJsonGlob = toPackageJsonGlob(workspaceGlob);
    for await (const path of new Bun.Glob(packageJsonGlob).scan(rootDirectory)) {
      packageJsonPaths.add(join(rootDirectory, path));
    }
  }

  return [...packageJsonPaths].sort();
};

export const normalizeExportEntries = (value: unknown): Array<string> => {
  if (typeof value === "string") {
    return [value];
  }

  if (Array.isArray(value)) {
    return value.flatMap((entry) => normalizeExportEntries(entry));
  }

  if (typeof value === "object" && value !== null) {
    return Object.values(value).flatMap((entry) => normalizeExportEntries(entry));
  }

  return [];
};

export const normalizeExportKeys = (value: unknown): Array<string> => {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => normalizeExportKeys(entry));
  }

  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([key, entry]) => {
      const keys = key.startsWith(".") ? [key] : [];
      return [...keys, ...normalizeExportKeys(entry)];
    });
  }

  return [];
};

export const isInternalExportPath = (entry: string): boolean =>
  /(^|\/)(src\/)?(internal|runtime|domain)(\/|$)/.test(entry.replace(/^\.\//, ""));

export const checkExportBoundaries = async (
  rootDirectory: string,
): Promise<ExportBoundaryCheckResult> => {
  const packageJsonPaths = await collectWorkspacePackageJsonPaths(rootDirectory);
  const violations: Array<ExportBoundaryViolation> = [];

  for (const packageJsonPath of packageJsonPaths) {
    const packageJson = (await Bun.file(packageJsonPath).json()) as {
      readonly name?: unknown;
      readonly exports?: unknown;
    };

    const packageName = typeof packageJson.name === "string" ? packageJson.name : packageJsonPath;
    const invalidExports = [
      ...new Set(
        [
          ...normalizeExportKeys(packageJson.exports),
          ...normalizeExportEntries(packageJson.exports),
        ].filter((entry) => isInternalExportPath(entry)),
      ),
    ].sort();

    if (invalidExports.length > 0) {
      violations.push({
        packageName,
        packageJsonPath,
        invalidExports,
      });
    }
  }

  return {
    packageCount: packageJsonPaths.length,
    violations,
  };
};

const formatViolation = (violation: ExportBoundaryViolation): string =>
  `${violation.packageName}: ${violation.invalidExports.join(", ")} (${violation.packageJsonPath})`;

export const runCheck = async (rootDirectory: string = process.cwd()): Promise<number> => {
  const result = await checkExportBoundaries(rootDirectory);

  if (result.violations.length > 0) {
    console.error("Invalid package exports detected:");
    for (const violation of result.violations) {
      console.error(`- ${formatViolation(violation)}`);
    }
    return 1;
  }

  console.log(`Package export boundary check passed for ${result.packageCount} package(s).`);
  return 0;
};

if (import.meta.main) {
  const exitCode = await runCheck();
  process.exit(exitCode);
}
