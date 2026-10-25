/**
 * Compila plugins CSS do dedicated (SfAssignTeams + SfKillSounds).
 * Precisa de SDK .NET 8 em tools/dotnet-sdk ou no PATH.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const portable = path.join(root, 'tools', 'dotnet-sdk', 'dotnet.exe');
const dotnet = fs.existsSync(portable) ? portable : 'dotnet';
const projects = [
  path.join(root, 'cs2-plugin', 'SfAssignTeams', 'SfAssignTeams.csproj'),
  path.join(root, 'cs2-plugin', 'SfKillSounds', 'SfKillSounds.csproj'),
];

let code = 0;
for (const proj of projects) {
  console.log('[build:cs2-plugin]', path.basename(path.dirname(proj)));
  const r = spawnSync(dotnet, ['build', '-c', 'Release', proj], {
    stdio: 'inherit',
    shell: false,
  });
  if (r.status) {
    code = r.status;
    break;
  }
}
process.exit(code || 0);
