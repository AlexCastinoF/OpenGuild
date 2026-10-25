/**
 * Embute ícone e metadados no .exe sem assinatura de código.
 */
const path = require('path');
const fs = require('fs');

/** @param {import('app-builder-lib').AfterPackContext} context */
exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;

  const pkg = require('../package.json');
  const productName = context.packager.appInfo.productFilename;
  const exePath = path.join(context.appOutDir, `${productName}.exe`);
  const iconPath = path.join(__dirname, '..', 'assets', 'icon.ico');
  if (!fs.existsSync(exePath) || !fs.existsSync(iconPath)) return;

  try {
    const { rcedit } = await import('rcedit');
    await rcedit(exePath, {
      icon: iconPath,
      'product-version': pkg.version,
      'file-version': pkg.version,
      'version-string': {
        ProductName: productName,
        FileDescription: productName,
        CompanyName: 'SteamFarm',
        LegalCopyright: 'SteamFarm Comunidade',
      },
    });
    console.log('Ícone embutido em', exePath);
  } catch (err) {
    console.warn('after-pack: rcedit indisponível, seguindo sem embutir ícone:', err?.message || err);
  }
};
