"""Small JSON store shared by the adapted service and upstream handlers."""
import json
import math
import os
import pathlib
import shutil
import tempfile
import threading
import uuid

_lock = threading.RLock()

def atomic_json(path, value):
    path = pathlib.Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with _lock:
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False) as handle:
                temporary = pathlib.Path(handle.name)
                json.dump(value, handle, ensure_ascii=False, allow_nan=False)
                handle.flush(); os.fsync(handle.fileno())
            if path.exists():
                try:
                    json.loads(path.read_text(encoding="utf-8"))
                    shutil.copy2(path, path.with_suffix(path.suffix + ".bak"))
                except (ValueError, UnicodeError):
                    shutil.copy2(path, path.with_name(path.name + ".invalid-" + uuid.uuid4().hex))
            os.replace(temporary, path)
        finally:
            if temporary and temporary.exists(): temporary.unlink()

def read_json(path, default):
    path = pathlib.Path(path)
    with _lock:
        for candidate in (path, path.with_suffix(path.suffix + ".bak")):
            if not candidate.exists(): continue
            try:
                if candidate.stat().st_size > 4 * 1024**2: raise ValueError("JSON file too large")
                value = json.loads(candidate.read_text(encoding="utf-8"), parse_constant=lambda _: (_ for _ in ()).throw(ValueError("Non-finite JSON")))
                if not isinstance(value, type(default)): raise ValueError("Wrong JSON type")
                if candidate != path: atomic_json(path, value)
                return value
            except (OSError, ValueError, TypeError):
                if candidate == path: shutil.copy2(path, path.with_name(path.name + ".invalid-" + uuid.uuid4().hex))
        return default

def validate_settings(value):
    if not isinstance(value, dict) or len(json.dumps(value, allow_nan=False)) > 1024**2:
        raise ValueError("Invalid converter settings")
    value = {key: item for key, item in value.items() if key != "visualizer_hands"}
    ranges = {"quantize": (0,1000), "resilience": (0,100), "break_lines_every": (1,1000), "visualizer_speed": (50,800)}
    for key,(low,high) in ranges.items():
        if key in value and (type(value[key]) not in (int,float) or not math.isfinite(value[key]) or not low <= value[key] <= high):
            raise ValueError(f"Invalid {key}")
    for key,options in {"compute_device": ("cpu","cuda"), "transpose_mode": ("none","auto","multi","manual"), "place_shifted_notes": ("start","end","inorder"), "place_out_of_range_notes": ("start","end","inorder"), "break_lines_how": ("manually","automatically")}.items():
        if key in value and value[key] not in options: raise ValueError(f"Invalid {key}")
    for key in ("show_bpm_changes_as_comments", "show_tempo_timing_marks", "always_open_float"):
        if key in value and type(value[key]) is not bool: raise ValueError(f"Invalid {key}")
    points = value.get("manual_transpose_points", [])
    if not isinstance(points,list) or len(points)>10000 or any(not isinstance(p,dict) or type(p.get("chord")) is not int or p["chord"]<0 or type(p.get("value")) is not int or not -50<=p["value"]<=50 for p in points):
        raise ValueError("Invalid manual transpose points")
    scenes = value.get("visualizer_scenes", {})
    if not isinstance(scenes,dict) or any(not isinstance(s,dict) for s in scenes.values()): raise ValueError("Invalid visualizer scenes")
    for scene in scenes.values():
        url=scene.get("media_url", "")
        if url and (not isinstance(url,str) or not url.startswith(("/visualizer-backgrounds/","http://converter.localhost/","converter://localhost/","https://converter.localhost/")) or ".." in url):
            raise ValueError("Background must be imported into the converter")
    return value
