import functools
import http.server
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import tempfile
import threading
import unittest
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("package", ROOT / "tools/package.py")
package = importlib.util.module_from_spec(spec)
spec.loader.exec_module(package)


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


class PackageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "source"
        shutil.copytree(ROOT, self.root, ignore=shutil.ignore_patterns(".git", "dist", "__pycache__"))

    def edit_manifest(self, **changes):
        path = self.root / "module.json"
        manifest = json.loads(path.read_text())
        manifest.update(changes)
        path.write_text(json.dumps(manifest))

    def test_download_and_extract_installable_package(self):
        archive = package.build(self.root)
        handler = functools.partial(QuietHandler, directory=str(archive.parent))
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            base = f"http://127.0.0.1:{server.server_port}"
            with urllib.request.urlopen(f"{base}/module.json") as response:
                manifest = json.load(response)
            with urllib.request.urlopen(f"{base}/{manifest['download'].rsplit('/', 1)[1]}") as response:
                data = response.read()
            target = Path(self.temp.name) / "Data/modules" / manifest["id"]
            with zipfile.ZipFile(io.BytesIO(data)) as downloaded:
                self.assertEqual(len(downloaded.namelist()), len(set(downloaded.namelist())))
                self.assertIn("module.json", downloaded.namelist())
                downloaded.extractall(target)
            self.assertEqual(package.validate(target), manifest)
            for name in (*package.PACKAGE_FILES, *package.public_assets(self.root)):
                self.assertEqual((self.root / name).read_bytes(), (target / name).read_bytes())
            for name in ("tools", "tests", ".git", ".gitignore", ".gitattributes", ".github", "assets/.gitkeep"):
                self.assertFalse((target / name).exists())
            self.assertEqual(manifest["compatibility"], {"minimum": "11", "verified": "13"})
            self.assertEqual(manifest["relationships"]["requires"][0]["id"], "socketlib")
        finally:
            server.shutdown()
            thread.join()
            server.server_close()

    def test_archive_is_reproducible(self):
        first = package.build(self.root).read_bytes()
        for name in (*package.PACKAGE_FILES, *package.public_assets(self.root)):
            os.utime(self.root / name, (1000000000, 1000000000))
        self.assertEqual(first, package.build(self.root).read_bytes())

    def test_reject_missing_runtime_or_documentation(self):
        for name in package.PACKAGE_FILES[1:]:
            with self.subTest(name=name):
                path = self.root / name
                original = path.read_bytes()
                path.unlink()
                try:
                    with self.assertRaisesRegex(ValueError, "Missing package file"):
                        package.build(self.root)
                finally:
                    path.write_bytes(original)

    def test_reject_version_download_mismatch(self):
        self.edit_manifest(version="1.1.2")
        with self.assertRaisesRegex(ValueError, "Download URL must match"):
            package.build(self.root)

    def test_reject_html_manifest(self):
        self.edit_manifest(manifest=package.REPOSITORY + "/blob/main/module.json")
        with self.assertRaisesRegex(ValueError, "downloadable latest-release JSON"):
            package.build(self.root)

    def test_reject_mutable_branch_download(self):
        self.edit_manifest(download=package.REPOSITORY + "/archive/refs/heads/main.zip")
        with self.assertRaisesRegex(ValueError, "Download URL must match"):
            package.build(self.root)

    def test_reject_changed_module_identity(self):
        self.edit_manifest(id="new-module")
        with self.assertRaisesRegex(ValueError, "Module ID must preserve"):
            package.build(self.root)

    def test_reject_unreviewed_entry_point(self):
        self.edit_manifest(esmodules=["scripts/private.js"])
        with self.assertRaisesRegex(ValueError, "reviewed runtime files"):
            package.build(self.root)

    def test_reject_unverified_compatibility_change(self):
        self.edit_manifest(compatibility={"minimum": "11", "verified": "14"})
        with self.assertRaisesRegex(ValueError, "preserve the existing Foundry compatibility"):
            package.build(self.root)

    def test_exclude_unlisted_files_in_every_directory(self):
        for name in ("assets/private.webp", "assets/private.ogg", "assets/private.ttf",
                     "scripts/private.js", "templates/private.html", "styles/private.css",
                     ".env", "private-config.json"):
            (self.root / name).write_bytes(b"PRIVATE TEST CONTENT")
        with zipfile.ZipFile(package.build(self.root)) as archive:
            self.assertFalse(any(b"PRIVATE TEST CONTENT" in archive.read(name)
                                 for name in archive.namelist()))
            self.assertEqual(set(archive.namelist()),
                             {*package.PACKAGE_FILES, *package.public_assets(self.root)})

    def test_reject_changed_public_asset(self):
        (self.root / "assets/regularsplat.webp").write_bytes(b"PRIVATE REPLACEMENT")
        with self.assertRaisesRegex(ValueError, "differs from reviewed GitHub content"):
            package.build(self.root)

    def test_reject_missing_public_asset(self):
        (self.root / "assets/runescape_uf.ttf").unlink()
        with self.assertRaisesRegex(ValueError, "Missing package file"):
            package.build(self.root)

    def test_reject_traversal_in_asset_allowlist(self):
        path = self.root / "tools/public-assets.json"
        data = json.loads(path.read_text())
        data["assets"]["assets/../../secret.webp"] = "0" * 64
        path.write_text(json.dumps(data))
        with self.assertRaisesRegex(ValueError, "Unsafe package path"):
            package.build(self.root)

    def test_reject_symlinked_files_and_directories(self):
        for name in ("README.md", "scripts", "assets", "tools/public-assets.json"):
            with self.subTest(name=name):
                path = self.root / name
                saved = Path(self.temp.name) / "saved"
                path.rename(saved)
                path.symlink_to(saved, target_is_directory=saved.is_dir())
                try:
                    with self.assertRaisesRegex(ValueError, "Symlink is not a public package file"):
                        package.build(self.root)
                finally:
                    path.unlink()
                    saved.rename(path)

    def test_reject_missing_runtime_asset_reference(self):
        path = self.root / package.RUNTIME_FILES[0]
        path.write_text(path.read_text() + '\nconst missing = "modules/rs-damage-splats/assets/missing.webp";\n')
        with self.assertRaisesRegex(ValueError, "Runtime references files missing"):
            package.build(self.root)

    def test_reject_symlinked_output(self):
        (self.root / "dist").symlink_to(Path(self.temp.name), target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "Release output must not be a symlink"):
            package.build(self.root)


if __name__ == "__main__":
    unittest.main()
