#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import json
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
from copy import deepcopy
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

try:
    from pypdf import PdfReader, PdfWriter
except ImportError:  # pragma: no cover - guarded in CLI/tests
    PdfReader = None
    PdfWriter = None


CANONICAL_VERSION = 2
LEARNABLE_KINDS = {"dialogue", "lyric"}
APPLY_STATUSES = {"accepted", "apply", "approved", "done", "yes", "true", "1"}
REVIEW_COLUMNS = [
    "issue_id",
    "start_entry_id",
    "end_entry_id",
    "field",
    "value",
    "status",
    "reason",
    "page",
    "confidence",
]

ACT_RE = re.compile(r"^(?:(ERSTER|ZWEITER|DRITTER|VIERTER|F[ÜU]NFTER|SECHSTER)\s+AKT|AKT\s+[IVXLC0-9]+)\b", re.IGNORECASE)
SCENE_RE = re.compile(r"^(?:(\d+)\.\s*SZENE|SZENE\s+[IVXLC0-9]+)\b", re.IGNORECASE)
SONG_RE = re.compile(r"^(NR\.?\s*[\w.-]+)\s*[:\-–—]?\s*[\"“„]?(.+?)['\"”]?$", re.IGNORECASE)
SPEAKER_INLINE_RE = re.compile(r"^([A-ZÄÖÜ][A-ZÄÖÜ0-9 .'/&-]{1,40}):\s*(.+)$")
SPEAKER_STANDALONE_RE = re.compile(r"^([A-ZÄÖÜ][A-ZÄÖÜ0-9 .'/&-]{1,40})$")
PAGE_NOISE_RE = re.compile(r"^(SEITE\s+\d+|\d+)$", re.IGNORECASE)


def normalize_whitespace(value: Any) -> str:
    return (
        str(value or "")
        .replace("\u00a0", " ")
        .replace("\u00ad", "")
        .replace("\r", "")
        .replace("\t", " ")
        .strip()
    )


def normalize_string_list(value: Any) -> List[str]:
    values = value if isinstance(value, list) else str(value or "").split(",")
    seen = set()
    out: List[str] = []
    for item in values:
        clean = normalize_whitespace(item)
        key = clean.upper()
        if not clean or key in seen:
            continue
        seen.add(key)
        out.append(clean)
    return out


def slugify(value: Any) -> str:
    text = normalize_whitespace(value).lower()
    text = (
        text.encode("ascii", "ignore").decode("ascii")
        if text
        else ""
    )
    text = re.sub(r"[^a-z0-9]+", "-", text).strip("-")
    return text or "item"


class IdFactory:
    def __init__(self, prefix: str) -> None:
        self.prefix = prefix
        self.counts: Dict[str, int] = {}

    def next(self, seed: str) -> str:
        base = f"{self.prefix}-{slugify(seed or self.prefix)}"
        count = self.counts.get(base, 0) + 1
        self.counts[base] = count
        return base if count == 1 else f"{base}-{count}"


