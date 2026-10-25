/** Copia ffmpeg-static para resources/ffmpeg/ffmpeg.exe (empacote Electron). */
const fs = require("fs");
const path = require("path");

const destDir = path.join(__dirname, "..", "resources", "ffmpeg");
const dest = path.join(destDir, "ffmpeg.exe");

function main() {
  let src = "";
  try {
    src = require("ffmpeg-static");
  } catch (err) {
    console.warn("ffmpeg-static ausente:", err.message);
    return;
  }
  if (!src || !fs.existsSync(src)) {
    console.warn("ffmpeg-static path inválido:", src);
    return;
  }
  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(src, dest);
  console.log("ffmpeg →", dest);
}

main();
