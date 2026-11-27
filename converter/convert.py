#!/usr/bin/env python3
"""Turn a Logic Pro project (.logicx) into an import file for the LUNA Add On.

The Logic project is only read. Output: <out>/<name>.lunaimport.json and <out>/audio/.
Ticks are written in LUNA units with bar 1 at tick 0.
"""
from __future__ import annotations

import argparse
import json
import plistlib
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

# In the installed helper (PyInstaller) the settings reader is bundled beside the code.
FROZEN = getattr(sys, "frozen", False)
ROOT = Path(__file__).resolve().parent.parent
AUSTATE = Path(sys._MEIPASS) / "austate" if FROZEN else ROOT / "build" / "austate"

from logicxkit.au.services.embed import find_au_plists
from logicxkit.logicx import first_alternative
from logicxkit.logic.services.arrange.stacks import read_stacks, read_tracks, stack_parents
from logicxkit.logic.services.midi.midi import read_midi
from logicxkit.logic.services.mixer import binding, levels, plugins, sends, slots, transplant
from logicxkit.logic.services.project.project import channel_natives, project_metadata
from logicxkit.logic.services.regions.audio_regions import read_audio_regions
from logicxkit.logic.services.regions.automation import read_automation
from logicxkit.logic.services.song import markers, signature, tempo
from logicxkit.logic.services.stream.stream import HEADER

FORMAT = "logic-to-luna/1"
LOGIC_BAR_ONE = 38400
LUNA_PER_LOGIC_TICK = 100_000_000  # LUNA 96e9 per quarter note, Logic 960
LOGIC_PPQ = 960
SILENCE_DB = -144.0
TESTED_VERSIONS = ("12.3.1", "12.4", "13.0")


def luna_tick(logic_tick: float) -> int:
    return round((logic_tick - LOGIC_BAR_ONE) * LUNA_PER_LOGIC_TICK)


def fader_db(position: float) -> float:
    db = levels.position_db(position)
    return SILENCE_DB if db is None else round(db, 3)


def pan_unit(position: float) -> float:
    """Logic's 0..127 (64 centre) as -1..1."""
    offset = position - 64
    return round(max(-1.0, min(1.0, offset / (64 if offset < 0 else 63))), 5)


COMPONENT_FOLDERS = (Path("/Library/Audio/Plug-Ins/Components"), Path.home() / "Library/Audio/Plug-Ins/Components")


def uadx_luna_ids() -> dict[tuple[str, str, str], str]:
    """UADx (native) Audio Units -> LUNA's id for the same plug-in. LUNA's id is the component
    bundle's own name (uaudio_la3a.component -> uaudio_la3a), so nothing is matched by title."""
    out = {}
    for folder in COMPONENT_FOLDERS:
        for bundle in folder.glob("uaudio_*.component"):
            try:
                info = plistlib.loads((bundle / "Contents" / "Info.plist").read_bytes())
                for c in info.get("AudioComponents", []):
                    out[c["type"], c["subtype"], c["manufacturer"]] = bundle.stem
            except (OSError, KeyError, plistlib.InvalidFileException):
                continue
    return out


def luna_ids(component: tuple[str, str, str], uadx: dict) -> list[str]:
    kind, subtype, maker = component
    if maker == "UADx":
        return [uadx[component]] if component in uadx else []
    return [f"com.{maker}.au.{kind}_{subtype}"]


def region_gain_db(raw: int, version: str) -> float | None:
    """A region's Gain in dB, or None when the reader's number cannot be trusted.

    Logic 12.3.1 / 12.4: logicxkit measured the number as whole dB.
    Logic 13.0: it reads ten times too large. Confirmed in Logic's Region inspector on a real
    project (reader -150, Logic -15 dB). Only whole-dB results (multiples of 10) are covered.
    """
    if not raw:
        return 0
    if "13.0" in version:
        return raw // 10 if raw % 10 == 0 and abs(raw) <= 300 else None
    if any(v in version for v in ("12.3.1", "12.4")):
        return raw if abs(raw) <= 30 else None
    return None