class CatalogBuilder:
    def __init__(self) -> None:
        self.role_factory = IdFactory("role")
        self.act_factory = IdFactory("act")
        self.scene_factory = IdFactory("scene")
        self.song_factory = IdFactory("song")
        self.roles: List[Dict[str, Any]] = []
        self.acts: List[Dict[str, Any]] = []
        self.scenes: List[Dict[str, Any]] = []
        self.songs: List[Dict[str, Any]] = []
        self.roles_by_id: Dict[str, Dict[str, Any]] = {}
        self.roles_by_label: Dict[str, Dict[str, Any]] = {}
        self.acts_by_id: Dict[str, Dict[str, Any]] = {}
        self.acts_by_label: Dict[str, Dict[str, Any]] = {}
        self.scenes_by_id: Dict[str, Dict[str, Any]] = {}
        self.scenes_by_key: Dict[str, Dict[str, Any]] = {}
        self.songs_by_id: Dict[str, Dict[str, Any]] = {}
        self.songs_by_key: Dict[str, Dict[str, Any]] = {}

    def ensure_role(self, role_id: str, label: str) -> Dict[str, Any]:
        clean_label = normalize_whitespace(label)
        requested_id = normalize_whitespace(role_id)
        if requested_id and requested_id in self.roles_by_id:
            return self.roles_by_id[requested_id]
        if clean_label and clean_label.upper() in self.roles_by_label:
            item = self.roles_by_label[clean_label.upper()]
            if requested_id:
                self.roles_by_id[requested_id] = item
            return item
        if not clean_label and not requested_id:
            return {"id": "", "label": ""}
        item = {"id": requested_id or self.role_factory.next(clean_label or "role"), "label": clean_label or requested_id}
        self.roles.append(item)
        self.roles_by_id[item["id"]] = item
        self.roles_by_label[item["label"].upper()] = item
        return item

    def ensure_act(self, act_id: str, label: str) -> Dict[str, Any]:
        clean_label = normalize_whitespace(label)
        requested_id = normalize_whitespace(act_id)
        if requested_id and requested_id in self.acts_by_id:
            return self.acts_by_id[requested_id]
        if clean_label and clean_label.upper() in self.acts_by_label:
            item = self.acts_by_label[clean_label.upper()]
            if requested_id:
                self.acts_by_id[requested_id] = item
            return item
        if not clean_label and not requested_id:
            return {"id": "", "label": ""}
        item = {"id": requested_id or self.act_factory.next(clean_label or "act"), "label": clean_label or requested_id}
        self.acts.append(item)
        self.acts_by_id[item["id"]] = item
        self.acts_by_label[item["label"].upper()] = item
        return item

    def ensure_scene(self, scene_id: str, label: str, act_ref: Dict[str, Any]) -> Dict[str, Any]:
        clean_label = normalize_whitespace(label)
        requested_id = normalize_whitespace(scene_id)
        if requested_id and requested_id in self.scenes_by_id:
            return self.scenes_by_id[requested_id]
        act_id = normalize_whitespace(act_ref.get("id"))
        key = f"{act_id}::{clean_label.upper()}"
        if clean_label and key in self.scenes_by_key:
            item = self.scenes_by_key[key]
            if requested_id:
                self.scenes_by_id[requested_id] = item
            return item
        if not clean_label and not requested_id:
            return {"id": "", "label": "", "actId": act_id}
        item = {
            "id": requested_id or self.scene_factory.next(f"{act_id or 'global'}-{clean_label or 'scene'}"),
            "label": clean_label or requested_id,
            "actId": act_id,
        }
        self.scenes.append(item)
        self.scenes_by_id[item["id"]] = item
        if clean_label:
            self.scenes_by_key[key] = item
        return item

    def ensure_song(self, song_parts: Dict[str, str], act_ref: Dict[str, Any], scene_ref: Dict[str, Any]) -> Dict[str, Any]:
        requested_id = normalize_whitespace(song_parts.get("songId"))
        if requested_id and requested_id in self.songs_by_id:
            return self.songs_by_id[requested_id]
        song_number = normalize_whitespace(song_parts.get("songNumber"))
        song_title = normalize_whitespace(song_parts.get("songTitle"))
        song_label = normalize_whitespace(song_parts.get("songLabel")) or format_song_label(song_number, song_title)
        act_id = normalize_whitespace(act_ref.get("id"))
        scene_id = normalize_whitespace(scene_ref.get("id"))
        key = f"{scene_id or act_id or 'global'}::{song_number}::{song_title or song_label}"
        if (song_number or song_title or song_label) and key in self.songs_by_key:
            item = self.songs_by_key[key]
            if requested_id:
                self.songs_by_id[requested_id] = item
            return item
        if not requested_id and not song_number and not song_title and not song_label:
            return {"id": "", "number": "", "title": "", "label": "", "actId": act_id, "sceneId": scene_id}
        item = {
            "id": requested_id or self.song_factory.next(f"{scene_id or act_id or 'global'}-{song_number or song_title or song_label or 'song'}"),
            "number": song_number,
            "title": song_title or song_label,
            "label": song_label or song_title or requested_id,
            "actId": act_id,
            "sceneId": scene_id,
        }
        self.songs.append(item)
        self.songs_by_id[item["id"]] = item
        self.songs_by_key[key] = item
        return item

    def ensure_refs(self, raw: Dict[str, Any]) -> Dict[str, str]:
        role_ref = self.ensure_role(raw.get("speakerId", ""), raw.get("speaker", ""))
        act_ref = self.ensure_act(raw.get("actId", ""), raw.get("actLabel", ""))
        scene_ref = self.ensure_scene(raw.get("sceneId", ""), raw.get("sceneLabel", ""), act_ref)
        song_ref = self.ensure_song(
            {
                "songId": raw.get("songId", ""),
                "songNumber": raw.get("songNumber", ""),
                "songTitle": raw.get("songTitle", ""),
                "songLabel": raw.get("songLabel", ""),
            },
            act_ref,
            scene_ref,
        )
        return {
            "speakerId": role_ref.get("id", ""),
            "speaker": role_ref.get("label", ""),
            "actId": act_ref.get("id", ""),
            "actLabel": act_ref.get("label", ""),
            "sceneId": scene_ref.get("id", ""),
            "sceneLabel": scene_ref.get("label", ""),
            "songId": song_ref.get("id", ""),
            "songNumber": song_ref.get("number", ""),
            "songTitle": song_ref.get("title", ""),
            "songLabel": song_ref.get("label", ""),
        }

    def snapshot(self) -> Dict[str, Any]:
        return {
            "roles": deepcopy(self.roles),
            "acts": deepcopy(self.acts),
            "scenes": deepcopy(self.scenes),
            "songs": deepcopy(self.songs),
        }


def format_song_label(song_number: str, song_title: str) -> str:
    if song_number and song_title:
        return f"{song_number} - {song_title}"
    return song_number or song_title or ""


def get_dependency_status() -> Dict[str, Any]:
    tesseract_path = shutil.which("tesseract")
    sips_path = shutil.which("sips")
    return {
        "pypdf": {
            "available": PdfReader is not None and PdfWriter is not None,
            "installHint": f"{sys.executable} -m pip install pypdf",
        },
        "ocr": {
            "tesseract": tesseract_path or "",
            "sips": sips_path or "",
            "available": bool(tesseract_path and sips_path),
            "languages": available_tesseract_langs() if tesseract_path else [],
        },
    }


def ensure_dependencies() -> None:
    status = get_dependency_status()
    if not status["pypdf"]["available"]:
        raise RuntimeError(
            "pypdf ist nicht installiert. "
            f"Installiere es mit: {status['pypdf']['installHint']}"
        )


def available_tesseract_langs() -> List[str]:
    if not shutil.which("tesseract"):
        return []
    result = subprocess.run(["tesseract", "--list-langs"], capture_output=True, text=True, check=False)
    if result.returncode != 0:
        return []
    return [line.strip() for line in result.stdout.splitlines()[1:] if line.strip()]


def normalize_page_text(text: str) -> str:
    clean = normalize_whitespace(text)
    clean = clean.replace(" - ", "-")
    return clean


def needs_ocr(text: str) -> bool:
    return len(re.findall(r"[A-Za-zÄÖÜäöüß0-9]", text)) < 25


