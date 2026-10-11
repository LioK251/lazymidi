import pathlib
import sys
import tempfile
import types
import unittest
from unittest.mock import patch, Mock

sys.path.insert(0, str(pathlib.Path(__file__).parent))
import check_environment as probe


class EnvironmentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        pretrained = self.root / "pretrained"
        pretrained.mkdir()
        for name in ("2.0.pt", "2.0.conf", "ffmpeg.exe", "ffprobe.exe"):
            (pretrained / name).write_bytes(b"test")
        self.torch = types.SimpleNamespace(__version__="test", version=types.SimpleNamespace(cuda=None),
                                           cuda=types.SimpleNamespace(is_available=lambda: True),
                                           zeros=Mock(return_value=Mock()))
        modules = {"torch": self.torch, "transkun": types.SimpleNamespace(__file__=str(self.root / "__init__.py")),
                   "moduleconf": types.SimpleNamespace(parseFromFile=Mock())}
        for context in (patch.dict(sys.modules, modules), patch.object(probe.importlib, "import_module"),
                        patch.object(probe.shutil, "which", side_effect=lambda name: str(pretrained / (name + ".exe"))),
                        patch.object(probe.subprocess, "run", side_effect=lambda args, **_: types.SimpleNamespace(returncode=0, stdout=pathlib.Path(args[0]).stem + " version test"))):
            context.start(); self.addCleanup(context.stop)

    def test_cpu_and_cuda_and_unavailable_gpu(self):
        self.assertFalse(probe.check()["cuda_available"])
        self.torch.version.cuda = "12.8"
        self.assertTrue(probe.check()["cuda_available"])
        self.torch.zeros.assert_called_once_with(1, device="cuda")
        self.torch.zeros.side_effect = RuntimeError("Driver unavailable")
        result = probe.check()
        self.assertFalse(result["cuda_available"])
        self.assertIn("Driver unavailable", result["cuda_error"])

    def test_missing_dependency_and_model(self):
        probe.importlib.import_module.side_effect = ImportError("missing dependency")
        with self.assertRaisesRegex(ValueError, "Cannot load flask"):
            probe.check()
        probe.importlib.import_module.side_effect = None
        (self.root / "pretrained/2.0.pt").unlink()
        with self.assertRaisesRegex(ValueError, "model file is missing"):
            probe.check()

    def test_missing_or_broken_ffmpeg(self):
        probe.shutil.which.side_effect = None
        probe.shutil.which.return_value = None
        with self.assertRaisesRegex(ValueError, "ffmpeg not found"):
            probe.check()
        probe.shutil.which.return_value = str(self.root / "ffmpeg.exe")
        probe.subprocess.run.side_effect = None
        probe.subprocess.run.return_value = types.SimpleNamespace(returncode=1, stdout="")
        with self.assertRaisesRegex(ValueError, "ffmpeg could not run"):
            probe.check()


if __name__ == "__main__":
    unittest.main()
