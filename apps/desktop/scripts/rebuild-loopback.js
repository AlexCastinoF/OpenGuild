/**
 * Compila loopback-capture (N-API / WASAPI process loopback) para a versão do Electron.
 */
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

if (process.platform !== "win32") {
  process.exit(0);
}

const root = path.join(__dirname, "..");
function findLoopbackDir() {
  const candidates = [
    path.join(root, "node_modules", "loopback-capture"),
    path.join(root, "..", "..", "node_modules", "loopback-capture"),
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}
const lbDir = findLoopbackDir();
const nodeFile = lbDir ? path.join(lbDir, "build", "Release", "loopback_capture_addon.node") : "";

if (!lbDir) {
  console.log("rebuild-loopback: loopback-capture não instalado, pulando.");
  process.exit(0);
}

if (fs.existsSync(nodeFile)) {
  console.log("rebuild-loopback: addon já compilado.");
  process.exit(0);
}

let electronVersion = "33.4.11";
try {
  electronVersion = require(path.join(root, "node_modules", "electron", "package.json")).version;
} catch {
  /* ignore */
}

console.log(`rebuild-loopback: compilando para Electron ${electronVersion}...`);
execSync(`npx cmake-js compile --runtime=electron --runtime-version=${electronVersion} --arch=x64`, {
  cwd: lbDir,
  stdio: "inherit",
  env: process.env,
});

if (!fs.existsSync(nodeFile)) {
  console.warn("rebuild-loopback: falhou — captura de áudio usará fallback application-loopback.");
  process.exit(0);
}

console.log("rebuild-loopback: OK");
