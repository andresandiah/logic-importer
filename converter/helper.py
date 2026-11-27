#!/usr/bin/env python3
"""Local helper for the Logic Importer Add On.

The Add On is a web page and cannot run the converter itself. This small server does, for it:
  - shows the macOS file and folder pickers
  - runs convert.py on the project picked there
  - hands the resulting import file to the page

Safety: it listens on 127.0.0.1 only, every request needs a secret token that only the
installed Add On's folder holds, the Host header must be local, and the page can never
name a file to read: projects are only ever chosen in a picker on this Mac.
"""
from __future__ import annotations

import argparse
import hmac
import json
import secrets
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
VERSION = "2"
FROZEN = getattr(sys, "frozen", False)
ADDON_ID = "com.logicimporter.addon"
ADDONS_FOLDER = Path("/Library/Application Support/Universal Audio/LUNA/Add Ons")
INSTALL_FOLDER = Path("/Library/Application Support/Logic Importer")
LAUNCH_AGENT = Path("/Library/LaunchAgents/com.logicimporter.helper.plist")
UNINSTALLER = INSTALL_FOLDER / "Uninstall Logic Importer Helper.command"
TOKEN_FILE = Path.home() / "Library/Application Support/Logic Importer/token"


def installation() -> dict | None:
    """Where the installed helper lives, so the Add On can tell the user. None when run from source."""
    if not FROZEN:
        return None
    return {"folder": str(INSTALL_FOLDER), "uninstaller": str(UNINSTALLER), "launchAgent": str(LAUNCH_AGENT)}


def osascript_pick(kind: str) -> str | None:
    """A native picker. Returns a POSIX path, or None when the user cancels."""
    scripts = {
        "project": 'choose file with prompt "Choose your Logic Pro project (.logicx)"',
        "project-folder": 'choose folder with prompt "Choose the folder that holds your Logic Pro project"',
        "session-folder": 'choose folder with prompt "Choose where to save the new LUNA session"',
    }
    # "activate" brings the picker forward without asking to control other apps.
    run = subprocess.run(
        ["osascript", "-e", "activate", "-e", f"POSIX path of ({scripts[kind]})"],
        capture_output=True, text=True, timeout=600)
    if run.returncode != 0:
        if "-128" in run.stderr:  # the user pressed Cancel
            return None
        raise RuntimeError(run.stderr.strip() or "The picker could not be opened.")
    return run.stdout.strip().rstrip("/") or None


def find_project(chosen: Path) -> Path:
    """The .logicx package for a picked package or project folder."""
    if chosen.suffix.lower() == ".logicx" and (chosen / "Alternatives").is_dir():
        return chosen
    if chosen.is_dir():
        found = sorted(p for p in chosen.glob("*.logicx") if (p / "Alternatives").is_dir())
        if len(found) == 1:
            return found[0]
        if len(found) > 1:
            raise ValueError("That folder holds several Logic projects. Use 'Choose project' and pick one.")
    raise ValueError("That is not a Logic Pro project package, and the folder does not hold one.")


