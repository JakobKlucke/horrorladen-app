#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import io
import json
import os
import sys
import tempfile
import uuid
import webbrowser
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from copy import deepcopy
from typing import Any, Dict, List, Optional
from urllib.parse import parse_qs, urlparse
from urllib import error as urlerror
from urllib import request as urlrequest

import import_script


REPO_ROOT = Path(__file__).resolve().parent.parent
APP_DIR = REPO_ROOT / "horrorladen-app"
SCRIPT_PATH = Path(__file__).resolve()
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8765
ROLE_PREVIEW_PAGES = 10
DEFAULT_ROLE_PAGE_RANGE = "1-10"
OPENAI_DEFAULT_MODEL = "gpt-5-mini"
OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses"
SESSIONS: Dict[str, Dict[str, Any]] = {}
ROLE_DESCRIPTION_RE = import_script.re.compile(
    r"^([A-ZÄÖÜ][A-ZÄÖÜ0-9 .'/&-]{1,50})\s*(?:[-–—:]\s+|\s{2,})(.{3,})$"
)
ROLE_ANALYSIS_SCHEMA: Dict[str, Any] = {
    "type": "object",
    "properties": {
        "roles": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "label": {"type": "string"},
                    "aliases": {"type": "array", "items": {"type": "string"}},
                    "description": {"type": "string"},
                    "page": {"type": "integer"},
                    "confidence": {"type": "string", "enum": ["high", "medium", "low"]},
                },
                "required": ["label", "aliases", "description", "page", "confidence"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["roles"],
    "additionalProperties": False,
}
SPEAKER_ASSIGNMENT_SCHEMA: Dict[str, Any] = {
    "type": "object",
    "properties": {
        "assignments": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "entryId": {"type": "string"},
                    "roleId": {"type": "string"},
                    "kind": {"type": "string", "enum": ["dialogue", "lyric", "stage_direction", "narration"]},
                    "confidence": {"type": "string", "enum": ["high", "medium", "low"]},
                },
                "required": ["entryId", "roleId", "kind", "confidence"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["assignments"],
    "additionalProperties": False,
}


def review_rows_to_csv(rows: list[dict[str, Any]]) -> str:
    buffer = io.StringIO()
    writer = csv.DictWriter(buffer, fieldnames=import_script.REVIEW_COLUMNS)
    writer.writeheader()
    for row in rows:
        writer.writerow({column: row.get(column, "") for column in import_script.REVIEW_COLUMNS})
    return buffer.getvalue()


def build_status_payload() -> Dict[str, Any]:
    dependencies = import_script.get_dependency_status()
    openai_model = os.environ.get("OPENAI_MODEL") or OPENAI_DEFAULT_MODEL
    openai_available = bool(os.environ.get("OPENAI_API_KEY"))
    warnings = []
    if not dependencies["pypdf"]["available"]:
        warnings.append("pypdf fehlt. PDF-Import ist gesperrt, bis das Paket installiert ist.")
    if not dependencies["ocr"]["available"]:
        warnings.append("OCR ist nicht voll verfügbar. Der Import nutzt dann nur eingebetteten PDF-Text.")
    elif "deu" not in dependencies["ocr"].get("languages", []):
        warnings.append("Deutsch-OCR ist nicht installiert. Scans deutschsprachiger Textbücher werden wahrscheinlich schlechter erkannt.")
    if not openai_available:
        warnings.append("OPENAI_API_KEY ist nicht gesetzt. LLM-Rollenerkennung bleibt deaktiviert.")
    dependencies["openai"] = {
        "available": openai_available,
        "model": openai_model,
        "installHint": "OPENAI_API_KEY setzen, optional OPENAI_MODEL überschreiben.",
    }
    return {
        "ok": True,
        "appDir": str(APP_DIR),
        "launchCommand": f"{sys.executable} {SCRIPT_PATH}",
        "dependencies": dependencies,
        "warnings": warnings,
    }


def role_item(
    role_id: str,
    label: str,
    aliases: Optional[List[str]] = None,
    confirmed: bool = True,
    description: str = "",
    page: Any = "",
    confidence: str = "medium",
    source: str = "detected",
) -> Dict[str, Any]:
    return {
        "id": role_id or f"role-{import_script.slugify(label)}",
        "label": import_script.normalize_whitespace(label),
        "aliases": import_script.normalize_string_list(aliases or []),
        "confirmed": confirmed,
        "description": import_script.normalize_whitespace(description),
        "page": page,
        "confidence": confidence,
        "source": source,
    }


def is_role_noise(label: str) -> bool:
    clean = import_script.normalize_whitespace(label)
    if not clean:
        return True
    upper = clean.upper()
    if import_script.ACT_RE.match(clean) or import_script.SCENE_RE.match(clean) or import_script.SONG_RE.match(clean):
        return True
    return upper in {
        "PERSONEN",
        "BESETZUNG",
        "CAST",
        "CHARACTERS",
        "ROLLEN",
        "DARSTELLER",
        "ENSEMBLE",
    }


def add_role_candidate(candidates: Dict[str, Dict[str, Any]], label: str, description: str, page: Any, confidence: str, source: str) -> None:
    clean_label = import_script.normalize_whitespace(label).strip(" .")
    if is_role_noise(clean_label):
        return
    role_id = f"role-{import_script.slugify(clean_label)}"
    existing = candidates.get(role_id)
    if existing:
        if description and not existing.get("description"):
            existing["description"] = import_script.normalize_whitespace(description)
        if confidence == "high":
            existing["confidence"] = "high"
            existing["source"] = source
        return
    candidates[role_id] = role_item(role_id, clean_label, [], True, description, page, confidence, source)


def build_role_candidates_from_pages(pages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    candidates: Dict[str, Dict[str, Any]] = {}
    for page in pages:
        page_number = page.get("pageNumber", "")
        lines = import_script.clean_lines(page.get("text", ""))
        for index, line in enumerate(lines):
            if not line:
                continue
            match = ROLE_DESCRIPTION_RE.match(line)
            if match:
                add_role_candidate(candidates, match.group(1), match.group(2), page_number, "high", "description")
                continue
            standalone = import_script.detect_speaker_standalone(line)
            if standalone and index + 1 < len(lines):
                next_line = import_script.normalize_whitespace(lines[index + 1])
                if next_line and not import_script.detect_speaker_standalone(next_line) and not import_script.detect_act(next_line) and not import_script.detect_scene(next_line) and not import_script.detect_song(next_line):
                    add_role_candidate(candidates, standalone, next_line, page_number, "high", "description")
                    continue
            inline = import_script.detect_speaker_inline(line)
            if inline:
                add_role_candidate(candidates, inline["speaker"], "", page_number, "medium", "inline")
    return sorted(candidates.values(), key=lambda item: (item.get("page") or 0, item["label"].upper()))


def parse_role_page_range(value: str = "") -> tuple[str, List[int]]:
    raw = import_script.normalize_whitespace(value) or DEFAULT_ROLE_PAGE_RANGE
    pages: List[int] = []
    for chunk in raw.replace(";", ",").split(","):
        part = import_script.normalize_whitespace(chunk)
        if not part:
            continue
        if "-" in part:
            start_text, end_text = [item.strip() for item in part.split("-", 1)]
            if not start_text.isdigit() or not end_text.isdigit():
                continue
            start, end = int(start_text), int(end_text)
            if start <= 0 or end <= 0:
                continue
            if end < start:
                start, end = end, start
            pages.extend(range(start, end + 1))
            continue
        if part.isdigit() and int(part) > 0:
            pages.append(int(part))
    unique_pages = sorted(set(pages))
    if not unique_pages and raw != DEFAULT_ROLE_PAGE_RANGE:
        return parse_role_page_range(DEFAULT_ROLE_PAGE_RANGE)
    if not unique_pages:
        unique_pages = list(range(1, ROLE_PREVIEW_PAGES + 1))
    normalized = ",".join(str(page) for page in unique_pages)
    if unique_pages == list(range(unique_pages[0], unique_pages[-1] + 1)):
        normalized = f"{unique_pages[0]}-{unique_pages[-1]}" if len(unique_pages) > 1 else str(unique_pages[0])
    return normalized, unique_pages


def select_pages(pages: List[Dict[str, Any]], page_numbers: List[int]) -> List[Dict[str, Any]]:
    allowed = set(page_numbers)
    return [deepcopy(page) for page in pages if int(page.get("pageNumber") or 0) in allowed]


def text_preview(text: str, limit: int = 1600) -> str:
    clean = import_script.normalize_whitespace(text)
    if len(clean) <= limit:
        return clean
    return clean[:limit].rstrip() + " ..."


def build_extraction_diagnostics(
    pages: List[Dict[str, Any]],
    page_range: str,
    role_candidates: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    dependencies = import_script.get_dependency_status()
    ocr_languages = dependencies.get("ocr", {}).get("languages", [])
    page_items = []
    sources: Dict[str, int] = {}
    empty_pages = []
    total_characters = 0
    pages_with_lines = 0
    style_counts = {"bold": 0, "italic": 0, "underline": 0, "allCaps": 0}
    for page in pages:
        text = page.get("text", "") or ""
        source = page.get("source", "unknown") or "unknown"
        characters = len(text)
        lines = page.get("lines") if isinstance(page.get("lines"), list) else []
        if lines:
            pages_with_lines += 1
            for line in lines:
                style = line.get("style") if isinstance(line, dict) and isinstance(line.get("style"), dict) else {}
                for key in style_counts:
                    if style.get(key):
                        style_counts[key] += 1
        total_characters += characters
        sources[source] = sources.get(source, 0) + 1
        if not import_script.normalize_whitespace(text):
            empty_pages.append(page.get("pageNumber"))
        page_items.append({
            "pageNumber": page.get("pageNumber"),
            "characters": characters,
            "source": source,
            "empty": not bool(import_script.normalize_whitespace(text)),
            "styleLines": len(lines),
            "textPreview": text_preview(text),
        })
    warnings = []
    if "deu" not in ocr_languages:
        warnings.append("Deutsch-OCR ist nicht installiert. Für gescannte deutschsprachige PDFs kann die Erkennung deutlich schlechter sein.")
    if empty_pages:
        warnings.append(f"PDF-Text leer oder Scan: Seite(n) {', '.join(str(page) for page in empty_pages)}.")
    if pages and total_characters < 120:
        warnings.append("Sehr wenig Text in den Rollen-Seiten erkannt. Prüfe OCR-Modus oder Seitenbereich.")
    if role_candidates is not None and not role_candidates:
        warnings.append("Keine Rollen lokal erkannt. Prüfe Rohtext, Seitenbereich oder nutze manuelle/LLM-Erkennung.")
    if pages and not pages_with_lines:
        warnings.append("Keine Formatdaten aus der PDF erkannt. Fett/Kursiv/Unterstreichung können dann nicht automatisch genutzt werden.")
    return {
        "pageRange": page_range,
        "pages": page_items,
        "totalCharacters": total_characters,
        "emptyPages": empty_pages,
        "sources": sources,
        "style": {
            "pagesWithLines": pages_with_lines,
            "lineStyleCounts": style_counts,
        },
        "ocrLanguages": ocr_languages,
        "warnings": warnings,
    }


def merge_seed_roles(candidates: List[Dict[str, Any]], seed_roles: Any) -> List[Dict[str, Any]]:
    merged = {role["id"]: role for role in candidates if role.get("id")}
    for role in normalize_roles_payload(seed_roles):
        merged.setdefault(role["id"], role)
    return sorted(merged.values(), key=lambda item: item["label"].upper())


def build_role_candidates(script: Dict[str, Any]) -> List[Dict[str, Any]]:
    roles: Dict[str, Dict[str, Any]] = {}
    for role in script.get("roles", []):
        label = import_script.normalize_whitespace(role.get("label"))
        if not label:
            continue
        item = role_item(
            import_script.normalize_whitespace(role.get("id")),
            label,
            role.get("aliases"),
            True,
            role.get("description", ""),
            role.get("page", ""),
            role.get("confidence", "medium"),
            role.get("source", "script"),
        )
        roles[item["id"]] = item
    for entry in script.get("entries", []):
        label = import_script.normalize_whitespace(entry.get("speaker"))
        if not label:
            continue
        role_id = import_script.normalize_whitespace(entry.get("speakerId")) or f"role-{import_script.slugify(label)}"
        roles.setdefault(role_id, role_item(role_id, label, [], True, "", entry.get("page", ""), "medium", "entry"))
    return sorted(roles.values(), key=lambda item: item["label"].upper())


def build_song_candidates(script: Dict[str, Any]) -> List[Dict[str, Any]]:
    songs = []
    entries_by_song: Dict[str, List[Dict[str, Any]]] = {}
    for entry in script.get("entries", []):
        song_id = import_script.normalize_whitespace(entry.get("songId"))
        if song_id:
            entries_by_song.setdefault(song_id, []).append(entry)
    for song in script.get("songs", []):
        song_id = import_script.normalize_whitespace(song.get("id"))
        song_entries = entries_by_song.get(song_id, [])
        singer_ids = []
        for entry in song_entries:
            speaker_id = import_script.normalize_whitespace(entry.get("speakerId"))
            if speaker_id and speaker_id not in singer_ids:
                singer_ids.append(speaker_id)
        songs.append({
            "id": song_id,
            "number": import_script.normalize_whitespace(song.get("number")),
            "title": import_script.normalize_whitespace(song.get("title")),
            "label": import_script.normalize_whitespace(song.get("label")),
            "actId": import_script.normalize_whitespace(song.get("actId")),
            "sceneId": import_script.normalize_whitespace(song.get("sceneId")),
            "singerIds": import_script.normalize_string_list(song.get("singerIds") or singer_ids),
            "entryCount": len(song_entries),
        })
    return songs


def normalize_roles_payload(roles: Any) -> List[Dict[str, Any]]:
    normalized = []
    for raw in roles or []:
        if not isinstance(raw, dict):
            continue
        label = import_script.normalize_whitespace(raw.get("label") or raw.get("name"))
        if not label:
            continue
        if raw.get("confirmed") is False:
            continue
        normalized.append(role_item(
            import_script.normalize_whitespace(raw.get("id")),
            label,
            raw.get("aliases"),
            True,
            raw.get("description", ""),
            raw.get("page", ""),
            raw.get("confidence", "manual"),
            raw.get("source", "manual"),
        ))
    return normalized


def normalize_songs_payload(songs: Any) -> List[Dict[str, Any]]:
    normalized = []
    for raw in songs or []:
        if not isinstance(raw, dict):
            continue
        song_id = import_script.normalize_whitespace(raw.get("id") or raw.get("songId"))
        number = import_script.normalize_whitespace(raw.get("number") or raw.get("songNumber"))
        title = import_script.normalize_whitespace(raw.get("title") or raw.get("songTitle"))
        label = import_script.normalize_whitespace(raw.get("label") or raw.get("songLabel") or import_script.format_song_label(number, title))
        if not song_id and not number and not title and not label:
            continue
        normalized.append({
            "id": song_id or f"song-{import_script.slugify(number or title or label)}",
            "number": number,
            "title": title or label,
            "label": label or title or song_id,
            "actId": import_script.normalize_whitespace(raw.get("actId")),
            "sceneId": import_script.normalize_whitespace(raw.get("sceneId")),
            "singerIds": import_script.normalize_string_list(raw.get("singerIds")),
        })
    return normalized


def get_role_pages_for_session(session: Dict[str, Any], page_range: str) -> tuple[str, List[Dict[str, Any]]]:
    normalized_range, page_numbers = parse_role_page_range(page_range or session.get("rolePageRange", DEFAULT_ROLE_PAGE_RANGE))
    max_page = max(page_numbers)
    source_pages = session.get("previewSourcePages") or session.get("previewPages") or session.get("pages") or []
    source_page_numbers = {int(page.get("pageNumber") or 0) for page in source_pages}
    if session.get("pdfBytes") and not set(page_numbers).issubset(source_page_numbers):
        with tempfile.TemporaryDirectory(prefix="import-studio-") as tmpdir:
            pdf_path = Path(tmpdir) / session["sourceName"]
            pdf_path.write_bytes(session["pdfBytes"])
            source_pages = import_script.extract_pdf_pages(
                pdf_path,
                use_ocr=(session.get("ocrMode") != "off"),
                force_ocr=(session.get("ocrMode") == "force"),
                max_pages=max_page,
            )
        session["previewSourcePages"] = source_pages
    return normalized_range, select_pages(source_pages, page_numbers)


def build_openai_role_request(pages: List[Dict[str, Any]], seed_roles: Any, model: str) -> Dict[str, Any]:
    page_text = "\n\n".join(
        f"SEITE {page.get('pageNumber')}:\n{page.get('text', '')}"
        for page in pages
    )
    seed_text = json.dumps(normalize_roles_payload(seed_roles), ensure_ascii=False)
    return {
        "model": model,
        "input": [
            {
                "role": "system",
                "content": (
                    "Du extrahierst Figuren/Rollen aus deutsch- oder englischsprachigen Musical-Textbüchern. "
                    "Nutze primär Besetzungslisten, Personenbeschreibungen und klare Rollenlisten. "
                    "Erfinde keine Figuren aus Szenen-, Song- oder Aktüberschriften. "
                    "Gib kurze Bühnenlabels in Großbuchstaben zurück und vollständige Namen als Aliase."
                ),
            },
            {
                "role": "user",
                "content": (
                    "Bestätigte oder manuelle Seed-Rollen:\n"
                    f"{seed_text}\n\n"
                    "Extrahierter PDF-Text:\n"
                    f"{page_text}"
                ),
            },
        ],
        "text": {
            "format": {
                "type": "json_schema",
                "name": "role_candidates",
                "strict": True,
                "schema": ROLE_ANALYSIS_SCHEMA,
            }
        },
    }


def call_openai_responses_api(request_payload: Dict[str, Any], api_key: str) -> Dict[str, Any]:
    body = json.dumps(request_payload, ensure_ascii=False).encode("utf-8")
    request = urlrequest.Request(
        OPENAI_RESPONSES_URL,
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urlrequest.urlopen(request, timeout=90) as response:  # noqa: S310 - explicit OpenAI API endpoint
            return json.loads(response.read().decode("utf-8"))
    except urlerror.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise ValueError(f"OpenAI-Analyse fehlgeschlagen: HTTP {exc.code} {detail}") from exc
    except urlerror.URLError as exc:
        raise ValueError(f"OpenAI-Analyse fehlgeschlagen: {exc.reason}") from exc


def parse_openai_role_response(response: Dict[str, Any]) -> List[Dict[str, Any]]:
    if isinstance(response.get("roles"), list):
        return response["roles"]
    output_text = import_script.normalize_whitespace(response.get("output_text"))
    if not output_text:
        chunks = []
        for item in response.get("output", []) or []:
            for content in item.get("content", []) or []:
                if content.get("type") in {"output_text", "text"} and content.get("text"):
                    chunks.append(content["text"])
        output_text = import_script.normalize_whitespace("\n".join(chunks))
    if not output_text:
        raise ValueError("OpenAI-Antwort enthält keinen auswertbaren JSON-Text.")
    parsed = json.loads(output_text)
    roles = parsed.get("roles")
    if not isinstance(roles, list):
        raise ValueError("OpenAI-Antwort enthält keine Rollenliste.")
    return roles


def parse_openai_speaker_response(response: Dict[str, Any]) -> List[Dict[str, Any]]:
    if isinstance(response.get("assignments"), list):
        return response["assignments"]
    output_text = import_script.normalize_whitespace(response.get("output_text"))
    if not output_text:
        chunks = []
        for item in response.get("output", []) or []:
            for content in item.get("content", []) or []:
                if content.get("type") in {"output_text", "text"} and content.get("text"):
                    chunks.append(content["text"])
        output_text = import_script.normalize_whitespace("\n".join(chunks))
    if not output_text:
        raise ValueError("OpenAI-Antwort enthält keinen auswertbaren Sprecher-JSON-Text.")
    parsed = json.loads(output_text)
    assignments = parsed.get("assignments")
    if not isinstance(assignments, list):
        raise ValueError("OpenAI-Antwort enthält keine Sprecherzuordnungen.")
    return assignments


def normalize_openai_roles(raw_roles: Any) -> List[Dict[str, Any]]:
    roles = []
    for raw in raw_roles or []:
        if not isinstance(raw, dict):
            continue
        label = import_script.normalize_whitespace(raw.get("label"))
        if not label:
            continue
        confidence = import_script.normalize_whitespace(raw.get("confidence")) or "medium"
        if confidence not in {"high", "medium", "low"}:
            confidence = "medium"
        roles.append(role_item(
            f"role-{import_script.slugify(label)}",
            label.upper(),
            raw.get("aliases"),
            True,
            raw.get("description", ""),
            raw.get("page", ""),
            confidence,
            "openai",
        ))
    return sorted(roles, key=lambda item: item["label"].upper())


def build_openai_speaker_request(script: Dict[str, Any], roles: List[Dict[str, Any]], model: str) -> Dict[str, Any]:
    role_payload = [
        {
            "id": role.get("id", ""),
            "label": role.get("label", ""),
            "aliases": role.get("aliases", []),
        }
        for role in roles
        if role.get("id") and role.get("label")
    ]
    entry_payload = [
        {
            "id": entry.get("id", ""),
            "kind": entry.get("kind", ""),
            "speakerId": entry.get("speakerId", ""),
            "speaker": entry.get("speaker", ""),
            "text": entry.get("text", ""),
            "sceneLabel": entry.get("sceneLabel", ""),
            "songLabel": entry.get("songLabel", ""),
            "page": entry.get("page", ""),
        }
        for entry in script.get("entries", [])
    ]
    return {
        "model": model,
        "input": [
            {
                "role": "system",
                "content": (
                    "Du ordnest Skriptzeilen bestätigten Musical-Rollen zu. "
                    "Nutze ausschließlich die angegebenen roleId-Werte. "
                    "Erfinde keine Rollen und lasse unklare Zeilen unzugeordnet. "
                    "Wenn eine erzählerische Zeile eindeutig gesprochener Text einer Rolle ist, darf kind auf dialogue gesetzt werden."
                ),
            },
            {
                "role": "user",
                "content": (
                    "Bestätigte Rollen:\n"
                    f"{json.dumps(role_payload, ensure_ascii=False)}\n\n"
                    "Skripteinträge:\n"
                    f"{json.dumps(entry_payload, ensure_ascii=False)}"
                ),
            },
        ],
        "text": {
            "format": {
                "type": "json_schema",
                "name": "speaker_assignments",
                "strict": True,
                "schema": SPEAKER_ASSIGNMENT_SCHEMA,
            }
        },
    }


def apply_llm_speaker_assignments(script: Dict[str, Any], roles: List[Dict[str, Any]], openai_client=None) -> Dict[str, int]:
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise ValueError("OPENAI_API_KEY ist nicht gesetzt. LLM-Sprecherzuordnung ist deaktiviert.")
    model = os.environ.get("OPENAI_MODEL") or OPENAI_DEFAULT_MODEL
    request_payload = build_openai_speaker_request(script, roles, model)
    response = (openai_client or call_openai_responses_api)(request_payload, api_key)
    assignments = parse_openai_speaker_response(response)
    roles_by_id = {role.get("id"): role for role in roles if role.get("id")}
    entries_by_id = {entry.get("id"): entry for entry in script.get("entries", []) if entry.get("id")}
    applied = 0
    rejected = 0
    for raw in assignments:
        if not isinstance(raw, dict):
            rejected += 1
            continue
        entry = entries_by_id.get(import_script.normalize_whitespace(raw.get("entryId")))
        role = roles_by_id.get(import_script.normalize_whitespace(raw.get("roleId")))
        if not entry or not role:
            rejected += 1
            continue
        kind = import_script.normalize_whitespace(raw.get("kind")).lower()
        if kind in {"dialogue", "lyric", "stage_direction", "narration"}:
            entry["kind"] = kind
        entry["speakerId"] = role["id"]
        entry["speaker"] = role["label"]
        applied += 1
    return {"llmAssignmentsApplied": applied, "llmAssignmentsRejected": rejected}


def build_speaker_diagnostics(script: Dict[str, Any], speaker_mode: str, llm_stats: Optional[Dict[str, int]] = None) -> Dict[str, Any]:
    learnable = [
        entry for entry in script.get("entries", [])
        if entry.get("kind") in import_script.LEARNABLE_KINDS
    ]
    assigned = [entry for entry in learnable if import_script.normalize_whitespace(entry.get("speakerId") or entry.get("speaker"))]
    unassigned = [entry for entry in learnable if entry not in assigned]
    role_counts: Dict[str, Dict[str, Any]] = {}
    for entry in assigned:
        role_id = import_script.normalize_whitespace(entry.get("speakerId")) or import_script.normalize_whitespace(entry.get("speaker"))
        if not role_id:
            continue
        item = role_counts.setdefault(role_id, {
            "roleId": role_id,
            "label": import_script.normalize_whitespace(entry.get("speaker")),
            "entries": 0,
        })
        item["entries"] += 1
    out = {
        "speakerMode": speaker_mode,
        "learnableEntries": len(learnable),
        "assignedLearnable": len(assigned),
        "unassignedLearnable": len(unassigned),
        "unassignedEntryIds": [entry.get("id") for entry in unassigned[:200]],
        "recognizedSpeakers": sorted(role_counts.values(), key=lambda item: item["label"].upper()),
        "llmAssignmentsApplied": 0,
        "llmAssignmentsRejected": 0,
    }
    if llm_stats:
        out.update(llm_stats)
    return out


def analyze_roles_from_session(payload: Dict[str, Any], openai_client=None) -> Dict[str, Any]:
    session_id = import_script.normalize_whitespace(payload.get("sessionId"))
    if not session_id or session_id not in SESSIONS:
        raise ValueError("Import-Session nicht gefunden. Bitte PDF erneut importieren.")
    mode = import_script.normalize_whitespace(payload.get("mode")).lower() or "local"
    if mode not in {"local", "openai"}:
        raise ValueError(f"Unbekannter Rollen-Analysemodus: {mode}")
    session = SESSIONS[session_id]
    page_range, pages = get_role_pages_for_session(session, import_script.normalize_whitespace(payload.get("pageRange")))
    seed_roles = payload.get("seedRoles") or payload.get("roles") or []
    if mode == "local":
        candidates = merge_seed_roles(build_role_candidates_from_pages(pages), seed_roles)
    else:
        api_key = os.environ.get("OPENAI_API_KEY")
        if not api_key:
            raise ValueError("OPENAI_API_KEY ist nicht gesetzt. LLM-Rollenerkennung ist deaktiviert.")
        model = os.environ.get("OPENAI_MODEL") or OPENAI_DEFAULT_MODEL
        request_payload = build_openai_role_request(pages, seed_roles, model)
        response = (openai_client or call_openai_responses_api)(request_payload, api_key)
        candidates = merge_seed_roles(normalize_openai_roles(parse_openai_role_response(response)), seed_roles)
    diagnostics = build_extraction_diagnostics(pages, page_range, candidates)
    return {
        "ok": True,
        "sessionId": session_id,
        "roleCandidates": candidates,
        "diagnostics": diagnostics,
        "summary": {
            "previewPages": len(pages),
            "roleCandidates": len(candidates),
            "warnings": len(diagnostics["warnings"]),
        },
    }


def apply_entry_updates(script: Dict[str, Any], updates: Any, cut_entry_ids: Any) -> Dict[str, Any]:
    entries = script.get("entries", [])
    by_id = {entry.get("id"): entry for entry in entries}
    for entry_id in import_script.normalize_string_list(cut_entry_ids):
        if entry_id in by_id:
            by_id[entry_id]["cut"] = True
    for raw in updates or []:
        if not isinstance(raw, dict):
            continue
        entry_id = import_script.normalize_whitespace(raw.get("id"))
        entry = by_id.get(entry_id)
        if not entry:
            continue
        if "speakerId" in raw:
            entry["speakerId"] = import_script.normalize_whitespace(raw.get("speakerId"))
        if "speaker" in raw:
            entry["speaker"] = import_script.normalize_whitespace(raw.get("speaker"))
        if "kind" in raw:
            kind = import_script.normalize_whitespace(raw.get("kind")).lower()
            if kind == "line":
                kind = "dialogue"
            if kind:
                entry["kind"] = kind
        if "cut" in raw:
            entry["cut"] = bool(raw.get("cut"))
        for field in ("actId", "actLabel", "sceneId", "sceneLabel", "songId", "songNumber", "songTitle", "songLabel"):
            if field in raw:
                entry[field] = import_script.normalize_whitespace(raw.get(field))
    return script


def apply_song_overrides(script: Dict[str, Any], songs: List[Dict[str, Any]]) -> Dict[str, Any]:
    songs_by_id = {song["id"]: song for song in songs if song.get("id")}
    for entry in script.get("entries", []):
        song = songs_by_id.get(import_script.normalize_whitespace(entry.get("songId")))
        if not song:
            continue
        entry["songNumber"] = song.get("number", "")
        entry["songTitle"] = song.get("title", "")
        entry["songLabel"] = song.get("label", "") or import_script.format_song_label(song.get("number", ""), song.get("title", ""))
    script["songs"] = songs
    import_script.rebuild_metadata_from_entries(script)
    import_script.merge_catalog_metadata(script, script.get("roles", []), songs)
    return script


def structure_from_session(payload: Dict[str, Any], openai_client=None) -> Dict[str, Any]:
    session_id = import_script.normalize_whitespace(payload.get("sessionId"))
    if not session_id or session_id not in SESSIONS:
        raise ValueError("Import-Session nicht gefunden. Bitte PDF erneut importieren.")
    speaker_mode = import_script.normalize_whitespace(payload.get("speakerMode")).lower() or "rules"
    if speaker_mode not in {"rules", "llm-assisted"}:
        raise ValueError(f"Unbekannter speakerMode: {speaker_mode}")
    session = SESSIONS[session_id]
    roles = normalize_roles_payload(payload.get("roles"))
    songs = normalize_songs_payload(payload.get("songs"))
    pages = get_full_pages_for_session(session)
    script = import_script.parse_pages_to_script(
        deepcopy(pages),
        session["title"],
        session["sourceName"],
        role_hints=roles,
    )
    script["pages"] = deepcopy(pages)
    script["roles"] = roles
    import_script.rebuild_metadata_from_entries(script)
    import_script.merge_catalog_metadata(script, roles, songs)
    if songs:
        apply_song_overrides(script, songs)
    apply_entry_updates(script, payload.get("entries"), payload.get("cutEntryIds"))
    llm_stats = None
    if speaker_mode == "llm-assisted":
        llm_stats = apply_llm_speaker_assignments(script, roles, openai_client)
    import_script.rebuild_metadata_from_entries(script)
    import_script.merge_catalog_metadata(script, roles, songs or script.get("songs", []))
    script["roles"] = roles
    script["issues"] = import_script.generate_review_rows(script)
    script["speakerDiagnostics"] = build_speaker_diagnostics(script, speaker_mode, llm_stats)
    return script


def get_full_pages_for_session(session: Dict[str, Any]) -> List[Dict[str, Any]]:
    if session.get("fullPages"):
        return deepcopy(session["fullPages"])
    if not session.get("pdfBytes"):
        return deepcopy(session.get("pages", []))
    with tempfile.TemporaryDirectory(prefix="import-studio-") as tmpdir:
        pdf_path = Path(tmpdir) / session["sourceName"]
        pdf_path.write_bytes(session["pdfBytes"])
        pages = import_script.extract_pdf_pages(
            pdf_path,
            use_ocr=(session.get("ocrMode") != "off"),
            force_ocr=(session.get("ocrMode") == "force"),
        )
    session["fullPages"] = pages
    return deepcopy(pages)


def import_pdf_bytes(pdf_bytes: bytes, title: str, source_name: str, ocr_mode: str, role_page_range: str = DEFAULT_ROLE_PAGE_RANGE) -> Dict[str, Any]:
    source_filename = Path(source_name or "script.pdf").name or "script.pdf"
    if not pdf_bytes:
        raise ValueError("Die PDF-Datei ist leer.")
    if ocr_mode not in {"auto", "force", "off"}:
        raise ValueError(f"Unbekannter OCR-Modus: {ocr_mode}")
    normalized_range, page_numbers = parse_role_page_range(role_page_range)
    max_page = max(page_numbers)

    with tempfile.TemporaryDirectory(prefix="import-studio-") as tmpdir:
        pdf_path = Path(tmpdir) / source_filename
        pdf_path.write_bytes(pdf_bytes)
        preview_source_pages = import_script.extract_pdf_pages(
            pdf_path,
            use_ocr=(ocr_mode != "off"),
            force_ocr=(ocr_mode == "force"),
            max_pages=max_page,
        )
        preview_pages = select_pages(preview_source_pages, page_numbers)
        session_id = uuid.uuid4().hex
        SESSIONS[session_id] = {
            "pdfBytes": pdf_bytes,
            "previewSourcePages": preview_source_pages,
            "previewPages": preview_pages,
            "title": title or Path(source_filename).stem,
            "sourceName": source_filename,
            "ocrMode": ocr_mode,
            "rolePageRange": normalized_range,
        }
        role_candidates = build_role_candidates_from_pages(preview_pages)
        diagnostics = build_extraction_diagnostics(preview_pages, normalized_range, role_candidates)
        return {
            "ok": True,
            "sessionId": session_id,
            "filenameBase": Path(source_filename).stem or "skript",
            "previewPages": preview_pages,
            "roleCandidates": role_candidates,
            "diagnostics": diagnostics,
            "songCandidates": [],
            "reviewRows": [],
            "reviewCsv": review_rows_to_csv([]),
            "summary": {
                "previewPages": len(preview_pages),
                "roleCandidates": len(role_candidates),
                "warnings": len(diagnostics["warnings"]),
                "entries": 0,
                "issues": 0,
            },
        }


class ImportStudioHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, directory: Optional[str] = None, **kwargs):
        super().__init__(*args, directory=directory or str(APP_DIR), **kwargs)

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, format: str, *args) -> None:  # noqa: A003
        print(f"[import-studio] {self.address_string()} - {format % args}")

    def send_json(self, status_code: int, payload: Dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_request_body(self) -> bytes:
        content_length = int(self.headers.get("Content-Length") or "0")
        if content_length <= 0:
            return b""
        return self.rfile.read(content_length)

    def read_json_body(self) -> Dict[str, Any]:
        body = self.read_request_body()
        if not body:
            return {}
        return json.loads(body.decode("utf-8"))

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path == "/api/status":
            self.send_json(HTTPStatus.OK, build_status_payload())
            return
        if parsed.path == "/":
            self.path = "/importer.html"
        super().do_GET()

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path == "/api/import":
            self.handle_import(parsed)
            return
        if parsed.path == "/api/roles/analyze":
            self.handle_roles_analyze()
            return
        if parsed.path == "/api/structure":
            self.handle_structure()
            return
        self.send_json(HTTPStatus.NOT_FOUND, {"ok": False, "error": "Unbekannter API-Pfad."})

    def handle_import(self, parsed) -> None:
        query = parse_qs(parsed.query)
        title = import_script.normalize_whitespace(query.get("title", [""])[0])
        ocr_mode = import_script.normalize_whitespace(query.get("ocrMode", ["auto"])[0]).lower() or "auto"
        source_name = import_script.normalize_whitespace(query.get("sourceName", ["script.pdf"])[0]) or "script.pdf"
        role_page_range = import_script.normalize_whitespace(query.get("rolePages", [DEFAULT_ROLE_PAGE_RANGE])[0]) or DEFAULT_ROLE_PAGE_RANGE
        pdf_bytes = self.read_request_body()

        try:
            payload = import_pdf_bytes(pdf_bytes, title, source_name, ocr_mode, role_page_range)
        except Exception as exc:
            self.send_json(
                HTTPStatus.BAD_REQUEST,
                {
                    "ok": False,
                    "error": str(exc),
                    "status": build_status_payload(),
                },
            )
            return

        self.send_json(HTTPStatus.OK, payload)

    def handle_roles_analyze(self) -> None:
        try:
            payload = self.read_json_body()
            result = analyze_roles_from_session(payload)
            self.send_json(HTTPStatus.OK, result)
        except Exception as exc:
            self.send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": str(exc), "status": build_status_payload()})

    def handle_structure(self) -> None:
        try:
            payload = self.read_json_body()
            script = structure_from_session(payload)
            self.send_json(
                HTTPStatus.OK,
                {
                    "ok": True,
                    "script": script,
                    "reviewRows": script.get("issues", []),
                    "songCandidates": build_song_candidates(script),
                    "roleCandidates": build_role_candidates(script),
                    "speakerDiagnostics": script.get("speakerDiagnostics", {}),
                    "summary": {
                        "pages": len(script.get("pages", [])),
                        "entries": len(script.get("entries", [])),
                        "issues": len(script.get("issues", [])),
                    },
                },
            )
        except Exception as exc:
            self.send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": str(exc)})


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Lokaler Webserver fuer das Import Studio.")
    parser.add_argument("--host", default=DEFAULT_HOST, help="Host fuer den lokalen Server")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help="Port fuer den lokalen Server")
    parser.add_argument("--no-open", action="store_true", help="Browser nicht automatisch oeffnen")
    return parser


def main(argv: Optional[list[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    if not APP_DIR.exists():
        raise SystemExit(f"Frontend-Verzeichnis fehlt: {APP_DIR}")

    handler_factory = lambda *handler_args, **handler_kwargs: ImportStudioHandler(
        *handler_args,
        directory=str(APP_DIR),
        **handler_kwargs,
    )
    try:
        server = ThreadingHTTPServer((args.host, args.port), handler_factory)
    except OSError:
        if args.port != DEFAULT_PORT:
            raise
        server = ThreadingHTTPServer((args.host, 0), handler_factory)
        print(f"Port {DEFAULT_PORT} ist belegt, nutze Port {server.server_port}.")
    url = f"http://{args.host}:{server.server_port}/importer.html"
    print(f"Import Studio läuft auf {url}")
    print(f"Statische Dateien: {APP_DIR}")
    if not args.no_open:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nImport Studio beendet.")
        return 130
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
