"""Private lazymidi service; no PyWebView or public Flask application shell."""
import os
import sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import hmac
import hashlib
import json
import math
import pathlib
import secrets
import shutil
import stat
import threading
import uuid

DATA = pathlib.Path(os.environ["LAZYMIDI_CONVERTER_DATA"]).resolve()
DATA.mkdir(parents=True, exist_ok=True)
os.chdir(DATA)
os.environ["UPLOAD_FOLDER"] = str(DATA / "uploads")
os.environ["CONVERTED_FOLDER"] = str(DATA / "converted")
TOKEN = os.environ.pop("LAZYMIDI_CONVERTER_TOKEN")
EXTENSION_TOKEN = secrets.token_urlsafe(32)
EXTENSION_JOBS = set()
from flask import request, jsonify, abort
from persistence import atomic_json, read_json, validate_settings
import app as upstream

app = upstream.app
app.config["MAX_CONTENT_LENGTH"] = 2 * 1024**3
app.config["WTF_CSRF_ENABLED"] = False
_submission = threading.Lock()
_active = set()
_active_lock = threading.Lock()
_runtime_switching = False
def tracked_job(function):
    def run(task_id, *args, **kwargs):
        with _active_lock: _active.add(task_id)
        try: return function(task_id, *args, **kwargs)
        finally:
            if upstream._is_cancelled(task_id):
                upstream.conversion_tasks[task_id] = {"status":"cancelled","progress":"Cancelled by user"}
            with _active_lock: _active.discard(task_id)
    return run
upstream.run_conversion_task = tracked_job(upstream.run_conversion_task)
upstream.run_file_conversion_task = tracked_job(upstream.run_file_conversion_task)
FINAL = {"completed", "error", "cancelled"}
JSON_ENDPOINTS = {"/api/health", "/api/convert", "/api/history", "/api/history/delete", "/api/settings", "/api/convert-to-sheets", "/api/upload-midi", "/api/import-midi", "/api/upload-media", "/api/midi-files", "/api/sheet-content", "/api/soundfonts", "/api/upload-soundfont", "/api/visualizer-background", "/api/import-data", "/api/extension-health", "/api/runtime-switch"}

@app.before_request
def authenticate():
    origin = request.headers.get("Origin", "")
    extension = origin.startswith(("chrome-extension://", "moz-extension://"))
    if request.path == "/api/extension-connect":
        if origin and not extension: abort(401)
        if request.method == "OPTIONS" and extension: return "", 204
        # Websites cannot send this header without an approved CORS preflight.
        if request.headers.get("X-Lazymidi-Extension") != "1": abort(401)
        if request.method != "GET": abort(405)
        return jsonify(application="lazymidi-converter", protocol=1, token=EXTENSION_TOKEN)
    provided = request.headers.get("X-Lazymidi-Token", "")
    internal = hmac.compare_digest(provided, TOKEN) and not origin
    extension_auth = (extension or not origin) and EXTENSION_TOKEN and hmac.compare_digest(provided, EXTENSION_TOKEN)
    if request.method == "OPTIONS" and extension: return "", 204
    if not internal and not extension_auth: abort(401)
    if extension_auth:
        from flask import g
        g.extension_auth = True
        allowed = request.path in {"/api/convert", "/api/import-midi", "/api/extension-health"} or any(request.path == prefix + job for job in EXTENSION_JOBS for prefix in ("/api/status/", "/api/stop/"))
        if not allowed: abort(403)
    allowed = request.path in JSON_ENDPOINTS or any(request.path.startswith(p) for p in ("/api/status/", "/api/stop/", "/api/midi/", "/converted/", "/soundfonts/", "/visualizer-backgrounds/"))
    if not allowed: abort(404)
    if request.path in {"/api/convert", "/api/upload-media", "/api/import-data"}:
        _submission.acquire()
        from flask import g
        g.submission_lock = True
        if _runtime_switching:
            return jsonify(error="Converter runtime is changing. Try again after setup."), 409
        with _active_lock: active = bool(_active)
        if active or any(t.get("status") not in FINAL for t in list(upstream.conversion_tasks.values())):
            return jsonify(error="A conversion is already running."), 409

