import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(__dirname, "..");
const sourceSkillDir = path.resolve(packageDir, "../skills/mill");
const targetRootDir = path.resolve(packageDir, ".pi-skills");
const targetSkillDir = path.resolve(targetRootDir, "mill");

const copyRecursive = (from, to) => {
  const stat = fs.statSync(from);

  if (stat.isDirectory()) {
    fs.mkdirSync(to, { recursive: true });

    for (const entry of fs.readdirSync(from)) {
      copyRecursive(path.join(from, entry), path.join(to, entry));
    }

    return;
  }

  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
};

if (!fs.existsSync(path.join(sourceSkillDir, "SKILL.md"))) {
  throw new Error(`Missing source skill at ${sourceSkillDir}/SKILL.md`);
}

fs.rmSync(targetRootDir, { recursive: true, force: true });
copyRecursive(sourceSkillDir, targetSkillDir);

console.log(`Synced skills from ${sourceSkillDir} -> ${targetSkillDir}`);