def ocr_page(reader: PdfReader, page_index: int, languages: Optional[List[str]] = None) -> str:
    if not shutil.which("sips") or not shutil.which("tesseract"):
        return ""
    ensure_dependencies()
    languages = languages or []
    with tempfile.TemporaryDirectory(prefix="script-import-") as tmpdir:
        single_pdf = Path(tmpdir) / f"page-{page_index + 1}.pdf"
        png_path = Path(tmpdir) / f"page-{page_index + 1}.png"
        writer = PdfWriter()
        writer.add_page(reader.pages[page_index])
        with single_pdf.open("wb") as handle:
            writer.write(handle)
        render = subprocess.run(
            ["sips", "-s", "format", "png", str(single_pdf), "--out", str(png_path)],
            capture_output=True,
            text=True,
            check=False,
        )
        if render.returncode != 0 or not png_path.exists():
            return ""
        cmd = ["tesseract", str(png_path), "stdout", "--psm", "6"]
        if languages:
            cmd.extend(["-l", "+".join(languages)])
        result = subprocess.run(cmd, capture_output=True, text=True, check=False)
        if result.returncode != 0:
            return ""
        return normalize_page_text(result.stdout)


def style_flags_from_font(font_name: Any, text: str, underline: bool = False) -> Dict[str, bool]:
    font = normalize_whitespace(font_name).lower()
    letters = [char for char in normalize_whitespace(text) if char.isalpha()]
    return {
        "bold": any(token in font for token in ("bold", "black", "heavy", "demi")),
        "italic": any(token in font for token in ("italic", "oblique", "kursiv")),
        "underline": bool(underline),
        "allCaps": bool(letters) and all(not char.isalpha() or char.isupper() for char in normalize_whitespace(text)),
    }


def merge_style_flags(styles: Iterable[Dict[str, Any]], text: str = "") -> Dict[str, bool]:
    style_list = list(styles or [])
    return {
        "bold": any(bool(style.get("bold")) for style in style_list),
        "italic": any(bool(style.get("italic")) for style in style_list),
        "underline": any(bool(style.get("underline")) for style in style_list),
        "allCaps": any(bool(style.get("allCaps")) for style in style_list) or style_flags_from_font("", text)["allCaps"],
    }


def extract_text_lines_with_style(page: Any) -> List[Dict[str, Any]]:
    fragments: List[Dict[str, Any]] = []
    horizontal_marks: List[Dict[str, float]] = []
    current_point: Optional[Tuple[float, float]] = None

    def number(value: Any) -> float:
        try:
            return float(value)
        except Exception:
            return 0.0

    def visitor(text: str, _cm: Any, tm: Any, font_dict: Any, _font_size: Any) -> None:
        clean = normalize_page_text(text or "")
        if not clean:
            return
        font_name = ""
        if isinstance(font_dict, dict):
            font_name = font_dict.get("/BaseFont", "") or font_dict.get("BaseFont", "")
        try:
            y = round(float(tm[5]), 1)
        except Exception:
            y = float(len(fragments))
        try:
            x = round(float(tm[4]), 1)
        except Exception:
            x = 0.0
        fragments.append({
            "text": clean,
            "x": x,
            "y": y,
            "style": style_flags_from_font(font_name, clean),
        })

    def visitor_operand_before(operator: Any, operands: Any, _cm: Any, _tm: Any) -> None:
        nonlocal current_point
        op = operator.decode("latin1") if isinstance(operator, bytes) else str(operator)
        values = list(operands or [])
        if op == "m" and len(values) >= 2:
            current_point = (number(values[0]), number(values[1]))
            return
        if op == "l" and len(values) >= 2 and current_point:
            x1, y1 = current_point
            x2, y2 = number(values[0]), number(values[1])
            if abs(y1 - y2) <= 1 and abs(x2 - x1) >= 10:
                horizontal_marks.append({"x1": min(x1, x2), "x2": max(x1, x2), "y": (y1 + y2) / 2})
            current_point = (x2, y2)
            return
        if op == "re" and len(values) >= 4:
            x, y, width, height = number(values[0]), number(values[1]), number(values[2]), number(values[3])
            if abs(width) >= 10 and 0 < abs(height) <= 2:
                horizontal_marks.append({"x1": min(x, x + width), "x2": max(x, x + width), "y": y})

    try:
        page.extract_text(visitor_text=visitor, visitor_operand_before=visitor_operand_before)
    except Exception:
        return []

    grouped: Dict[float, List[Dict[str, Any]]] = {}
    for fragment in fragments:
        grouped.setdefault(fragment["y"], []).append(fragment)

    lines: List[Dict[str, Any]] = []
    for _, items in sorted(grouped.items(), key=lambda item: -item[0]):
        items.sort(key=lambda item: item["x"])
        text = normalize_whitespace(" ".join(item["text"] for item in items))
        if not text or PAGE_NOISE_RE.match(text):
            continue
        x1 = min(item["x"] for item in items)
        x2 = max(item["x"] + max(12, len(item["text"]) * 5) for item in items)
        y = items[0]["y"]
        underline = any(mark["x2"] >= x1 and mark["x1"] <= x2 and 1 <= (y - mark["y"]) <= 9 for mark in horizontal_marks)
        styles = [item.get("style", {}) for item in items]
        if underline:
            styles.append({"underline": True})
        lines.append({
            "text": text,
            "x": x1,
            "y": y,
            "style": merge_style_flags(styles, text),
        })
    return lines


def extract_pdf_pages(pdf_path: Path, use_ocr: bool = True, force_ocr: bool = False, max_pages: Optional[int] = None) -> List[Dict[str, Any]]:
    ensure_dependencies()
    reader = PdfReader(str(pdf_path))
    langs_available = set(available_tesseract_langs())
    preferred_langs = [lang for lang in ("deu", "eng") if lang in langs_available]
    pages: List[Dict[str, Any]] = []
    total_pages = len(reader.pages)
    page_limit = min(total_pages, max_pages) if max_pages else total_pages
    for index in range(page_limit):
        page = reader.pages[index]
        lines = extract_text_lines_with_style(page)
        extracted = normalize_page_text(page.extract_text() or "")
        source = "text" if extracted else "empty"
        if use_ocr and (force_ocr or needs_ocr(extracted)):
            ocr_text = ocr_page(reader, index, preferred_langs)
            if ocr_text and (force_ocr or len(ocr_text) > len(extracted) + 10):
                extracted = ocr_text
                source = "ocr"
                lines = []
            elif not extracted:
                source = "empty"
        page_payload = {
            "pageNumber": index + 1,
            "text": extracted,
            "source": source,
        }
        if lines and source == "text":
            page_payload["lines"] = lines
        pages.append(page_payload)
    return pages