@app.after_request
def private_headers(response):
    from flask import g
    if getattr(g, "submission_lock", False): _submission.release()
    origin = request.headers.get("Origin", "")
    if origin.startswith(("chrome-extension://", "moz-extension://")):
        response.headers["Access-Control-Allow-Origin"] = origin
        response.headers["Vary"] = "Origin"
        response.headers["Access-Control-Allow-Headers"] = "Content-Type, X-Lazymidi-Token, X-Lazymidi-Extension"
        response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    else: response.headers.pop("Access-Control-Allow-Origin", None)
    if getattr(g, "extension_auth", False):
        result = response.get_json(silent=True)
        if result and result.get("task_id"): EXTENSION_JOBS.add(result["task_id"])
    response.headers["Cache-Control"] = "no-store"
    return response

@app.route("/api/extension-health")
def extension_health(): return jsonify(status="ok")

@app.route("/api/runtime-switch", methods=["POST"])
def runtime_switch():
    global _runtime_switching
    body = request.get_json(silent=True)
    if not isinstance(body, dict) or type(body.get("prepare")) is not bool:
        abort(400)
    if not _submission.acquire(blocking=False):
        return jsonify(error="A submission is in progress. Try again after it finishes."), 409
    try:
        if body["prepare"]:
            with _active_lock: active = bool(_active)
            if active or any(t.get("status") not in FINAL for t in list(upstream.conversion_tasks.values())):
                return jsonify(error="Finish or cancel the conversion before changing runtime."), 409
            _runtime_switching = True
        else:
            _runtime_switching = False
    finally:
        _submission.release()
    return jsonify(status="ok")

@app.route("/api/extension-connect")
def extension_connect(): abort(401)

@app.route("/api/upload-soundfont", methods=["POST"])
def upload_soundfont():
    upload = request.files.get("file")
    if not upload or pathlib.Path(upload.filename).suffix.lower() != ".sf2": abort(400)
    header=upload.stream.read(12);upload.stream.seek(0)
    if header[:4]!=b"RIFF" or header[8:12]!=b"sfbk": return jsonify(error="Choose a valid SF2 SoundFont."),400
    name = uuid.uuid4().hex + ".sf2"
    upload.save(DATA / "soundfonts" / name)
    return jsonify(filename=name)

