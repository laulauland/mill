import { runCli } from "../public/index.api";

const code = await runCli(process.argv.slice(2));
process.exit(code);
