// Builds the installable Xbox MSIX for RomM for Xbox.
//
// This is a *hosted web app*: the package carries only the manifest and tile
// art, and the start page is the deployed front at https://xbox.moveweight.com/.
// That is the shape already registered in Partner Center for product
// 9MXC51W17LH4, so an update keeps it.
//
// Read docs/xbox-store-status.md before changing the app model — on console a
// hosted web app runs on the deprecated EdgeHTML engine, which is the open
// question about whether EmulatorJS can run inside the packaged app (the Xbox
// Edge *browser* is Chromium and is unaffected).
//
// Usage: node scripts/build-msix.mjs
//   env ROMM_XBOX_START_PAGE  override start page
//   env ROMM_XBOX_SIGN_PFX / ROMM_XBOX_SIGN_PWD  sign the output with signtool
//   env WIN_SDK_BIN           override the Windows SDK bin directory
// Output: dist/RommForXbox_<version>_neutral.msix

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');
const stage = resolve(dist, 'stage');
const sdk = process.env.WIN_SDK_BIN ?? 'C:\\Program Files (x86)\\Windows Kits\\10\\bin\\10.0.22621.0\\x64';
const makeAppx = resolve(sdk, 'makeappx.exe');
const makePri = resolve(sdk, 'makepri.exe');
const signTool = resolve(sdk, 'signtool.exe');

const VERSION = '0.2.0.0';
const START_PAGE = process.env.ROMM_XBOX_START_PAGE ?? 'https://xbox.moveweight.com/';
const HOSTS = ['https://xbox.moveweight.com/', 'https://romm.moveweight.com/'];
const IDENTITY = {
  name: 'MOVEWEIGHT.RomMforXbox',
  publisher: 'CN=6375D74B-5E4F-45B4-B246-B29507C1332A',
  publisherDisplayName: 'MOVE WEIGHT',
};

// Every tile Windows and the Xbox shell ask for. A missing SplashScreen is the
// one that bites: the app launches to a black rectangle without it.
const ASSETS = [
  'StoreLogo.png',
  'Square44x44Logo.png',
  'Square71x71Logo.png',
  'Square150x150Logo.png',
  'Square310x310Logo.png',
  'Wide310x150Logo.png',
  'Square480x480Logo.png',
  'SplashScreen.png',
];

function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit' });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${cmd} exited ${r.status}`);
}

if (!existsSync(makeAppx)) {
  throw new Error(`makeappx.exe not found at ${makeAppx} — set WIN_SDK_BIN`);
}

rmSync(stage, { recursive: true, force: true });
mkdirSync(resolve(stage, 'Assets'), { recursive: true });
for (const icon of ASSETS) {
  const src = resolve(root, 'msix', 'Assets', icon);
  if (!existsSync(src)) {
    throw new Error(`missing ${icon} — run: python scripts/make-assets.py`);
  }
  copyFileSync(src, resolve(stage, 'Assets', icon));
}

const rules = HOSTS.map(
  (h) => `      <uap:Rule Type="include" Match="${h}*" WindowsRuntimeAccess="none" />`,
).join('\n');

writeFileSync(resolve(stage, 'AppxManifest.xml'), `<?xml version="1.0" encoding="utf-8"?>
<Package
  xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
  xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
  IgnorableNamespaces="uap">
  <Identity Name="${IDENTITY.name}" Publisher="${IDENTITY.publisher}"
    Version="${VERSION}" ProcessorArchitecture="neutral" />
  <Properties>
    <DisplayName>RomM for Xbox</DisplayName>
    <PublisherDisplayName>${IDENTITY.publisherDisplayName}</PublisherDisplayName>
    <Description>Play your own self-hosted RomM retro game library on Xbox with the controller.</Description>
    <Logo>Assets\\StoreLogo.png</Logo>
  </Properties>
  <Resources><Resource Language="en-us" /></Resources>
  <Dependencies>
    <TargetDeviceFamily Name="Windows.Xbox" MinVersion="10.0.19041.0" MaxVersionTested="10.0.26200.0" />
    <TargetDeviceFamily Name="Windows.Universal" MinVersion="10.0.19041.0" MaxVersionTested="10.0.26200.0" />
  </Dependencies>
  <Capabilities><Capability Name="internetClient" /></Capabilities>
  <Applications>
    <Application Id="App" StartPage="${START_PAGE}">
      <uap:VisualElements DisplayName="RomM for Xbox"
        Description="Play your own self-hosted RomM retro game library on Xbox with the controller."
        Square150x150Logo="Assets\\Square150x150Logo.png"
        Square44x44Logo="Assets\\Square44x44Logo.png"
        BackgroundColor="#0B1020">
        <uap:DefaultTile ShortName="RomM"
          Square71x71Logo="Assets\\Square71x71Logo.png"
          Square310x310Logo="Assets\\Square310x310Logo.png"
          Wide310x150Logo="Assets\\Wide310x150Logo.png">
          <uap:ShowNameOnTiles>
            <uap:ShowOn Tile="square150x150Logo" />
            <uap:ShowOn Tile="wide310x150Logo" />
          </uap:ShowNameOnTiles>
        </uap:DefaultTile>
        <uap:SplashScreen Image="Assets\\SplashScreen.png" BackgroundColor="#0B1020" />
      </uap:VisualElements>
      <uap:ApplicationContentUriRules>
${rules}
      </uap:ApplicationContentUriRules>
    </Application>
  </Applications>
</Package>
`, 'utf8');

const pri = resolve(stage, 'priconfig.xml');
run(makePri, ['createconfig', '/cf', pri, '/dq', 'en-US', '/o']);
run(makePri, ['new', '/pr', stage, '/cf', pri, '/of', resolve(stage, 'resources.pri'), '/o']);
rmSync(pri, { force: true });

const out = resolve(dist, `RommForXbox_${VERSION}_neutral.msix`);
rmSync(out, { force: true });
run(makeAppx, ['pack', '/o', '/h', 'SHA256', '/d', stage, '/p', out]);

if (process.env.ROMM_XBOX_SIGN_PFX) {
  run(signTool, ['sign', '/fd', 'SHA256', '/f', process.env.ROMM_XBOX_SIGN_PFX,
    '/p', process.env.ROMM_XBOX_SIGN_PWD ?? '', out]);
  console.log('signed');
}
console.log(`MSIX ready: ${out}`);