def copy_import(source, target):
    """Copy only known data; reject links, never overwrite either installation."""
    def linked(path):
        if path.is_symlink(): return True
        return os.name == "nt" and bool(path.lstat().st_file_attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT)
    def digest(path):
        value = hashlib.sha256()
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024*1024), b""): value.update(chunk)
        return value.hexdigest()
    if linked(pathlib.Path(source)): raise ValueError("Choose a real folder, not a link.")
    source, target = pathlib.Path(source).resolve(), pathlib.Path(target).resolve()
    if not source.is_dir(): raise ValueError("Choose a converter or MIDI folder.")
    if source.name.lower() == "converted": source = source.parent
    if source == target or source in target.parents or target in source.parents: raise ValueError("Choose a separate converter installation.")
    converted = source / "converted"
    if not converted.is_dir(): converted = source
    # Parse metadata before copying so malformed history cannot leave a partial import.
    history_path = source / "history.json"
    history = []
    if history_path.is_file() and not linked(history_path):
        if history_path.stat().st_size > 4*1024**2: raise ValueError("History exceeds 4 MiB.")
        history = json.loads(history_path.read_text(encoding="utf-8-sig"), parse_constant=lambda _: (_ for _ in ()).throw(ValueError("Invalid history number")))
        if not isinstance(history, list) or any(not isinstance(item, dict) for item in history): raise ValueError("Invalid history file.")
        for item in history:
            for key in ("midi_name","video_title","type","thumbnail_url"):
                if key in item and item[key] is not None and not isinstance(item[key],str): raise ValueError("Invalid history entry.")
            timestamp = item.get("timestamp")
            if timestamp is not None and (type(timestamp) not in (int,float) or not math.isfinite(timestamp)): raise ValueError("Invalid history timestamp.")
    settings = source / "settings.json"
    copied_settings = None
    if settings.is_file() and not linked(settings) and not (target / "settings.json").exists():
        if settings.stat().st_size > 1024**2: raise ValueError("Settings exceed 1 MiB.")
        value = json.loads(settings.read_text(encoding="utf-8-sig"))
        if not isinstance(value,dict): raise ValueError("Invalid converter settings.")
        copied_settings = {k:v for k,v in value.items() if "cookie" not in k.lower() and "path" not in k.lower() and not k.startswith("site_")}
        # Local media is validated after remapping below; never retain external paths.
        scenes = copied_settings.get("visualizer_scenes", {})
        if not isinstance(scenes,dict) or any(not isinstance(s,dict) for s in scenes.values()): raise ValueError("Invalid visualizer scenes")
        validate_settings({**copied_settings,"visualizer_scenes":{}})
    result = {"copied":0,"midis":0,"history":0,"skipped":0}
    names = {}
    allowed = {"converted": {".mid", ".midi", ".txt", ".png", ".jpg", ".jpeg", ".webp"}, "soundfonts": {".sf2"}, "visualizer-backgrounds": {".png", ".jpg", ".jpeg", ".webp", ".gif", ".mp4", ".webm", ".mov"}}
    for directory, extensions in allowed.items():
        folder = converted if directory == "converted" else source / directory
        if directory == "visualizer-backgrounds" and not folder.exists(): folder = source / "visualizer_backgrounds"
        if not folder.is_dir() or linked(folder): continue
        destination = target / ("visualizer_backgrounds" if directory == "visualizer-backgrounds" else directory)
        if destination.exists() and linked(destination): raise ValueError("Import destination cannot be a link.")
        for path in folder.iterdir():
            if linked(path) or not path.is_file() or path.suffix.lower() not in extensions: continue
            dest = destination / path.name
            if dest.exists():
                fingerprint = digest(path)
                if linked(dest): raise ValueError("Import destination cannot be a link.")
                if digest(dest) != fingerprint:
                    dest = dest.with_name(dest.stem + "_import_" + fingerprint[:12] + dest.suffix)
                if dest.exists():
                    if linked(dest) or digest(dest) != fingerprint: raise ValueError("Imported filename collision.")
                    names[directory,path.name] = dest.name; result["skipped"] += 1
                    continue
            dest.parent.mkdir(parents=True, exist_ok=True)
            temporary = dest.with_suffix(dest.suffix + ".copying")
            try:
                shutil.copy2(path, temporary); temporary.replace(dest)
            finally:
                temporary.unlink(missing_ok=True)
            names[directory,path.name] = dest.name; result["copied"] += 1
            if directory == "converted" and path.suffix.lower() in {".mid", ".midi"}: result["midis"] += 1
    with upstream.HISTORY_LOCK:
        existing = read_json(target / "history.json", [])
        identities = {(old.get("midi_name"),old.get("timestamp"),old.get("type")) for old in existing}
        for item in history:
            midi = item.get("midi_name")
            if isinstance(midi,str) and ("converted",midi) in names and pathlib.Path(midi).suffix.lower() in {".mid", ".midi"}:
                item = dict(item); item["midi_name"] = names["converted",midi]
                thumbnail = item.get("thumbnail_url", "")
                if isinstance(thumbnail, str) and thumbnail.startswith("/converted/"):
                    filename = thumbnail.removeprefix("/converted/")
                    item["thumbnail_url"] = "/converted/" + names["converted",filename] if ("converted",filename) in names else ""
                identity = (item.get("midi_name"),item.get("timestamp"),item.get("type"))
                if identity not in identities:
                    existing.append(item); identities.add(identity); result["history"] += 1
        if result["history"]: atomic_json(target / "history.json", existing)
    if not names: raise ValueError("No MIDI, sheets or supported converter assets found in this folder.")
    if copied_settings is not None:
        for scene in copied_settings.get("visualizer_scenes", {}).values():
            if scene.get("media_url"):
                name = pathlib.Path(str(scene["media_url"])).name
                scene["media_url"] = "/visualizer-backgrounds/" + names["visualizer-backgrounds",name] if ("visualizer-backgrounds",name) in names else ""
        atomic_json(target / "settings.json", validate_settings(copied_settings))
    return result

@app.route("/api/import-data", methods=["POST"])
def import_data():
    try:
        body = request.get_json(silent=True)
        if not isinstance(body,dict) or not isinstance(body.get("source"),str): raise ValueError("Choose a converter or MIDI folder.")
        return jsonify(copy_import(body["source"], DATA))
    except (OSError, ValueError, KeyError, TypeError) as error: return jsonify(error=str(error)), 400

def create_server():
    from werkzeug.serving import make_server
    ports = [0] if os.environ.get("LAZYMIDI_EXTENSION_PORT") == "0" else [*range(27653,27661),0]
    for port in ports:
        try: return make_server("127.0.0.1", port, app, threaded=True)
        except (OSError, SystemExit):
            if port == 0: raise

if __name__ == "__main__":
    server = create_server()
    atomic_json(pathlib.Path(os.environ["LAZYMIDI_READY_FILE"]), {"port": server.server_port})
    server.serve_forever()
