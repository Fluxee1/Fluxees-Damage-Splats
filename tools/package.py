"""Build deterministic, allowlisted Foundry release assets with the standard library."""
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import zipfile

ROOT = Path(__file__).resolve().parents[1]
REPOSITORY = "https://github.com/Fluxee1/Fluxees-Damage-Splats"
MODULE_ID = "rs-damage-splats"
RUNTIME_FILES = (
    "scripts/rs-damage-splats.js",
    "styles/rs-damage-splats.css",
    "templates/damage-type-styles-config.html",
)
PACKAGE_FILES = ("module.json", "README.md", *RUNTIME_FILES)


def checked_file(root, name):
    """Reject traversal and symlinks, including symlinked parent directories."""
    relative = PurePosixPath(name)
    if (not name or relative.is_absolute() or ".." in relative.parts
            or "\\" in name or relative.as_posix() != name):
        raise ValueError(f"Unsafe package path: {name}")
    path = root
    for part in relative.parts:
        path = path / part
        if path.is_symlink():
            raise ValueError(f"Symlink is not a public package file: {name}")
    if not path.is_file():
        raise ValueError(f"Missing package file: {name}")
    return path


def validate(root):
    manifest = json.loads(checked_file(root, "module.json").read_text(encoding="utf-8"))
    if manifest.get("id") != MODULE_ID:
        raise ValueError("Module ID must preserve existing settings and asset paths")
    if not re.fullmatch(r"\d+\.\d+\.\d+", manifest.get("version", "")):
        raise ValueError("Expected a three-part release version")
    if manifest.get("manifest") != f"{REPOSITORY}/releases/latest/download/module.json":
        raise ValueError("Manifest must be the downloadable latest-release JSON")
    expected = f"{REPOSITORY}/releases/download/{manifest['version']}-Release/{MODULE_ID}.zip"
    if manifest.get("download") != expected:
        raise ValueError("Download URL must match the manifest version and release asset")
    if manifest.get("compatibility") != {"minimum": "11", "verified": "13"}:
        raise ValueError("Packaging must preserve the existing Foundry compatibility")
    if manifest.get("esmodules") != [RUNTIME_FILES[0]] or manifest.get("styles") != [RUNTIME_FILES[1]]:
        raise ValueError("Manifest entry points must match the reviewed runtime files")
    for name in PACKAGE_FILES:
        checked_file(root, name)
    return manifest


def public_assets(root):
    allowlist = json.loads(checked_file(root, "tools/public-assets.json").read_text(encoding="utf-8"))
    assets = allowlist["assets"]
    if not assets:
        raise ValueError("The public asset allowlist must not be empty")
    for name, expected in assets.items():
        if not name.startswith("assets/") or not re.fullmatch(r"[0-9a-f]{64}", expected):
            raise ValueError(f"Invalid public asset entry: {name}")
        path = checked_file(root, name)
        if hashlib.sha256(path.read_bytes()).hexdigest() != expected:
            raise ValueError(f"Public asset differs from reviewed GitHub content: {name}")
    return tuple(assets)


def validate_references(root, names):
    """Keep the default images, fonts, sounds, and template in the installation."""
    script = (root / RUNTIME_FILES[0]).read_text(encoding="utf-8")
    style = (root / RUNTIME_FILES[1]).read_text(encoding="utf-8")
    references = set(re.findall(r'modules/rs-damage-splats/([^"\s]+)', script))
    references.update(re.findall(r'modules/\$\{MODULE_ID\}/([^`\s]+)', script))
    references.update(re.findall(r'url\(["\']\.\./([^"\']+)["\']\)', style))
    missing = references - set(names)
    if missing:
        raise ValueError(f"Runtime references files missing from package: {sorted(missing)}")


def build(root=ROOT):
    root = Path(root)
    manifest = validate(root)
    names = (*PACKAGE_FILES, *public_assets(root))
    validate_references(root, names)
    # Read only these reviewed files; never glob runtime directories or assets.
    contents = {name: checked_file(root, name).read_bytes() for name in names}
    output = root / "dist"
    if output.is_symlink():
        raise ValueError("Release output must not be a symlink")
    output.mkdir(exist_ok=True)
    archive = output / f"{MODULE_ID}.zip"
    for path in (archive, output / "module.json"):
        if path.is_symlink():
            raise ValueError("Release output file must not be a symlink")
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as package:
        for name, data in sorted(contents.items()):
            entry = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            entry.create_system = 3
            entry.external_attr = 0o100644 << 16
            entry.compress_type = zipfile.ZIP_DEFLATED
            package.writestr(entry, data)
    with zipfile.ZipFile(archive) as package:
        if package.testzip() is not None or set(package.namelist()) != set(names):
            raise ValueError("Invalid release archive")
        if any(package.read(name) != data for name, data in contents.items()):
            raise ValueError("Release archive differs from reviewed input")
    (output / "module.json").write_bytes(contents["module.json"])
    print(f"Built {archive} ({len(names)} files), version {manifest['version']}")
    return archive


if __name__ == "__main__":
    build()