class State:
    def __init__(self, picker=osascript_pick, command=None):
        self.picker = picker
        # How to start the converter: the installed helper runs itself.
        self.command = command or ([sys.executable, "convert"] if FROZEN
                                   else [sys.executable, "-u", str(HERE / "convert.py")])
        self.lock = threading.Lock()
        self.picking = threading.Lock()
        self.project: Path | None = None
        self.job = self.idle()

    @staticmethod
    def idle() -> dict:
        return {"status": "idle", "messages": [], "error": None, "exportFolder": None, "file": None}

    def snapshot(self) -> dict:
        with self.lock:
            job = {k: v for k, v in self.job.items() if k != "file"}
            job["messages"] = job["messages"][-8:]
            job["project"] = str(self.project) if self.project else None
            return job

    def pick(self, kind: str) -> dict:
        if not self.picking.acquire(blocking=False):
            raise ValueError("A picker window is already open.")
        try:
            chosen = self.picker(kind)
        finally:
            self.picking.release()
        if chosen is None:
            return {"cancelled": True}
        if kind == "session-folder":
            return {"path": chosen}
        project = find_project(Path(chosen))
        with self.lock:
            if self.job["status"] == "running":
                raise ValueError("An export is still running.")
            self.project, self.job = project, self.idle()
        return {"path": str(project), "name": project.stem,
                "exportFolder": str(project.parent / f"{project.stem} for LUNA")}

    def start(self) -> None:
        with self.lock:
            if self.project is None:
                raise ValueError("Choose a Logic project first.")
            if self.job["status"] == "running":
                raise ValueError("An export is already running.")
            self.job = {**self.idle(), "status": "running", "messages": ["Reading the Logic project"]}
            project = self.project
        threading.Thread(target=self._convert, args=(project,), daemon=True).start()

    def _convert(self, project: Path) -> None:
        out = project.parent / f"{project.stem} for LUNA"
        tail: list[str] = []
        try:
            process = subprocess.Popen(
                [*self.command, str(project), "--out", str(out)],
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
            for line in process.stdout:
                line = line.rstrip()
                if not line:
                    continue
                tail = (tail + [line])[-6:]
                if line.startswith("PROGRESS: "):
                    with self.lock:
                        self.job["messages"].append(line[len("PROGRESS: "):])
            code = process.wait()
            target = out / f"{project.stem}.lunaimport.json"
            with self.lock:
                if code == 0 and target.is_file():
                    self.job.update(status="done", exportFolder=str(out), file=target)
                else:
                    self.job.update(status="failed", error="\n".join(tail) or f"The converter stopped (exit {code}).")
        except Exception as error:  # noqa: BLE001 - shown to the user in the page
            with self.lock:
                self.job.update(status="failed", error=f"{type(error).__name__}: {error}")

    def manifest(self) -> bytes:
        with self.lock:
            target = self.job["file"]
        if target is None:
            raise ValueError("No finished export is available.")
        return target.read_bytes()

    def reveal(self) -> None:
        with self.lock:
            folder = self.job["exportFolder"]
        if not folder:
            raise ValueError("No export folder yet.")
        subprocess.run(["open", folder], check=True)


def make_handler(state: State, token: str, port_of):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):  # keep paths and tokens out of logs
            pass

        def _send(self, code: int, body: bytes = b"", kind: str = "application/json"):
            self.send_response(code)
            # Any origin may ask, but nothing is answered without the token.
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Headers", "X-Importer-Token")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Type", kind)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _json(self, value, code: int = 200):
            self._send(code, json.dumps(value).encode())

        def _local_host(self) -> bool:
            port = port_of()
            return self.headers.get("Host") in (f"127.0.0.1:{port}", f"localhost:{port}")

        def do_OPTIONS(self):
            self._send(204 if self._local_host() else 403)

        def do_GET(self):
            self._route("GET")

        def do_POST(self):
            self._route("POST")

        def _route(self, method: str):
            given = self.headers.get("X-Importer-Token", "")
            if not self._local_host() or not hmac.compare_digest(given.encode(), token.encode()):
                return self._json({"error": "Not allowed."}, 403)
            try:
                route = (method, self.path)
                if route == ("GET", "/status"):
                    return self._json({"version": VERSION, "installation": installation(), **state.snapshot()})
                if method == "POST" and self.path.startswith("/pick/"):
                    kind = self.path[len("/pick/"):]
                    if kind not in ("project", "project-folder", "session-folder"):
                        return self._json({"error": "Unknown picker."}, 404)
                    return self._json(state.pick(kind))
                if route == ("POST", "/export"):
                    state.start()
                    return self._json({"started": True})
                if route == ("GET", "/manifest"):
                    return self._send(200, state.manifest())
                if route == ("POST", "/reveal-export"):
                    state.reveal()
                    return self._json({"ok": True})
                return self._json({"error": "Not found."}, 404)
            except ValueError as error:
                return self._json({"error": str(error)}, 400)
            except Exception as error:  # noqa: BLE001
                return self._json({"error": f"{type(error).__name__}: {error}"}, 500)

    return Handler


def addon_folders(root: Path = ADDONS_FOLDER) -> list[Path]:
    """Installed copies of this Add On, found by the id in their manifest."""
    found = []
    for manifest in sorted(root.glob("*/manifest.json")) if root.is_dir() else []:
        try:
            if json.loads(manifest.read_text()).get("id") == ADDON_ID:
                found.append(manifest.parent)
        except (OSError, ValueError, AttributeError):
            continue
    return found


def stored_token(path: Path = TOKEN_FILE) -> str:
    """This user's token. It outlives reinstalls of the Add On."""
    if path.is_file() and path.read_text().strip():
        return path.read_text().strip()
    path.parent.mkdir(parents=True, exist_ok=True)
    token = secrets.token_urlsafe(32)
    path.touch(mode=0o600)
    path.write_text(token)
    return token


def keep_configured(root: Path, port: int, token: str) -> list[Path]:
    """Give every installed copy of the Add On the address and token. Installing or updating
    the Add On blanks its config, so this is repeated while the helper runs."""
    done = []
    for folder in addon_folders(root):
        target = folder / "helper-config.js"
        try:
            if not target.is_file() or token not in target.read_text() or f'"port": {port}' not in target.read_text():
                write_config(target, port, token)
            done.append(folder)
        except OSError as error:
            print(f"Could not configure the Add On in {folder}: {error}", file=sys.stderr)
    return done


def write_config(path: Path, port: int, token: str | None = None) -> str:
    """The page's copy of the address and token. An existing token is kept across restarts."""
    if token is None and path.is_file():
        text = path.read_text()
        try:
            token = json.loads(text[text.index("{"):text.rindex("}") + 1])["token"]
        except (ValueError, KeyError):
            token = None
    token = token or secrets.token_urlsafe(32)
    path.touch(mode=0o600)
    path.write_text("// Written by the helper. Private to this Mac: do not share.\n"
                    f"window.LOGIC_IMPORTER_HELPER = {json.dumps({'port': port, 'token': token})};\n")
    path.chmod(0o600)  # only this user (LUNA runs as them)
    return token


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--addon", type=Path, help="one Add On folder (default: find installed copies)")
    parser.add_argument("--port", type=int, default=8797)
    args = parser.parse_args()
    token = write_config(args.addon / "helper-config.js", args.port) if args.addon else stored_token()
    try:
        server = ThreadingHTTPServer(("127.0.0.1", args.port),
                                     make_handler(State(), token, lambda: args.port))
    except OSError as error:
        print(f"The helper could not start on port {args.port}: {error}", file=sys.stderr)
        return 1
    print(f"Logic Importer helper is running on 127.0.0.1:{args.port}.", flush=True)
    if not args.addon:
        def watch():
            while True:
                keep_configured(ADDONS_FOLDER, args.port, token)
                time.sleep(3)
        threading.Thread(target=watch, daemon=True).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
