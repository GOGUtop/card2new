import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const compiler = process.argv[2] || process.env.HERMESC_BIN;
if (!compiler) {
    throw new Error("Pass the hermesc compiler path: npm run test:hermes -- /path/to/hermesc");
}
const directory = mkdtempSync(join(tmpdir(), "cardvault-hermes-"));
const output = join(directory, "plugin.hbc");
const loader = join(directory, "loader.js");
try {
    writeFileSync(loader, "(function(vendetta){return " + readFileSync("docs/index.js", "utf8") + "\n})");
    const result = spawnSync(compiler, ["-w", "-emit-binary", "-out", output, loader], { encoding: "utf8" });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error("Hermes compilation failed:\n" + result.stderr);
    if (!existsSync(output)) throw new Error("Hermes did not produce bytecode");
    console.log("Hermes compilation passed for docs/index.js inside Bunny's loader");
} finally {
    if (existsSync(loader)) unlinkSync(loader);
    if (existsSync(output)) unlinkSync(output);
    rmdirSync(directory);
}