def clean_lines(text: str) -> List[str]:
    lines: List[str] = []
    for raw in text.splitlines():
        line = normalize_whitespace(raw)
        if not line:
            lines.append("")
            continue
        line = re.sub(r"\s{2,}", " ", line)
        if PAGE_NOISE_RE.match(line):
            continue
        lines.append(line)
    return lines


def detect_act(line: str) -> Optional[str]:
    return line if ACT_RE.match(line) else None


def detect_scene(line: str) -> Optional[str]:
    return line if SCENE_RE.match(line) else None


def detect_song(line: str) -> Optional[Dict[str, str]]:
    match = SONG_RE.match(line)
    if not match:
        return None
    number = normalize_whitespace(match.group(1))
    title = normalize_whitespace(match.group(2))
    if not title:
      return None
    return {
        "songId": "",
        "songNumber": number,
        "songTitle": title,
        "songLabel": format_song_label(number, title),
    }


def detect_speaker_inline(line: str) -> Optional[Dict[str, str]]:
    match = SPEAKER_INLINE_RE.match(line)
    if not match:
        return None
    speaker = normalize_whitespace(match.group(1))
    text = normalize_whitespace(match.group(2))
    if not speaker or not text:
        return None
    return {"speaker": speaker, "text": text}


def detect_speaker_standalone(line: str) -> Optional[str]:
    if not SPEAKER_STANDALONE_RE.match(line):
        return None
    if ACT_RE.match(line) or SCENE_RE.match(line) or SONG_RE.match(line):
        return None
    return normalize_whitespace(line)


def build_role_lookup(roles: Optional[List[Dict[str, Any]]]) -> Dict[str, Dict[str, str]]:
    lookup: Dict[str, Dict[str, str]] = {}
    for raw in roles or []:
        if not isinstance(raw, dict):
            continue
        label = normalize_whitespace(raw.get("label") or raw.get("name") or raw.get("speaker"))
        role_id = normalize_whitespace(raw.get("id") or raw.get("roleId"))
        if not label:
            continue
        aliases = normalize_string_list(raw.get("aliases"))
        for candidate in [label, *aliases]:
            lookup[candidate.upper()] = {"id": role_id, "label": label}
    return lookup


def map_speaker_to_role(speaker: str, role_lookup: Dict[str, Dict[str, str]]) -> Tuple[str, str]:
    clean = normalize_whitespace(speaker)
    if not clean:
        return "", ""
    if not role_lookup:
        return "", clean
    role = role_lookup.get(clean.upper())
    if not role:
        return "", ""
    return role.get("id", ""), role.get("label", clean)


def looks_like_stage_direction(line: str) -> bool:
    if re.match(r"^[\[(].*[\])]$", line):
        return True
    lowered = line.lower()
    return any(lowered.startswith(prefix) for prefix in (
        "musik",
        "licht",
        "pause",
        "applaus",
        "vorhang",
        "black",
    ))


def looks_like_lyric(text: str) -> bool:
    letters = [char for char in text if char.isalpha()]
    if not letters:
        return False
    upper_ratio = sum(1 for char in letters if char.isupper()) / len(letters)
    if upper_ratio >= 0.65:
        return True
    if len(text.split()) <= 12 and not re.search(r"[.!?]$", text):
        return True
    return False


