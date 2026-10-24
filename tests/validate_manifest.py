"""Check public branding without changing the registered Store product."""
from pathlib import Path
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
NS = {
    "p": "http://schemas.microsoft.com/appx/manifest/foundation/windows10",
    "uap": "http://schemas.microsoft.com/appx/manifest/uap/windows10",
}
manifest = ET.parse(ROOT / "shell/RommForXbox.Shell/Package.appxmanifest").getroot()
identity = manifest.find("p:Identity", NS)
assert identity is not None
assert identity.attrib["Name"] == "MOVEWEIGHT.RomMforXbox", "Store identity changed"
assert identity.attrib["Publisher"] == "CN=6375D74B-5E4F-45B4-B246-B29507C1332A", "Store publisher changed"
assert manifest.find("p:Properties/p:PublisherDisplayName", NS).text == "MOVE WEIGHT"
assert manifest.find("p:Properties/p:DisplayName", NS).text == "Cartridge for Xbox"
app = manifest.find("p:Applications/p:Application", NS)
assert "Executable" in app.attrib and "StartPage" not in app.attrib, "Native shell replaced by hosted package"
visual = app.find("uap:VisualElements", NS)
assert visual.attrib["DisplayName"] == "Cartridge for Xbox"
families = manifest.findall("p:Dependencies/p:TargetDeviceFamily", NS)
assert "Windows.Xbox" in {family.attrib["Name"] for family in families}
assert "<title>Cartridge for Xbox</title>" in (ROOT / "index.html").read_text()
assert "Starting Cartridge for Xbox" in (ROOT / "shell/RommForXbox.Shell/MainPage.xaml").read_text()
assert "9MXC51W17LH4" in (ROOT / "README.md").read_text()

project = ET.parse(ROOT / "shell/RommForXbox.Shell/RommForXbox.Shell.csproj").getroot()
for content in project.findall(".//{http://schemas.microsoft.com/developer/msbuild/2003}Content"):
    source = ROOT / "shell/RommForXbox.Shell" / content.attrib["Include"].replace("\\", "/")
    assert source.is_file(), f"Packaged content is missing: {source}"
print("Manifest, native entry point, visible brand and packaged source files validated")
