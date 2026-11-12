"""Checks the in-app installer boundary, dependency sources and cleanup without downloads."""
import importlib.util
import pathlib
import stat
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("install_runtime", pathlib.Path(__file__).with_name("install_runtime.py"))
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class RuntimeInstallTests(unittest.TestCase):
    def test_rejects_a_system_interpreter(self):
        with tempfile.TemporaryDirectory() as folder:
            stage = pathlib.Path(folder)
            with self.assertRaisesRegex(ValueError, "private Python"):
                installer.install(stage, stage, "cpu")
            self.assertFalse((stage / "setup-temp").exists())

    def test_installs_in_private_directory_and_cleans_build_files(self):
        for variant in ("cpu", "cuda"):
            with self.subTest(variant=variant), tempfile.TemporaryDirectory() as folder:
                stage = pathlib.Path(folder)
                python = stage / "python/python.exe"
                tools = stage / "bundled"
                tools.mkdir()
                (tools / "ncls-0.0.71-cp311-cp311-win_amd64.whl").touch()
                (tools / "licenses").mkdir()
                for tool in ("ffmpeg.exe", "ffprobe.exe"):
                    (tools / tool).write_bytes(b"tool")
                fake = types.SimpleNamespace(stdout="music21==9.7.1\n")
                with patch.object(sys, "executable", str(python)), patch.object(sys, "version_info", (3, 11)), patch.object(sys, "platform", "win32"), patch.object(installer.subprocess, "run", return_value=fake) as run:
                    installer.install(stage, tools, variant)
                calls = [call.args[0] for call in run.call_args_list]
                self.assertTrue(all(call[0] == str(python) for call in calls))
                installs = [call for call in calls if "install" in call]
                self.assertTrue(all("--isolated" in call and "--no-cache-dir" in call and "--no-compile" in call for call in installs))
                torch = next(call for call in installs if any(arg.startswith("torch==") for arg in call))
                self.assertIn("https://download.pytorch.org/whl/" + ("cu128" if variant == "cuda" else "cpu"), torch)
                self.assertTrue(any("music21==9.7.1" in call and "chardet==5.2.0" in call for call in installs))
                self.assertTrue(all(call.kwargs["env"]["TMP"] == str(stage / "setup-temp") for call in run.call_args_list))
                self.assertFalse((stage / "setup-temp").exists())
                self.assertTrue((stage / "ffmpeg/ffmpeg.exe").is_file())
                self.assertEqual((stage / "requirements-lock.txt").read_text(), fake.stdout)

    @unittest.skipUnless(sys.platform == "darwin", "requires macOS download quarantine")
    def test_bundled_tools_do_not_inherit_download_quarantine(self):
        with tempfile.TemporaryDirectory() as folder:
            stage = pathlib.Path(folder)
            tools = stage / "bundled"
            tools.mkdir()
            (tools / "ncls-0.0.71-test.whl").touch()
            (tools / "licenses").mkdir()
            quarantine = "0083;00000000;Safari;00000000-0000-0000-0000-000000000000"
            for name in ("ffmpeg", "ffprobe"):
                (tools / name).write_bytes(b"bundled executable")
                subprocess.run(["/usr/bin/xattr", "-w", "com.apple.quarantine", quarantine,
                                str(tools / name)], check=True)
            with patch.object(sys, "executable", str(stage / "python/bin/python3")), patch.object(sys, "version_info", (3, 11)), patch.object(installer.subprocess, "run", return_value=types.SimpleNamespace(stdout="")):
                installer.install(stage, tools, "cpu")
            for name in ("ffmpeg", "ffprobe"):
                with self.subTest(tool=name):
                    installed = stage / "ffmpeg" / name
                    attributes = subprocess.check_output(["/usr/bin/xattr", str(installed)], text=True)
                    self.assertNotIn("com.apple.quarantine", attributes.splitlines())
                    self.assertEqual(installed.read_bytes(), (tools / name).read_bytes())
                    self.assertEqual(stat.S_IMODE(installed.stat().st_mode), 0o755)
                    self.assertEqual(subprocess.check_output(
                        ["/usr/bin/xattr", "-p", "com.apple.quarantine", str(tools / name)],
                        text=True).strip(), quarantine)

    def test_dependency_failure_removes_build_directory(self):
        with tempfile.TemporaryDirectory() as folder:
            stage = pathlib.Path(folder)
            python = stage / ("python/python.exe" if sys.platform == "win32" else "python/bin/python3")
            (stage / "ncls-0.0.71-test.whl").touch()
            with patch.object(sys, "executable", str(python)), patch.object(sys, "version_info", (3, 11)), patch.object(installer.subprocess, "run", side_effect=RuntimeError("download failed")):
                with self.assertRaisesRegex(RuntimeError, "download failed"):
                    installer.install(stage, stage, "cpu")
            self.assertFalse((stage / "setup-temp").exists())


if __name__ == "__main__":
    unittest.main()