def make_entry(index: int, kind: str, text: str, context: Dict[str, str], page_number: int, speaker: str = "", speaker_id: str = "", source: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    entry = {
        "id": f"entry-{index:05d}",
        "order": index,
        "kind": kind,
        "text": normalize_whitespace(text),
        "cut": False,
        "page": page_number,
        "speakerId": normalize_whitespace(speaker_id),
        "speaker": normalize_whitespace(speaker),
        "actId": normalize_whitespace(context.get("actId")),
        "actLabel": normalize_whitespace(context.get("actLabel")),
        "sceneId": normalize_whitespace(context.get("sceneId")),
        "sceneLabel": normalize_whitespace(context.get("sceneLabel")),
        "songId": normalize_whitespace(context.get("songId")),
        "songNumber": normalize_whitespace(context.get("songNumber")),
        "songTitle": normalize_whitespace(context.get("songTitle")),
        "songLabel": normalize_whitespace(context.get("songLabel")),
    }
    if source:
        entry["source"] = deepcopy(source)
    return entry


def line_items_for_page(page: Dict[str, Any]) -> List[Dict[str, Any]]:
    raw_lines = page.get("lines")
    if isinstance(raw_lines, list) and raw_lines:
        items: List[Dict[str, Any]] = []
        for index, raw in enumerate(raw_lines):
            if not isinstance(raw, dict):
                continue
            text = normalize_whitespace(raw.get("text"))
            if not text:
                items.append({"text": "", "style": {}, "lineIndex": index})
                continue
            text = re.sub(r"\s{2,}", " ", text)
            if PAGE_NOISE_RE.match(text):
                continue
            style = raw.get("style") if isinstance(raw.get("style"), dict) else {}
            items.append({
                "text": text,
                "style": merge_style_flags([style], text),
                "lineIndex": index,
            })
        return items
    return [{"text": line, "style": {}, "lineIndex": index} for index, line in enumerate(clean_lines(page.get("text", "")))]


def line_source(page: Dict[str, Any], line: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "page": int(page.get("pageNumber") or 0),
        "lineIndex": line.get("lineIndex"),
        "styleHints": merge_style_flags([line.get("style", {})], line.get("text", "")),
    }


def rebuild_metadata_from_entries(script: Dict[str, Any]) -> Dict[str, Any]:
    builder = CatalogBuilder()
    rebuilt_entries: List[Dict[str, Any]] = []
    original_roles = deepcopy(script.get("roles") or [])
    original_songs = deepcopy(script.get("songs") or [])
    ordered_entries = sorted(
        script.get("entries", []),
        key=lambda item: (int(item.get("order") or 0), item.get("id", "")),
    )
    for index, raw_entry in enumerate(ordered_entries, start=1):
        entry = deepcopy(raw_entry)
        refs = builder.ensure_refs(entry)
        entry["id"] = normalize_whitespace(entry.get("id")) or f"entry-{index:05d}"
        entry["order"] = int(entry.get("order", index))
        entry["kind"] = normalize_whitespace(entry.get("kind") or entry.get("type")).lower()
        if entry["kind"] == "line":
            entry["kind"] = "dialogue"
        entry["text"] = normalize_whitespace(entry.get("text"))
        entry["cut"] = bool(entry.get("cut"))
        entry["page"] = int(entry["page"]) if entry.get("page") not in (None, "") else None
        entry["speakerId"] = refs["speakerId"]
        entry["speaker"] = refs["speaker"]
        entry["actId"] = refs["actId"]
        entry["actLabel"] = refs["actLabel"]
        entry["sceneId"] = refs["sceneId"]
        entry["sceneLabel"] = refs["sceneLabel"]
        entry["songId"] = refs["songId"]
        entry["songNumber"] = refs["songNumber"]
        entry["songTitle"] = refs["songTitle"]
        entry["songLabel"] = refs["songLabel"] or format_song_label(refs["songNumber"], refs["songTitle"])
        rebuilt_entries.append(entry)
    snapshot = builder.snapshot()
    script["schemaVersion"] = CANONICAL_VERSION
    script["entries"] = rebuilt_entries
    script["roles"] = snapshot["roles"]
    script["scenes"] = snapshot["scenes"]
    script["songs"] = snapshot["songs"]
    script["acts"] = build_acts_tree(snapshot["acts"], snapshot["scenes"], snapshot["songs"])
    merge_catalog_metadata(script, original_roles, original_songs)
    return script


def merge_catalog_metadata(script: Dict[str, Any], source_roles: Optional[List[Dict[str, Any]]] = None, source_songs: Optional[List[Dict[str, Any]]] = None) -> Dict[str, Any]:
    source_roles = source_roles or []
    source_songs = source_songs or []
    role_metadata = {
        normalize_whitespace(role.get("id") or role.get("roleId")) or normalize_whitespace(role.get("label") or role.get("name")).upper(): role
        for role in source_roles
        if isinstance(role, dict)
    }
    for role in script.get("roles", []):
        key = normalize_whitespace(role.get("id")) or normalize_whitespace(role.get("label")).upper()
        raw = role_metadata.get(key)
        if raw:
            role["aliases"] = normalize_string_list(raw.get("aliases"))

    song_metadata = {
        normalize_whitespace(song.get("id") or song.get("songId")) or f"{normalize_whitespace(song.get('number') or song.get('songNumber'))}::{normalize_whitespace(song.get('title') or song.get('songTitle') or song.get('label') or song.get('songLabel'))}".upper(): song
        for song in source_songs
        if isinstance(song, dict)
    }
    for song in script.get("songs", []):
        key = normalize_whitespace(song.get("id")) or f"{normalize_whitespace(song.get('number'))}::{normalize_whitespace(song.get('title') or song.get('label'))}".upper()
        raw = song_metadata.get(key)
        if raw:
            song["singerIds"] = normalize_string_list(raw.get("singerIds"))
    return script


def build_acts_tree(acts: List[Dict[str, Any]], scenes: List[Dict[str, Any]], songs: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    scenes_by_act: Dict[str, List[Dict[str, Any]]] = {act["id"]: [] for act in acts}
    scene_nodes: Dict[str, Dict[str, Any]] = {}
    for scene in scenes:
        node = {
            "id": scene["id"],
            "label": scene["label"],
            "actId": scene.get("actId", ""),
            "songs": [],
        }
        scene_nodes[scene["id"]] = node
        if scene.get("actId") in scenes_by_act:
            scenes_by_act[scene["actId"]].append(node)
    for song in songs:
        if song.get("sceneId") in scene_nodes:
            scene_nodes[song["sceneId"]]["songs"].append({
                "id": song["id"],
                "label": song.get("label", ""),
                "number": song.get("number", ""),
                "title": song.get("title", ""),
            })
    return [{"id": act["id"], "label": act["label"], "scenes": scenes_by_act.get(act["id"], [])} for act in acts]


def parse_pages_to_script(pages: List[Dict[str, Any]], title: str, source_name: str, role_hints: Optional[List[Dict[str, Any]]] = None) -> Dict[str, Any]:
    builder = CatalogBuilder()
    role_lookup = build_role_lookup(role_hints)
    entries: List[Dict[str, Any]] = []
    context = {
        "actId": "",
        "actLabel": "",
        "sceneId": "",
        "sceneLabel": "",
        "songId": "",
        "songNumber": "",
        "songTitle": "",
        "songLabel": "",
    }
    pending_speaker = ""
    entry_index = 1

    def commit_entry(kind: str, text: str, page_number: int, speaker: str = "", speaker_id: str = "", source: Optional[Dict[str, Any]] = None) -> None:
        nonlocal entry_index
        refs = builder.ensure_refs({
            "speakerId": speaker_id,
            "speaker": speaker,
            "actId": context["actId"],
            "actLabel": context["actLabel"],
            "sceneId": context["sceneId"],
            "sceneLabel": context["sceneLabel"],
            "songId": context["songId"],
            "songNumber": context["songNumber"],
            "songTitle": context["songTitle"],
            "songLabel": context["songLabel"],
        })
        entry = make_entry(entry_index, kind, text, refs, page_number, refs["speaker"], refs["speakerId"], source)
        entries.append(entry)
        entry_index += 1

    for page in pages:
        pending_speaker = ""
        for line_item in line_items_for_page(page):
            line = line_item.get("text", "")
            source_meta = line_source(page, line_item)
            style = source_meta["styleHints"]
            if not line:
                pending_speaker = ""
                continue
            act_label = detect_act(line)
            if act_label:
                context["actLabel"] = act_label
                context["actId"] = builder.ensure_act("", act_label)["id"]
                context["sceneId"] = ""
                context["sceneLabel"] = ""
                context["songId"] = ""
                context["songNumber"] = ""
                context["songTitle"] = ""
                context["songLabel"] = ""
                pending_speaker = ""
                continue
            scene_label = detect_scene(line)
            if not scene_label and style.get("bold") and style.get("underline") and style.get("allCaps"):
                scene_label = line
            if scene_label:
                scene_ref = builder.ensure_scene("", scene_label, builder.ensure_act(context["actId"], context["actLabel"]))
                context["sceneId"] = scene_ref["id"]
                context["sceneLabel"] = scene_ref["label"]
                context["songId"] = ""
                context["songNumber"] = ""
                context["songTitle"] = ""
                context["songLabel"] = ""
                pending_speaker = ""
                continue
            song_parts = detect_song(line)
            if song_parts:
                song_ref = builder.ensure_song(song_parts, builder.ensure_act(context["actId"], context["actLabel"]), builder.ensure_scene(context["sceneId"], context["sceneLabel"], builder.ensure_act(context["actId"], context["actLabel"])))
                context["songId"] = song_ref["id"]
                context["songNumber"] = song_ref["number"]
                context["songTitle"] = song_ref["title"]
                context["songLabel"] = song_ref["label"]
                pending_speaker = ""
                continue
            inline = detect_speaker_inline(line)
            if inline:
                speaker_id, speaker_label = map_speaker_to_role(inline["speaker"], role_lookup)
                pending_speaker = speaker_label or inline["speaker"]
                kind = "lyric" if context["songId"] and looks_like_lyric(inline["text"]) else ("dialogue" if not context["songId"] else "lyric")
                commit_entry(kind, inline["text"], int(page["pageNumber"]), pending_speaker, speaker_id, source_meta)
                continue
            standalone = detect_speaker_standalone(line)
            if standalone:
                speaker_id, speaker_label = map_speaker_to_role(standalone, role_lookup)
                if role_lookup and not speaker_label:
                    commit_entry("narration", line, int(page["pageNumber"]), source=source_meta)
                    pending_speaker = ""
                    continue
                pending_speaker = speaker_label or standalone
                continue
            if style.get("italic"):
                commit_entry("stage_direction", line, int(page["pageNumber"]), source=source_meta)
                continue
            if pending_speaker:
                speaker_id, speaker_label = map_speaker_to_role(pending_speaker, role_lookup)
                if not speaker_label:
                    speaker_label = pending_speaker
                kind = "lyric" if context["songId"] and looks_like_lyric(line) else ("dialogue" if not context["songId"] else "dialogue")
                commit_entry(kind, line, int(page["pageNumber"]), speaker_label, speaker_id, source_meta)
                continue
            if looks_like_stage_direction(line):
                commit_entry("stage_direction", line, int(page["pageNumber"]), source=source_meta)
                continue
            if context["songId"] and looks_like_lyric(line):
                commit_entry("lyric", line, int(page["pageNumber"]), source=source_meta)
                continue
            commit_entry("narration", line, int(page["pageNumber"]), source=source_meta)

    script = {
        "schemaVersion": CANONICAL_VERSION,
        "title": title,
        "sourceFormat": "pdf_import",
        "sourceFile": source_name,
        "pages": pages,
        "entries": entries,
        "roles": deepcopy(role_hints or []),
        "issues": [],
    }
    rebuild_metadata_from_entries(script)
    script["issues"] = generate_review_rows(script)
    return script


def contiguous_ranges(entries: List[Dict[str, Any]], key_func) -> List[Dict[str, Any]]:
    ranges: List[Dict[str, Any]] = []
    start = 0
    while start < len(entries):
        key = key_func(entries[start])
        end = start
        while end + 1 < len(entries) and key_func(entries[end + 1]) == key:
            end += 1
        ranges.append({"start": start, "end": end, "key": key})
        start = end + 1
    return ranges


def generate_review_rows(script: Dict[str, Any]) -> List[Dict[str, Any]]:
    entries = script.get("entries", [])
    rows: List[Dict[str, Any]] = []

    scene_ranges = [item for item in contiguous_ranges(entries, lambda entry: entry.get("sceneId", "")) if item["key"]]
    for index, item in enumerate(scene_ranges, start=1):
        start_entry = entries[item["start"]]
        end_entry = entries[item["end"]]
        issue_id = f"scene-{index:03d}"
        for field, value in (
            ("sceneId", start_entry.get("sceneId", "")),
            ("sceneLabel", start_entry.get("sceneLabel", "")),
        ):
            rows.append({
                "issue_id": issue_id,
                "start_entry_id": start_entry.get("id", ""),
                "end_entry_id": end_entry.get("id", ""),
                "field": field,
                "value": value,
                "status": "pending",
                "reason": "Pruefe Szenenzuordnung",
                "page": start_entry.get("page", ""),
                "confidence": "medium",
            })

    song_ranges = [item for item in contiguous_ranges(entries, lambda entry: entry.get("songId", "")) if item["key"]]
    for index, item in enumerate(song_ranges, start=1):
        start_entry = entries[item["start"]]
        end_entry = entries[item["end"]]
        issue_id = f"song-{index:03d}"
        for field, value in (
            ("songId", start_entry.get("songId", "")),
            ("songNumber", start_entry.get("songNumber", "")),
            ("songTitle", start_entry.get("songTitle", "")),
        ):
            rows.append({
                "issue_id": issue_id,
                "start_entry_id": start_entry.get("id", ""),
                "end_entry_id": end_entry.get("id", ""),
                "field": field,
                "value": value,
                "status": "pending",
                "reason": "Pruefe Songzuordnung",
                "page": start_entry.get("page", ""),
                "confidence": "medium",
            })

    missing_speaker = [entry for entry in entries if entry.get("kind") in LEARNABLE_KINDS and not normalize_whitespace(entry.get("speaker"))]
    for index, entry in enumerate(missing_speaker, start=1):
        rows.append({
            "issue_id": f"speaker-{index:03d}",
            "start_entry_id": entry.get("id", ""),
            "end_entry_id": entry.get("id", ""),
            "field": "speaker",
            "value": "",
            "status": "pending",
            "reason": "Sprecher fehlt",
            "page": entry.get("page", ""),
            "confidence": "low",
        })

    for page in (script.get("pages") or []):
        if page.get("source") == "ocr":
            rows.append({
                "issue_id": f"ocr-{page['pageNumber']:03d}",
                "start_entry_id": "",
                "end_entry_id": "",
                "field": "kind",
                "value": "",
                "status": "info",
                "reason": "Diese Seite wurde per OCR gelesen",
                "page": page.get("pageNumber", ""),
                "confidence": "info",
            })
    return rows


def write_json(path: Path, data: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def write_review_csv(path: Path, rows: Iterable[Dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=REVIEW_COLUMNS)
        writer.writeheader()
        for row in rows:
            payload = {column: row.get(column, "") for column in REVIEW_COLUMNS}
            writer.writerow(payload)


def load_review_csv(path: Path) -> List[Dict[str, str]]:
    with path.open("r", encoding="utf-8", newline="") as handle:
        return list(csv.DictReader(handle))


def parse_bool(value: str) -> bool:
    return normalize_whitespace(value).lower() in {"1", "true", "yes", "ja", "y", "cut"}


def apply_review_rows(script: Dict[str, Any], rows: List[Dict[str, str]]) -> Dict[str, Any]:
    entries = deepcopy(script.get("entries", []))
    index_by_id = {entry.get("id"): index for index, entry in enumerate(entries)}
    for row in rows:
        status = normalize_whitespace(row.get("status")).lower()
        if status not in APPLY_STATUSES:
            continue
        start_id = normalize_whitespace(row.get("start_entry_id"))
        end_id = normalize_whitespace(row.get("end_entry_id")) or start_id
        field = normalize_whitespace(row.get("field"))
        value = row.get("value", "")
        if not start_id or start_id not in index_by_id or not end_id or end_id not in index_by_id:
            continue
        start_index = index_by_id[start_id]
        end_index = index_by_id[end_id]
        if start_index > end_index:
            start_index, end_index = end_index, start_index
        for index in range(start_index, end_index + 1):
            entry = entries[index]
            if field == "speaker":
                entry["speaker"] = normalize_whitespace(value)
                entry["speakerId"] = ""
            elif field == "kind":
                normalized = normalize_whitespace(value).lower()
                if normalized == "line":
                    normalized = "dialogue"
                if normalized:
                    entry["kind"] = normalized
            elif field == "cut":
                entry["cut"] = parse_bool(value)
            elif field in {"actId", "actLabel", "sceneId", "sceneLabel", "songId", "songNumber", "songTitle", "songLabel"}:
                entry[field] = normalize_whitespace(value)
    updated = {
        "schemaVersion": CANONICAL_VERSION,
        "title": script.get("title", "Unbenanntes Skript"),
        "sourceFormat": script.get("sourceFormat", "pdf_import"),
        "sourceFile": script.get("sourceFile", ""),
        "entries": entries,
        "issues": [],
    }
    rebuild_metadata_from_entries(updated)
    updated["issues"] = generate_review_rows(updated)
    return updated


def read_script_json(path: Path) -> Dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def parse_shell_path(value: str) -> Path:
    raw = normalize_whitespace(value)
    if not raw:
        raise ValueError("Pfad darf nicht leer sein.")
    try:
        parts = shlex.split(raw)
    except ValueError:
        parts = [raw.strip("\"'")]
    if not parts:
        raise ValueError("Pfad darf nicht leer sein.")
    if len(parts) == 1:
        return Path(parts[0]).expanduser()
    return Path(" ".join(parts)).expanduser()


def ask(prompt: str, default: Optional[str] = None) -> str:
    suffix = f" [{default}]" if default else ""
    answer = input(f"{prompt}{suffix}: ").strip()
    return answer or (default or "")


def ask_path(prompt: str, default: Optional[Path] = None, must_exist: bool = True) -> Path:
    default_str = str(default) if default else None
    while True:
        value = ask(prompt, default_str)
        try:
            path = parse_shell_path(value)
        except ValueError as exc:
            print(f"Fehler: {exc}")
            continue
        if must_exist and not path.exists():
            print(f"Fehler: Pfad existiert nicht: {path}")
            continue
        return path.resolve() if path.exists() else path


def ask_choice(prompt: str, options: Dict[str, str], default: str) -> str:
    while True:
        value = ask(prompt, default).lower()
        if value in options:
            return value
        print("Bitte eine der Optionen wählen:", ", ".join(f"{key}={label}" for key, label in options.items()))


def suggested_import_paths(pdf_path: Path) -> Dict[str, Path]:
    stem = pdf_path.stem
    return {
        "json": pdf_path.with_name(f"{stem}.json"),
        "review": pdf_path.with_name(f"{stem}_review.csv"),
    }


def suggested_review_paths(script_path: Path, review_path: Path) -> Dict[str, Path]:
    stem = script_path.stem
    return {
        "json": script_path.with_name(f"{stem}_final.json"),
        "review": review_path.with_name(f"{review_path.stem}_aktuell.csv"),
    }


def import_pdf_command(args: argparse.Namespace) -> int:
    pdf_path = Path(args.pdf).expanduser().resolve()
    title = args.title or pdf_path.stem
    pages = extract_pdf_pages(pdf_path, use_ocr=not args.no_ocr, force_ocr=args.force_ocr)
    script = parse_pages_to_script(pages, title, pdf_path.name)
    script["pages"] = pages
    output_path = Path(args.output).expanduser().resolve()
    review_path = Path(args.review).expanduser().resolve()
    write_json(output_path, script)
    write_review_csv(review_path, script["issues"])
    print(f"Skript geschrieben: {output_path}")
    print(f"Review-CSV geschrieben: {review_path}")
    return 0


def apply_review_command(args: argparse.Namespace) -> int:
    script_path = Path(args.script).expanduser().resolve()
    review_path = Path(args.review).expanduser().resolve()
    output_path = Path(args.output).expanduser().resolve()
    script = read_script_json(script_path)
    rows = load_review_csv(review_path)
    updated = apply_review_rows(script, rows)
    write_json(output_path, updated)
    if args.review_out:
        write_review_csv(Path(args.review_out).expanduser().resolve(), updated["issues"])
    print(f"Aktualisiertes Skript geschrieben: {output_path}")
    return 0


def wizard_command(_: argparse.Namespace) -> int:
    print("Import Wizard")
    print("Tipp: Du kannst Pfade direkt ins Terminal ziehen und dann Enter drücken.")
    mode = ask_choice(
        "Modus wählen (i=import, r=review anwenden)",
        {"i": "import", "r": "review"},
        "i",
    )

    if mode == "i":
        status = get_dependency_status()
        if not status["pypdf"]["available"]:
            print("Fehler: pypdf fehlt fuer den PDF-Import.")
            print(f"Installiere es mit: {status['pypdf']['installHint']}")
            return 1
        pdf_path = ask_path("PDF-Datei", must_exist=True)
        defaults = suggested_import_paths(pdf_path)
        title = ask("Titel des Stücks", pdf_path.stem)
        ocr_mode = ask_choice(
            "OCR-Modus (a=automatisch, f=erzwingen, n=aus)",
            {"a": "automatisch", "f": "force", "n": "off"},
            "a",
        )
        if ocr_mode in {"a", "f"} and not status["ocr"]["available"]:
            print("Hinweis: OCR ist lokal nicht voll verfügbar. Es wird nur eingebetteter PDF-Text verwendet.")
        output_path = ask_path("Ziel für Skript-JSON", defaults["json"], must_exist=False)
        review_path = ask_path("Ziel für Review-CSV", defaults["review"], must_exist=False)
        args = argparse.Namespace(
            pdf=str(pdf_path),
            output=str(output_path),
            review=str(review_path),
            title=title,
            no_ocr=(ocr_mode == "n"),
            force_ocr=(ocr_mode == "f"),
        )
        return import_pdf_command(args)

    script_path = ask_path("Kanonisches Skript-JSON", must_exist=True)
    review_path = ask_path("Bearbeitete Review-CSV", must_exist=True)
    defaults = suggested_review_paths(script_path, review_path)
    output_path = ask_path("Ziel für finales JSON", defaults["json"], must_exist=False)
    write_review_out = ask_choice(
        "Aktualisierte Review-CSV zusätzlich schreiben? (j=ja, n=nein)",
        {"j": "ja", "n": "nein"},
        "j",
    )
    review_out = None
    if write_review_out == "j":
        review_out = ask_path("Ziel für aktualisierte Review-CSV", defaults["review"], must_exist=False)

    args = argparse.Namespace(
        script=str(script_path),
        review=str(review_path),
        output=str(output_path),
        review_out=str(review_out) if review_out else None,
    )
    return apply_review_command(args)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="PDF-Importer fuer Musical-Skripte mit Review-CSV.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    import_parser = subparsers.add_parser("import", help="PDF in kanonisches Skript-JSON plus Review-CSV umwandeln.")
    import_parser.add_argument("pdf", help="Pfad zur PDF-Datei")
    import_parser.add_argument("--output", required=True, help="Zielpfad fuer das kanonische JSON")
    import_parser.add_argument("--review", required=True, help="Zielpfad fuer die Review-CSV")
    import_parser.add_argument("--title", help="Titel des Stuecks; Standard ist der PDF-Dateiname")
    import_parser.add_argument("--no-ocr", action="store_true", help="Nur PDF-Text verwenden, kein OCR-Fallback")
    import_parser.add_argument("--force-ocr", action="store_true", help="OCR fuer jede Seite erzwingen")
    import_parser.set_defaults(func=import_pdf_command)

    review_parser = subparsers.add_parser("apply-review", help="Review-CSV auf ein kanonisches Skript-JSON anwenden.")
    review_parser.add_argument("script", help="Pfad zum kanonischen Skript-JSON")
    review_parser.add_argument("review", help="Pfad zur bearbeiteten Review-CSV")
    review_parser.add_argument("--output", required=True, help="Zielpfad fuer das aktualisierte JSON")
    review_parser.add_argument("--review-out", help="Optional: neue Review-CSV aus dem aktualisierten Skript erzeugen")
    review_parser.set_defaults(func=apply_review_command)

    wizard_parser = subparsers.add_parser("wizard", help="Interaktiver Wizard fuer Import oder Review-Anwendung.")
    wizard_parser.set_defaults(func=wizard_command)

    return parser


def main(argv: Optional[List[str]] = None) -> int:
    argv_list = list(argv) if argv is not None else sys.argv[1:]
    if not argv_list:
        try:
            return wizard_command(argparse.Namespace())
        except KeyboardInterrupt:
            print("\nAbgebrochen.")
            return 130
    parser = build_parser()
    args = parser.parse_args(argv_list)
    try:
        return args.func(args)
    except KeyboardInterrupt:  # pragma: no cover - CLI path
        print("\nAbgebrochen.")
        return 130
    except Exception as exc:  # pragma: no cover - CLI path
        print(f"Fehler: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
