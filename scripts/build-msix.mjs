// Builds the installable Xbox MSIX for RomM for Xbox: a hosted web app whose
// start page is the deployed play front (https://xbox.moveweight.com/).
// Targets Windows.Xbox + Windows.Universal; sideloads on a Dev Mode console
// and submits to the Microsoft Store for retail.
//
// Usage: node scripts/build-msix.mjs
//   env ROMM_XBOX_START_PAGE  override start page
//   env ROMM_XBOX_SIGN_PFX / ROMM_XBOX_SIGN_PWD  sign the output with signtool
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

const VERSION = '0.1.0.0';
const START_PAGE = process.env.ROMM_XBOX_START_PAGE ?? 'https://xbox.moveweight.com/';
const HOSTS = ['https://xbox.moveweight.com/', 'https://romm.moveweight.com/'];
const IDENTITY = {
  name: 'MOVEWEIGHT.RomMforXbox',
  publisher: 'CN=6375D74B-5E4F-45B4-B246-B29507C1332A',
  publisherDisplayName: 'MOVE WEIGHT',
};

function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit' });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${cmd} exited ${r.status}`);
}

rmSync(stage, { recursive: true, force: true });
mkdirSync(resolve(stage, 'Assets'), { recursive: true });
for (const icon of ['StoreLogo.png', 'Square44x44Logo.png', 'Square150x150Logo.png', 'Square310x310Logo.png']) {
  copyFileSync(resolve(root, 'msix', 'Assets', icon), resolve(stage, 'Assets', icon));
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
    <Description>Play your RomM retro game library on Xbox.</Description>
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
        Description="Play your RomM retro game library on Xbox."
        Square150x150Logo="Assets\\Square150x150Logo.png"
        Square44x44Logo="Assets\\Square44x44Logo.png"
        BackgroundColor="transparent">
        <uap:DefaultTile Wide310x150Logo="Assets\\Square310x310Logo.png"
          Square310x310Logo="Assets\\Square310x310Logo.png" />
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
