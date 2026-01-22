import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(__dirname, "../node_modules/leaflet/dist");
const destDir = path.resolve(__dirname, "../vendor/leaflet");

async function pathExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function copyDir(src, dest) {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath);
    } else if (entry.isFile()) {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

async function main() {
  if (!(await pathExists(srcDir))) {
    console.warn("Leaflet not found in node_modules. Run `npm install` first.");
    return;
  }
  await copyDir(srcDir, destDir);
  console.log(`Copied Leaflet assets to ${path.relative(process.cwd(), destDir)}`);
}

main().catch((err) => {
  console.error("Failed to copy Leaflet assets:", err);
  process.exitCode = 1;
});
