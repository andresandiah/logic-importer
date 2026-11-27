"""Helper tests: security rules, and a real export of a sample project. Run: see README."""
import json
import shutil
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

import helper

CORPUS = Path(__file__).resolve().parents[1] / ".deps" / "logicxkit" / "tests" / "corpus"


class HelperTest(unittest.TestCase):
    def setUp(self):
        self.folder = Path(tempfile.mkdtemp()).resolve()
        shutil.copytree(CORPUS / "stack-11-summing-resave.logicx", self.folder / "Song.logicx")
        self.choice = str(self.folder / "Song.logicx")
        self.state = helper.State(picker=lambda kind: self.choice)
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), helper.make_handler(self.state, "secret", lambda: self.port))
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        shutil.rmtree(self.folder)

    def call(self, path, method="GET", token="secret", host=None):
        request = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}", method=method)
        if token is not None:
            request.add_header("X-Importer-Token", token)
        if host:
            request.add_header("Host", host)
        try:
            with urllib.request.urlopen(request, timeout=10) as reply:
                return reply.status, json.loads(reply.read() or b"{}")
        except urllib.error.HTTPError as error:
            return error.code, json.loads(error.read() or b"{}")

    def test_refuses_without_the_token(self):
        for token in (None, "", "wrong"):
            self.assertEqual(self.call("/status", token=token)[0], 403)
        self.assertEqual(self.call("/pick/project", "POST", token="wrong")[0], 403)
        self.assertIsNone(self.state.project)

    def test_refuses_a_non_local_host_name(self):
        self.assertEqual(self.call("/status", host="evil.example.com")[0], 403)

    def test_page_cannot_name_a_file(self):
        self.assertEqual(self.call("/manifest?path=/etc/hosts")[0], 404)
        self.assertEqual(self.call("/pick//etc/hosts", "POST")[0], 404)
        self.assertEqual(self.call("/export", "POST")[0], 400)  # nothing was picked

    def test_picks_from_a_project_folder_and_rejects_others(self):
        self.choice = str(self.folder)
        self.assertEqual(self.call("/pick/project-folder", "POST")[1]["name"], "Song")
        self.choice = str(self.folder / "Song.logicx" / "Media")
        self.assertEqual(self.call("/pick/project-folder", "POST")[0], 400)

    def test_cancel(self):
        self.state.picker = lambda kind: None
        self.assertEqual(self.call("/pick/project", "POST")[1], {"cancelled": True})

    def test_exports_a_real_sample_project(self):
        self.call("/pick/project", "POST")
        self.assertEqual(self.call("/export", "POST")[0], 200)
        for _ in range(600):
            status = self.call("/status")[1]
            if status["status"] != "running":
                break
            time.sleep(0.2)
        self.assertEqual(status["status"], "done", status["error"])
        self.assertEqual(status["exportFolder"], str(self.folder / "Song for LUNA"))
        self.assertTrue(any("Reading" in m for m in status["messages"]))
        self.assertEqual(self.call("/manifest")[1]["format"], "logic-to-luna/1")

    def test_failed_export_reports_the_reason(self):
        self.call("/pick/project", "POST")
        shutil.rmtree(self.folder / "Song.logicx" / "Alternatives")
        self.call("/export", "POST")
        for _ in range(300):
            status = self.call("/status")[1]
            if status["status"] != "running":
                break
            time.sleep(0.2)
        self.assertEqual(status["status"], "failed")
        self.assertIn("Not a Logic project", status["error"])

    def test_configures_every_installed_copy_by_id_and_repairs_a_reinstall(self):
        root = self.folder / "Add Ons"
        for name, ident in (("Logic Importer", helper.ADDON_ID), ("Other", "com.example.other")):
            (root / name).mkdir(parents=True)
            (root / name / "manifest.json").write_text(json.dumps({"id": ident}))
        config = root / "Logic Importer" / "helper-config.js"
        self.assertEqual(helper.keep_configured(root, 8797, "tok"), [root / "Logic Importer"])
        self.assertIn('"token": "tok"', config.read_text())
        self.assertFalse((root / "Other" / "helper-config.js").exists())
        config.write_text("window.LOGIC_IMPORTER_HELPER = null;")  # what an Add On update does
        helper.keep_configured(root, 8797, "tok")
        self.assertIn('"token": "tok"', config.read_text())

    def test_user_token_is_private_and_stable(self):
        path = self.folder / "support" / "token"
        self.assertEqual(helper.stored_token(path), helper.stored_token(path))
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_token_survives_a_restart(self):
        config = self.folder / "helper-config.js"
        self.assertEqual(helper.write_config(config, 1), helper.write_config(config, 2))
        self.assertEqual(config.stat().st_mode & 0o777, 0o600)


if __name__ == "__main__":
    unittest.main()