def progress(text: str) -> None:
    """A line the helper shows in the Add On."""
    print(f"PROGRESS: {text}", flush=True)


class TempoMap:
    """Seconds <-> Logic ticks. Tempo is treated as stepped between events."""

    def __init__(self, events: list[tuple[int, float]]):
        self.events = sorted(events) or [(LOGIC_BAR_ONE, 120.0)]
        self.starts = [0.0]
        for (t0, bpm), (t1, _) in zip(self.events, self.events[1:]):
            self.starts.append(self.starts[-1] + (t1 - t0) * 60 / (bpm * LOGIC_PPQ))

    def _segment(self, tick: float) -> int:
        i = 0
        while i + 1 < len(self.events) and self.events[i + 1][0] <= tick:
            i += 1
        return i

    def seconds(self, tick: float) -> float:
        i = self._segment(tick)
        t0, bpm = self.events[i]
        return self.starts[i] + (tick - t0) * 60 / (bpm * LOGIC_PPQ)

    def tick(self, seconds: float) -> float:
        i = 0
        while i + 1 < len(self.starts) and self.starts[i + 1] <= seconds:
            i += 1
        t0, bpm = self.events[i]
        return t0 + (seconds - self.starts[i]) * bpm * LOGIC_PPQ / 60


class Converter:
    def __init__(self, project: Path, out: Path, austate: Path | None):
        self.project, self.out, self.austate = project, out, austate
        alternatives = sorted(p.name for p in (project / "Alternatives").iterdir() if p.is_dir())
        self.alternative = first_alternative(project)
        self.data = (project / "Alternatives" / self.alternative / "ProjectData").read_bytes()
        self.meta = project_metadata(project, self.alternative)
        self.notes: list[dict] = []
        self.copied: dict[Path, str] = {}
        if len(alternatives) > 1:
            self.note("not_transferred", None, "Project alternatives",
                      f"The project has {len(alternatives)} alternatives; only {self.alternative} was read.")
        version = str(self.meta.get("logic_version") or "unknown")
        if not any(v in version for v in TESTED_VERSIONS):
            self.note("warning", None, "Logic version",
                      f"Saved by {version}. The project reader was not verified on this version.")

    def note(self, status: str, channel: str | None, item: str, detail: str) -> None:
        """status: approximated | not_transferred | warning"""
        row = {"status": status, "channel": channel, "item": item, "detail": detail}
        if row not in self.notes:
            self.notes.append(row)

    def attempt(self, what: str, default, fn, *args):
        """A reader that fails must show up in the report, never silently drop data."""
        try:
            return fn(*args)
        except Exception as error:  # noqa: BLE001 - any parser failure is reported
            self.note("not_transferred", None, what, f"Could not be read: {type(error).__name__}: {error}")
            return default

    # ---------------------------------------------------------------- structure

    def channels(self) -> list[dict]:
        data, count = self.data, self.meta.get("tracks")
        strips = binding.channels(data)
        bound = binding.bound_channels(data)
        rows = read_tracks(data, count)
        outputs = self.attempt("Output routing", {}, binding.output_labels, data)
        inputs = self.attempt("Input routing", {}, binding.input_labels, data)
        mix = self.attempt("Faders and pan", {}, levels.read_levels, data)
        all_sends = self.attempt("Sends", {}, sends.read_sends, data)
        stacks = self.attempt("Track stacks", [], read_stacks, data, count)
        parents = self.attempt("Track stack nesting", {}, stack_parents, data)
        stack_by_object = {s.object_id: s for s in stacks}
        owner_by_label = {c.label: o for o, c in strips.items()}

        out: dict[int, dict] = {}
        self.object_to_channel: dict[int, int] = {}

        def add(owner: int, name: str, order: int, object_id: int | None, colour: int | None) -> dict:
            label = strips[owner].label
            kind = ("master" if label == "Output 1-2" else "audio" if label.startswith("Audio ")
                    else "instrument" if label.startswith("Inst ") else "folder" if label.startswith("Sub ")
                    else "bus" if label.startswith(("Aux ", "Bus ")) else "other")
            level = mix.get(owner)
            channel = {
                "id": owner, "label": label, "name": name, "kind": kind, "order": order, "parent": None,
                "logicColour": colour,
                # An audio track's width comes from its files (set while reading regions).
                "stereo": kind != "audio" or bool(strips[owner].stereo_input),
                "gainDb": fader_db(level["fader_exact"]) if level else None,
                "pan": pan_unit(level["pan"]) if level else None,
                "mute": bool(level and level["mute"]), "solo": bool(level and level["solo"]),
                "output": outputs.get(owner), "input": inputs.get(owner),
                "sends": [], "plugins": [], "audio": [], "midi": [], "automation": [],
            }
            out[owner] = channel
            return channel

        for order, row in enumerate(rows):
            object_id = row["object_id"]
            owner = bound.get(object_id)
            if owner is None or owner not in strips:
                self.note("not_transferred", row["name"], "Track",
                          "This track has no mixer channel (for example an external MIDI or folder object).")
                continue
            self.object_to_channel[object_id] = owner
            if owner in out:
                if out[owner]["name"] != row["name"]:
                    self.note("approximated", row["name"], "Track",
                              f"Shares a mixer channel with '{out[owner]['name']}'; they become one LUNA track.")
                continue
            channel = add(owner, row["name"] or strips[owner].label, order, object_id, row.get("colour"))
            if row.get("hidden"):
                self.note("approximated", channel["name"], "Hidden track", "Imported as a visible track.")
            stack = stack_by_object.get(object_id)
            if stack is not None:
                channel["kind"] = "summing" if stack.kind == "summing" else "folder"

        for object_id, owner in self.object_to_channel.items():
            parent_object = parents.get(object_id)
            if parent_object in self.object_to_channel:
                out[owner]["parent"] = self.object_to_channel[parent_object]

        # Channels used by routing but absent from the track list: buses (auxes) and the master.
        master = owner_by_label.get("Output 1-2")
        if master is not None and master not in out:
            add(master, "Stereo Out", len(rows), None, None)

        wanted = {outputs.get(o) for o in out} | {f"Bus {s.bus}" for o in out for s in all_sends.get(o, [])}
        seen: set[str] = set()
        while wanted - seen:
            label = (wanted - seen).pop()
            seen.add(label)
            if not label or not label.startswith("Bus "):
                continue
            for owner, source in inputs.items():
                if source == label and owner not in out and strips[owner].label.startswith("Aux "):
                    add(owner, strips[owner].label, len(rows) + len(seen), None, None)
                    wanted.add(outputs.get(owner))
                    wanted |= {f"Bus {s.bus}" for s in all_sends.get(owner, [])}

        # Resolve "Bus N" labels to the channel(s) fed by that bus.
        fed: dict[str, list[int]] = {}
        for owner, channel in out.items():
            source = channel["input"]
            if source and source.startswith("Bus ") and channel["kind"] in ("bus", "summing"):
                fed.setdefault(source, []).append(owner)
        self.virtual: dict[str, int] = {}

        def destination(label: str | None, who: str) -> int | str | None:
            if label is None:
                return None
            if label == "Output 1-2":
                return "master"
            if label.startswith("Bus "):
                targets = fed.get(label, [])
                if len(targets) == 1:
                    return targets[0]
                if label not in self.virtual:
                    self.virtual[label] = -(len(self.virtual) + 1)
                    if targets:
                        self.note("approximated", None, label,
                                  f"{len(targets)} aux channels listen to {label}. A single LUNA bus was made; "
                                  "route those auxes by hand.")
                return self.virtual[label]
            self.note("approximated", who, "Output", f"Output '{label}' is not mapped; routed to the master.")
            return "master"

        for owner, channel in list(out.items()):
            channel["output"] = None if channel["kind"] == "master" else destination(channel["output"], channel["name"])
            for send in all_sends.get(owner, []):
                channel["sends"].append({
                    "target": destination(f"Bus {send.bus}", channel["name"]), "bus": f"Bus {send.bus}",
                    "gainDb": fader_db(send.level_exact), "preFader": send.mode == "pre fader",
                    "mode": send.mode, "bypassed": send.bypassed,
                })
                if send.independent_pan:
                    self.note("not_transferred", channel["name"], "Send pan", "Independent send pan is not transferred.")
        for label, ident in self.virtual.items():
            out[ident] = {"id": ident, "label": label, "name": label, "kind": "bus", "order": 10_000 - ident,
                          "parent": None, "logicColour": None, "stereo": True, "gainDb": 0.0, "pan": None,
                          "mute": False, "solo": False, "output": "master", "input": label, "sends": [],
                          "plugins": [], "audio": [], "midi": [], "automation": []}
        self.out_channels = out
        return sorted(out.values(), key=lambda c: c["order"])

    # ---------------------------------------------------------------- plug-ins

    def read_au(self, component: tuple[str, str, str], plist: dict) -> dict:
        if self.austate is None:
            return {"error": "The settings reader was not run."}
        with tempfile.TemporaryDirectory() as folder:
            state, result = Path(folder) / "state.plist", Path(folder) / "result.json"
            state.write_bytes(plistlib.dumps(plist, fmt=plistlib.FMT_BINARY))
            # One process per plug-in: a crashing or hanging plug-in only loses its own settings.
            try:
                run = subprocess.run([str(self.austate), *component, str(state), str(result)],
                                     capture_output=True, timeout=90)
            except subprocess.TimeoutExpired:
                return {"error": "The plug-in did not answer within 90 seconds."}
            if not result.exists():
                return {"error": f"The plug-in stopped the settings reader (exit {run.returncode})."}
            return json.loads(result.read_text())

    def plugins(self) -> None:
        payloads = self.attempt("Plug-ins", [], plugins.slot_payloads, self.data)
        strips = binding.channels(self.data)
        owner_by_label = {c.label: o for o, c in strips.items()}
        base = self.attempt("Plug-in slot numbers", 2, slots.slot_index_base, self.data)
        records = {}
        uadx = uadx_luna_ids()
        for owner in self.out_channels:
            if owner >= 0:
                for position in range(1, 17):
                    record = self.attempt("Plug-in slot", None, transplant.slot_at, self.data, owner, position)
                    if record is not None:
                        records[owner, record.key] = (record, position)
        for ref, payload in payloads:
            owner = owner_by_label.get(ref.channel)
            channel = self.out_channels.get(owner)
            if channel is None or ref.name == "Klopfgeist":
                continue
            record, position = records.get((owner, ref.key), (None, ref.key - base + 1))
            plugin = {
                "slot": position, "name": ref.name, "logicOwn": bool(ref.native and not ref.component),
                "component": list(ref.component) if ref.component else None,
                "instrument": plugins.is_instrument_plugin(payload),
                "midiEffect": ref.midi,
                "bypassed": bool(record is not None and slots.slot_bypassed(record.raw)),
                "sidechain": ref.side_chain, "displayName": ref.name, "manufacturer": None,
                "params": [], "paramError": None, "savedValues": None, "presetName": None,
                "lunaIds": luna_ids(ref.component, uadx) if ref.component else [],
            }
            if ref.component:
                plist = next((p for _, p in find_au_plists(payload) if "manufacturer" in p), None)
                if plist is None:
                    plugin["paramError"] = "No saved Audio Unit state was found."
                else:
                    plugin["presetName"] = plist.get("name")
                    progress(f"Reading plug-in settings on {channel['name']}")
                    result = self.read_au(ref.component, plist)
                    full = result.get("name") or ""
                    if ": " in full:
                        plugin["manufacturer"], plugin["displayName"] = full.split(": ", 1)
                    elif full:
                        plugin["displayName"] = full
                    plugin["params"] = result.get("params", [])
                    plugin["paramError"] = result.get("error")
                    extra = sorted(k for k, v in plist.items() if isinstance(v, bytes) and k != "data")
                    plugin["privateState"] = extra
            else:
                raw = record.raw if record is not None else b""
                decoded = self.attempt(f"{ref.name} settings", [], channel_natives, raw) if raw else []
                if decoded:
                    plugin["savedValues"] = json.loads(json.dumps(decoded[0][1], default=str))
            if ref.side_chain:
                self.note("not_transferred", channel["name"], f"{plugin['displayName']} side-chain",
                          f"Side-chain source '{ref.side_chain}' must be reconnected by hand.")
            channel["plugins"].append(plugin)
        for channel in self.out_channels.values():
            channel["plugins"].sort(key=lambda p: p["slot"])

    # ---------------------------------------------------------------- timeline

    def audio_path(self, file) -> Path | None:
        for candidate in (self.project / "Media" / "Audio Files" / file.name,
                          self.project / "Media" / file.name,
                          self.project.parent / "Audio Files" / file.name,
                          Path(file.folder) / file.name):
            if candidate.is_file():
                return candidate
        matches = list((self.project / "Media").rglob(file.name)) if (self.project / "Media").is_dir() else []
        return matches[0] if len(matches) == 1 else None

    def copy_audio(self, source: Path) -> str:
        if source not in self.copied:
            folder = self.out / "audio"
            folder.mkdir(parents=True, exist_ok=True)
            target, n = folder / source.name, 2
            while target.name in {Path(p).name for p in self.copied.values()}:
                target, n = folder / f"{source.stem} ({n}){source.suffix}", n + 1
            shutil.copy2(source, target)
            self.copied[source] = str(target.resolve())
        return self.copied[source]

    def regions(self, timing: TempoMap) -> None:
        count = self.meta.get("tracks")
        for region in self.attempt("Audio regions", [], read_audio_regions, self.data, count):
            channel = self.out_channels.get(self.object_to_channel.get(region.object_id))
            who = channel["name"] if channel else region.track
            if channel is None:
                self.note("not_transferred", who, f"Audio region '{region.name}'", "Its track was not found.")
                continue
            if region.file is None:
                self.note("not_transferred", who, f"Audio region '{region.name}'", "Its audio file record is missing.")
                continue
            source = self.audio_path(region.file)
            if source is None:
                self.note("not_transferred", who, f"Audio region '{region.name}'",
                          f"Audio file '{region.file.name}' was not found.")
                continue
            rate = region.file.rate
            start_seconds = timing.seconds(region.start)
            stop_tick = timing.tick(start_seconds + region.frames / rate)
            fade = region.fade

            def fade_ticks(ms: int, at_start: bool) -> int:
                if not ms:
                    return 0
                edge = start_seconds if at_start else start_seconds + region.frames / rate - ms / 1000
                return round((timing.tick(edge + ms / 1000) - timing.tick(edge)) * LUNA_PER_LOGIC_TICK)

            gain_db = region_gain_db(region.params.gain, str(self.meta.get("logic_version") or ""))
            if region.file.channels > 1:
                channel["stereo"] = True
            channel["audio"].append({
                "name": region.name, "file": self.copy_audio(source),
                "start": luna_tick(region.start), "stop": luna_tick(stop_tick),
                "sourceStartNs": round(region.offset / rate * 1e9),
                "sourceStopNs": round((region.offset + region.frames) / rate * 1e9),
                "muted": region.muted, "gainDb": gain_db or 0,
                "fadeIn": fade_ticks(fade.in_ms if fade.in_type == 0 else 0, True),
                "fadeOut": fade_ticks(fade.out_ms, False),
            })
            title = f"Audio region '{region.name}'"
            if region.loop:
                self.note("not_transferred", who, title, "Looping: only the first pass was placed.")
            if fade.in_ms and fade.in_type != 0:
                self.note("not_transferred", who, title, "Speed Up fade-in is not transferred.")
            if fade.in_ms or fade.out_ms:
                self.note("approximated", who, title, "Fade lengths are copied; fade curves are not matched.")
            if region.crossfaded:
                self.note("approximated", who, title, "Crossfade is rebuilt as plain fades. Check it.")
            p = region.params
            if p.gain and gain_db is None:
                self.note("not_transferred", who, title,
                          f"This region has its own Gain in Logic, which was NOT applied. The reader returned {p.gain}, "
                          "and its unit is not confirmed for this value and Logic version. Check the Region inspector.")
            for label, value in (("delay", p.delay), ("transpose", p.transpose),
                                 ("fine tune", p.fine_tune), ("reverse", p.reverse)):
                if value:
                    self.note("not_transferred", who, title, f"Region {label} ({value}) is not applied.")

        for region in self.attempt("MIDI regions", [], read_midi, self.data, count):
            channel = self.out_channels.get(self.object_to_channel.get(region.object_id))
            if channel is None:
                self.note("not_transferred", region.track, f"MIDI region '{region.name}'", "Its track was not found.")
                continue
            end = region.start + region.length
            notes, events, unknown = [], [], 0
            for e in region.played:
                tick = luna_tick(e.tick) - luna_tick(region.start)
                if e.kind == "note":
                    length = min(e.length, end - e.tick) if region.length else e.length
                    notes.append({"pitch": e.data1, "velocity": max(1, e.data2), "tick": tick,
                                  "length": max(1, length) * LUNA_PER_LOGIC_TICK, "channel": e.channel - 1})
                elif e.kind in ("controller", "program", "bend"):
                    status = {"controller": 0xB0, "program": 0xC0, "bend": 0xE0}[e.kind] | (e.channel - 1)
                    # Logic stores a bend as (MSB in data2, LSB in data1), a program in data1.
                    events.append({"tick": tick, "status": status, "data1": e.data1,
                                   "data2": None if e.kind == "program" else e.data2})
                else:
                    unknown += 1
            if unknown:
                self.note("not_transferred", channel["name"], f"MIDI region '{region.name}'",
                          f"{unknown} event(s) of an unsupported type (such as aftertouch).")
            if region.loop:
                self.note("not_transferred", channel["name"], f"MIDI region '{region.name}'",
                          "Looping: only the first pass was placed.")
            channel["midi"].append({"name": region.name, "start": luna_tick(region.start),
                                    "stop": luna_tick(end), "muted": region.muted,
                                    "notes": notes, "events": events})

    def automation(self) -> None:
        count = self.meta.get("tracks")
        for folder in self.attempt("Automation", [], read_automation, self.data, count):
            if not folder.lanes:
                continue
            channel = self.out_channels.get(self.object_to_channel.get(folder.track_object))
            if channel is None and folder.track == "Stereo Out":
                channel = next((c for c in self.out_channels.values() if c["kind"] == "master"), None)
            if channel is None:
                self.note("not_transferred", folder.track, "Automation", "Its track was not found.")
                continue
            for lane in folder.lanes:
                what = f"{lane.parameter} automation"
                if lane.region or lane.relative:
                    kind = "Region" if lane.region else "Relative (±)"
                    self.note("not_transferred", channel["name"], what, f"{kind} automation is not transferred.")
                    continue
                points: dict[int, float] = {}
                out: dict = {"label": lane.parameter}
                if lane.slot is not None and lane.param_index is not None:
                    plugin = next((p for p in channel["plugins"] if p["slot"] == lane.slot), None)
                    param = next((p for p in plugin["params"] if p["id"] == lane.param_index), None) if plugin else None
                    if param is None or "min" not in param:
                        self.note("not_transferred", channel["name"], what,
                                  f"Insert {lane.slot}" + (f" ({plugin['displayName']})" if plugin else "") +
                                  f", parameter {lane.param_index}: it could not be matched to an Audio Unit parameter.")
                        continue
                    out.update(target="plugin", slot=lane.slot, paramId=lane.param_index, paramName=param["name"],
                               label=f"{plugin['displayName']} · {param['name']}")
                    for p in lane.points:
                        points[max(0, luna_tick(p.position))] = param["min"] + p.value * (param["max"] - param["min"])
                elif lane.parameter in ("Volume", "Pan", "Mute"):
                    out["target"] = lane.parameter.lower()
                    convert = {"Volume": fader_db, "Pan": pan_unit, "Mute": lambda v: 1.0 if v else 0.0}[lane.parameter]
                    for p in lane.points:
                        points[max(0, luna_tick(p.position))] = float(convert(p.value))
                else:
                    self.note("not_transferred", channel["name"], what, "This automation type is not supported.")
                    continue
                out["points"] = [{"tick": t, "value": v} for t, v in sorted(points.items())]
                channel["automation"].append(out)

    def session(self, timing: TempoMap) -> dict:
        tempos = [{"tick": max(0, luna_tick(t)), "bpm": round(b, 4)} for t, b in timing.events]
        signatures, previous, bar = [], None, 1
        for s in self.attempt("Time signatures", ([], []), signature.read_signatures, self.data)[0]:
            tick = max(s.tick, LOGIC_BAR_ONE)
            if previous is not None:
                bar_ticks = previous[1] * LOGIC_PPQ * 4 / previous[2]
                bar += round((tick - previous[0]) / bar_ticks)
            previous = (tick, s.numerator, s.denominator)
            signatures.append({"bar": bar, "numerator": s.numerator, "denominator": s.denominator})
        found = self.attempt("Markers", [], markers.read_markers, self.data)
        return {
            "name": self.project.stem, "sampleRate": self.meta.get("sample_rate"),
            "logicVersion": self.meta.get("logic_version"), "key": self.meta.get("key"),
            "tempo": tempos, "signatures": signatures,
            "markers": [{"tick": max(0, luna_tick(m.tick)), "name": m.name or "Marker"} for m in found],
        }

    def run(self) -> dict:
        timing = TempoMap(self.attempt("Tempo", [], lambda: [(e.position, e.bpm) for e in tempo.read_tempo_events(self.data)])
                          or [(LOGIC_BAR_ONE, float(self.meta.get("bpm") or 120))])
        progress("Reading tracks, folders and routing")
        channels = self.channels()
        progress("Reading plug-ins")
        self.plugins()
        progress("Reading audio and MIDI, and copying audio files")
        self.regions(timing)
        progress("Reading automation")
        self.automation()
        return {"format": FORMAT, "session": self.session(timing), "channels": channels, "notes": self.notes,
                "notChecked": [
                    "Flex Time and Flex Pitch edits", "Take folders and comping", "Mixer and edit groups",
                    "VCA faders", "Smart Controls", "Software instrument sample content",
                    "Surround and Dolby Atmos settings", "Score, video and Live Loops content",
                    "MIDI effect behaviour", "Key signatures and chords",
                ]}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("project", type=Path, help="the .logicx project (only read)")
    parser.add_argument("--out", type=Path, help="output folder (default: '<name> for LUNA' beside the project)")
    parser.add_argument("--skip-plugin-settings", action="store_true",
                        help="do not load Audio Units to read their settings")
    args = parser.parse_args()
    project = args.project.expanduser().resolve()
    if not (project / "Alternatives").is_dir():
        print(f"Not a Logic project package: {project}", file=sys.stderr)
        return 1
    out = (args.out or project.parent / f"{project.stem} for LUNA").expanduser().resolve()
    if out == project or project in out.parents:
        print("The output folder cannot be inside the Logic project.", file=sys.stderr)
        return 1
    out.mkdir(parents=True, exist_ok=True)
    austate = AUSTATE
    if args.skip_plugin_settings:
        austate = None
    elif not austate.exists():
        austate.parent.mkdir(exist_ok=True)
        subprocess.run(["swiftc", "-O", str(ROOT / "converter" / "austate.swift"), "-o", str(austate)], check=True)
    manifest = Converter(project, out, austate).run()
    target = out / f"{project.stem}.lunaimport.json"
    target.write_text(json.dumps(manifest, indent=1, allow_nan=False))
    channels = manifest["channels"]
    print(f"Wrote {target}")
    print(f"  {len(channels)} channels, {sum(len(c['plugins']) for c in channels)} plug-ins, "
          f"{sum(len(c['audio']) for c in channels)} audio regions, {sum(len(c['midi']) for c in channels)} MIDI regions, "
          f"{sum(len(c['automation']) for c in channels)} automation lanes, {len(manifest['notes'])} notes for the report")
    return 0


if __name__ == "__main__":
    sys.exit(main())
