import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))

import import_script  # noqa: E402


class ImportScriptTests(unittest.TestCase):
    def test_parse_shell_path_handles_quotes_and_escaped_spaces(self):
        quoted = import_script.parse_shell_path('"/tmp/Mein Stück.pdf"')
        escaped = import_script.parse_shell_path('/tmp/Mein\\ Stück.pdf')

        self.assertEqual(quoted, Path('/tmp/Mein Stück.pdf'))
        self.assertEqual(escaped, Path('/tmp/Mein Stück.pdf'))

    def test_suggested_paths_are_derived_from_source_files(self):
        import_defaults = import_script.suggested_import_paths(Path('/tmp/Stueck.pdf'))
        review_defaults = import_script.suggested_review_paths(
            Path('/tmp/Stueck.json'),
            Path('/tmp/Stueck_review.csv'),
        )

        self.assertEqual(import_defaults['json'], Path('/tmp/Stueck.json'))
        self.assertEqual(import_defaults['review'], Path('/tmp/Stueck_review.csv'))
        self.assertEqual(review_defaults['json'], Path('/tmp/Stueck_final.json'))
        self.assertEqual(review_defaults['review'], Path('/tmp/Stueck_review_aktuell.csv'))

    def test_parse_pages_to_script_derives_structure_and_review_rows(self):
        pages = [{
            "pageNumber": 1,
            "text": "\n".join([
                "Erster Akt",
                "1. Szene",
                "Nr. 1 OPENING",
                "SEYMOUR: Hallo Welt",
                "AUDREY",
                "ICH SINGE",
                "(Licht aus)",
            ]),
            "source": "text",
        }]

        script = import_script.parse_pages_to_script(pages, "Demo", "demo.pdf")

        self.assertEqual(script["title"], "Demo")
        self.assertEqual(len(script["acts"]), 1)
        self.assertEqual(len(script["scenes"]), 1)
        self.assertEqual(len(script["songs"]), 1)
        self.assertEqual(script["entries"][0]["speaker"], "SEYMOUR")
        self.assertEqual(script["entries"][1]["kind"], "lyric")
        self.assertTrue(any(row["field"] == "sceneLabel" for row in script["issues"]))
        self.assertTrue(any(row["field"] == "songTitle" for row in script["issues"]))

    def test_role_hints_map_aliases_and_avoid_unconfirmed_uppercase_speakers(self):
        pages = [{
            "pageNumber": 1,
            "text": "\n".join([
                "GOMEZ ADDAMS: Hallo Familie",
                "UNBESTAETIGTE ZEILE",
                "Nicht alles in Grossbuchstaben ist ein Sprecher",
            ]),
            "source": "text",
        }]
        roles = [{
            "id": "role-gomez",
            "label": "GOMEZ",
            "aliases": ["GOMEZ ADDAMS"],
        }]

        script = import_script.parse_pages_to_script(pages, "Demo", "demo.pdf", role_hints=roles)

        self.assertEqual(script["entries"][0]["speaker"], "GOMEZ")
        self.assertEqual(script["entries"][0]["speakerId"], "role-gomez")
        self.assertTrue(any(entry["text"] == "UNBESTAETIGTE ZEILE" and entry["kind"] == "narration" for entry in script["entries"]))
        self.assertEqual(script["roles"][0]["aliases"], ["GOMEZ ADDAMS"])

    def test_parse_pages_to_script_uses_style_hints_when_available(self):
        pages = [{
            "pageNumber": 1,
            "text": "\n".join([
                "GARTEN",
                "GOMEZ",
                "Hallo Familie",
                "geht zum Fenster",
            ]),
            "source": "text",
            "lines": [
                {"text": "GARTEN", "style": {"bold": True, "underline": True, "allCaps": True}},
                {"text": "GOMEZ", "style": {"bold": True, "allCaps": True}},
                {"text": "Hallo Familie", "style": {}},
                {"text": "geht zum Fenster", "style": {"italic": True}},
            ],
        }]
        roles = [{"id": "role-gomez", "label": "GOMEZ", "aliases": []}]

        script = import_script.parse_pages_to_script(pages, "Demo", "demo.pdf", role_hints=roles)

        self.assertEqual(script["scenes"][0]["label"], "GARTEN")
        self.assertEqual(script["entries"][0]["speaker"], "GOMEZ")
        self.assertEqual(script["entries"][0]["text"], "Hallo Familie")
        self.assertEqual(script["entries"][0]["source"]["styleHints"]["bold"], False)
        self.assertEqual(script["entries"][1]["kind"], "stage_direction")
        self.assertEqual(script["entries"][1]["source"]["styleHints"]["italic"], True)

    def test_apply_review_rows_is_deterministic(self):
        script = {
            "schemaVersion": 2,
            "title": "Demo",
            "sourceFormat": "pdf_import",
            "entries": [
                {
                    "id": "entry-00001",
                    "order": 1,
                    "kind": "dialogue",
                    "text": "Hallo",
                    "speaker": "SEYMOUR",
                    "speakerId": "",
                    "actId": "act-1",
                    "actLabel": "Erster Akt",
                    "sceneId": "scene-a",
                    "sceneLabel": "1. Szene",
                    "songId": "",
                    "songNumber": "",
                    "songTitle": "",
                    "songLabel": "",
                    "cut": False,
                },
                {
                    "id": "entry-00002",
                    "order": 2,
                    "kind": "dialogue",
                    "text": "Welt",
                    "speaker": "AUDREY",
                    "speakerId": "",
                    "actId": "act-1",
                    "actLabel": "Erster Akt",
                    "sceneId": "scene-a",
                    "sceneLabel": "1. Szene",
                    "songId": "",
                    "songNumber": "",
                    "songTitle": "",
                    "songLabel": "",
                    "cut": False,
                },
            ],
            "issues": [],
        }
        import_script.rebuild_metadata_from_entries(script)
        rows = [
            {
                "issue_id": "scene-001",
                "start_entry_id": "entry-00001",
                "end_entry_id": "entry-00002",
                "field": "sceneId",
                "value": "scene-b",
                "status": "accepted",
            },
            {
                "issue_id": "scene-001",
                "start_entry_id": "entry-00001",
                "end_entry_id": "entry-00002",
                "field": "sceneLabel",
                "value": "2. Szene",
                "status": "accepted",
            },
            {
                "issue_id": "cut-001",
                "start_entry_id": "entry-00002",
                "end_entry_id": "entry-00002",
                "field": "cut",
                "value": "true",
                "status": "accepted",
            },
        ]

        first = import_script.apply_review_rows(script, rows)
        second = import_script.apply_review_rows(first, rows)

        self.assertEqual(first["entries"][0]["sceneLabel"], "2. Szene")
        self.assertEqual(first["entries"][1]["cut"], True)
        self.assertEqual(json.dumps(first, sort_keys=True), json.dumps(second, sort_keys=True))

    def test_review_csv_round_trip(self):
        rows = [{
            "issue_id": "scene-001",
            "start_entry_id": "entry-00001",
            "end_entry_id": "entry-00002",
            "field": "sceneLabel",
            "value": "1. Szene",
            "status": "pending",
            "reason": "Pruefe Szenenzuordnung",
            "page": 1,
            "confidence": "medium",
        }]

        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "review.csv"
            import_script.write_review_csv(path, rows)
            loaded = import_script.load_review_csv(path)

        self.assertEqual(loaded[0]["issue_id"], "scene-001")
        self.assertEqual(loaded[0]["field"], "sceneLabel")


if __name__ == "__main__":
    unittest.main()
