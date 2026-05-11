import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))

import import_studio_server  # noqa: E402


class ImportStudioServerTests(unittest.TestCase):
    def setUp(self):
        import_studio_server.SESSIONS.clear()

    def test_review_rows_to_csv_writes_expected_columns(self):
        csv_text = import_studio_server.review_rows_to_csv([{
            "issue_id": "scene-001",
            "start_entry_id": "entry-00001",
            "end_entry_id": "entry-00003",
            "field": "sceneLabel",
            "value": "1. Szene",
            "status": "pending",
        }])

        self.assertIn("issue_id,start_entry_id,end_entry_id,field,value,status,reason,page,confidence", csv_text)
        self.assertIn("scene-001,entry-00001,entry-00003,sceneLabel,1. Szene,pending,,,", csv_text)

    def test_status_payload_reports_dependency_and_openai_hints(self):
        original = import_studio_server.import_script.get_dependency_status

        def fake_status():
            return {
                "pypdf": {"available": False, "installHint": "python -m pip install pypdf"},
                "ocr": {"available": True, "languages": ["eng"], "tesseract": "/usr/bin/tesseract", "sips": "/usr/bin/sips"},
            }

        import_studio_server.import_script.get_dependency_status = fake_status
        try:
            with mock.patch.dict(import_studio_server.os.environ, {}, clear=True):
                payload = import_studio_server.build_status_payload()
        finally:
            import_studio_server.import_script.get_dependency_status = original

        self.assertFalse(payload["dependencies"]["pypdf"]["available"])
        self.assertEqual(payload["dependencies"]["pypdf"]["installHint"], "python -m pip install pypdf")
        self.assertFalse(payload["dependencies"]["openai"]["available"])
        self.assertTrue(any("Deutsch-OCR" in warning for warning in payload["warnings"]))

    def test_import_pdf_bytes_returns_session_and_candidates(self):
        original = import_studio_server.import_script.extract_pdf_pages
        calls = []

        def fake_extract(_path, use_ocr=True, force_ocr=False, max_pages=None):
            calls.append({
                "use_ocr": use_ocr,
                "force_ocr": force_ocr,
                "max_pages": max_pages,
            })
            return [{
                "pageNumber": 1,
                "text": "\n".join([
                    "GOMEZ - Vater der Familie",
                    "MORTICIA: Mutter der Familie",
                ]),
                "source": "text",
            }]

        import_studio_server.import_script.extract_pdf_pages = fake_extract
        try:
            payload = import_studio_server.import_pdf_bytes(b"%PDF-FAKE", "Demo", "demo.pdf", "off", "1-5")
        finally:
            import_studio_server.import_script.extract_pdf_pages = original

        self.assertTrue(payload["ok"])
        self.assertIn(payload["sessionId"], import_studio_server.SESSIONS)
        self.assertNotIn("script", payload)
        self.assertEqual(calls[0]["max_pages"], 5)
        self.assertEqual(payload["previewPages"][0]["pageNumber"], 1)
        self.assertEqual(payload["roleCandidates"][0]["label"], "GOMEZ")
        self.assertEqual(payload["roleCandidates"][0]["description"], "Vater der Familie")
        self.assertEqual(payload["roleCandidates"][0]["page"], 1)
        self.assertEqual(payload["roleCandidates"][0]["confidence"], "high")
        self.assertEqual(payload["diagnostics"]["pageRange"], "1-5")
        self.assertEqual(payload["diagnostics"]["pages"][0]["characters"], len("GOMEZ - Vater der Familie\nMORTICIA: Mutter der Familie"))
        self.assertEqual(payload["diagnostics"]["pages"][0]["source"], "text")
        self.assertEqual(payload["summary"]["entries"], 0)

    def test_import_pdf_bytes_defaults_to_first_ten_pages_and_finds_page_eight_roles(self):
        original = import_studio_server.import_script.extract_pdf_pages
        calls = []

        def fake_extract(_path, use_ocr=True, force_ocr=False, max_pages=None):
            calls.append(max_pages)
            return [
                {"pageNumber": page, "text": "Vorspann", "source": "text"}
                for page in range(1, 8)
            ] + [
                {"pageNumber": 8, "text": "GOMEZ - Vater der Familie", "source": "text"},
                {"pageNumber": 9, "text": "Weitere Hinweise", "source": "text"},
                {"pageNumber": 10, "text": "Ende Vorspann", "source": "text"},
            ]

        import_studio_server.import_script.extract_pdf_pages = fake_extract
        try:
            payload = import_studio_server.import_pdf_bytes(b"%PDF-FAKE", "Demo", "demo.pdf", "off")
        finally:
            import_studio_server.import_script.extract_pdf_pages = original

        self.assertEqual(calls[0], 10)
        self.assertEqual(payload["diagnostics"]["pageRange"], "1-10")
        self.assertEqual(payload["roleCandidates"][0]["label"], "GOMEZ")
        self.assertEqual(payload["roleCandidates"][0]["page"], 8)

    def test_import_pdf_bytes_uses_role_page_range_and_warns_for_empty_text(self):
        original = import_studio_server.import_script.extract_pdf_pages
        calls = []

        def fake_extract(_path, use_ocr=True, force_ocr=False, max_pages=None):
            calls.append(max_pages)
            return [
                {"pageNumber": 1, "text": "Titel", "source": "text"},
                {"pageNumber": 2, "text": "", "source": "empty"},
                {"pageNumber": 3, "text": "GOMEZ - Vater", "source": "text"},
            ]

        import_studio_server.import_script.extract_pdf_pages = fake_extract
        try:
            payload = import_studio_server.import_pdf_bytes(b"%PDF-FAKE", "Demo", "demo.pdf", "off", "2-3")
        finally:
            import_studio_server.import_script.extract_pdf_pages = original

        self.assertEqual(calls[0], 3)
        self.assertEqual([page["pageNumber"] for page in payload["previewPages"]], [2, 3])
        self.assertEqual(payload["roleCandidates"][0]["label"], "GOMEZ")
        self.assertTrue(any("PDF-Text leer oder Scan" in warning for warning in payload["diagnostics"]["warnings"]))

    def test_role_candidates_from_preview_pages_include_descriptions(self):
        pages = [
            {
                "pageNumber": 2,
                "text": "\n".join([
                    "PERSONEN",
                    "GOMEZ ADDAMS - Vater, liebt dramatische Auftritte",
                    "MORTICIA: Mutter, elegant und direkt",
                    "LURCH",
                    "Der Butler der Familie",
                    "1. Szene",
                ]),
                "source": "text",
            },
            {
                "pageNumber": 6,
                "text": "LURCH: Butler",
                "source": "text",
            },
        ]

        candidates = import_studio_server.build_role_candidates_from_pages(pages[:1])
        labels = [candidate["label"] for candidate in candidates]

        self.assertEqual(labels, ["GOMEZ ADDAMS", "LURCH", "MORTICIA"])
        self.assertEqual(candidates[0]["description"], "Vater, liebt dramatische Auftritte")
        self.assertEqual(candidates[0]["source"], "description")
        self.assertEqual(candidates[1]["description"], "Der Butler der Familie")
        self.assertEqual(candidates[1]["source"], "description")

    def test_structure_from_session_uses_confirmed_roles_deterministically(self):
        session_id = "session-test"
        import_studio_server.SESSIONS[session_id] = {
            "title": "Demo",
            "sourceName": "demo.pdf",
            "pages": [{
                "pageNumber": 1,
                "text": "\n".join([
                    "GOMEZ",
                    "Hallo",
                    "UNBESTAETIGTE ZEILE",
                ]),
                "source": "text",
            }],
        }
        payload = {
            "sessionId": session_id,
            "roles": [{"id": "role-gomez", "label": "GOMEZ", "aliases": [], "confirmed": True}],
            "songs": [],
            "entries": [],
            "cutEntryIds": [],
        }

        first = import_studio_server.structure_from_session(payload)
        second = import_studio_server.structure_from_session(payload)

        self.assertEqual(first["entries"][0]["speaker"], "GOMEZ")
        self.assertTrue(any(entry["text"] == "UNBESTAETIGTE ZEILE" and entry["kind"] == "narration" for entry in first["entries"]))
        self.assertEqual(first["speakerDiagnostics"]["assignedLearnable"], 1)
        self.assertEqual(first["speakerDiagnostics"]["unassignedLearnable"], 0)
        self.assertEqual(first, second)

    def test_structure_from_session_rejects_invalid_speaker_mode(self):
        import_studio_server.SESSIONS["session-mode"] = {
            "title": "Demo",
            "sourceName": "demo.pdf",
            "pages": [{"pageNumber": 1, "text": "GOMEZ\nHallo", "source": "text"}],
        }

        with self.assertRaisesRegex(ValueError, "speakerMode"):
            import_studio_server.structure_from_session({
                "sessionId": "session-mode",
                "speakerMode": "unknown",
                "roles": [{"id": "role-gomez", "label": "GOMEZ", "aliases": [], "confirmed": True}],
            })

    def test_structure_from_session_llm_assisted_uses_only_confirmed_roles(self):
        session_id = "session-llm-speakers"
        import_studio_server.SESSIONS[session_id] = {
            "title": "Demo",
            "sourceName": "demo.pdf",
            "pages": [{
                "pageNumber": 1,
                "text": "\n".join([
                    "Hallo, meine Familie.",
                    "Das ist kein Sprecher.",
                ]),
                "source": "text",
            }],
        }
        calls = []

        def fake_client(request_payload, api_key):
            calls.append((request_payload, api_key))
            return {
                "assignments": [
                    {"entryId": "entry-00001", "roleId": "role-gomez", "kind": "dialogue", "confidence": "high"},
                    {"entryId": "entry-00002", "roleId": "role-unknown", "kind": "dialogue", "confidence": "high"},
                ]
            }

        with mock.patch.dict(import_studio_server.os.environ, {"OPENAI_API_KEY": "test-key", "OPENAI_MODEL": "test-model"}, clear=True):
            script = import_studio_server.structure_from_session({
                "sessionId": session_id,
                "speakerMode": "llm-assisted",
                "roles": [{"id": "role-gomez", "label": "GOMEZ", "aliases": [], "confirmed": True}],
                "songs": [],
                "entries": [],
                "cutEntryIds": [],
            }, openai_client=fake_client)

        self.assertEqual(script["entries"][0]["speakerId"], "role-gomez")
        self.assertEqual(script["entries"][0]["speaker"], "GOMEZ")
        self.assertEqual(script["entries"][0]["kind"], "dialogue")
        self.assertEqual(script["entries"][1]["speakerId"], "")
        self.assertEqual(script["speakerDiagnostics"]["speakerMode"], "llm-assisted")
        self.assertEqual(script["speakerDiagnostics"]["llmAssignmentsApplied"], 1)
        self.assertEqual(calls[0][0]["model"], "test-model")
        self.assertEqual(calls[0][0]["text"]["format"]["type"], "json_schema")

    def test_analyze_roles_local_reuses_session_pages_and_seed_roles(self):
        session_id = "session-roles"
        import_studio_server.SESSIONS[session_id] = {
            "title": "Demo",
            "sourceName": "demo.pdf",
            "previewPages": [
                {"pageNumber": 1, "text": "GOMEZ - Vater", "source": "text"},
                {"pageNumber": 2, "text": "MORTICIA: Mutter", "source": "text"},
            ],
        }

        payload = import_studio_server.analyze_roles_from_session({
            "sessionId": session_id,
            "mode": "local",
            "pageRange": "1-2",
            "seedRoles": [{"id": "role-wednesday", "label": "WEDNESDAY", "aliases": ["WEDNESDAY ADDAMS"]}],
        })

        labels = [role["label"] for role in payload["roleCandidates"]]
        self.assertEqual(labels, ["GOMEZ", "MORTICIA", "WEDNESDAY"])
        self.assertEqual(payload["diagnostics"]["pageRange"], "1-2")

    def test_analyze_roles_openai_requires_api_key(self):
        session_id = "session-openai-missing-key"
        import_studio_server.SESSIONS[session_id] = {
            "title": "Demo",
            "sourceName": "demo.pdf",
            "previewPages": [{"pageNumber": 1, "text": "GOMEZ - Vater", "source": "text"}],
        }

        with mock.patch.dict(import_studio_server.os.environ, {}, clear=True):
            with self.assertRaisesRegex(ValueError, "OPENAI_API_KEY"):
                import_studio_server.analyze_roles_from_session({
                    "sessionId": session_id,
                    "mode": "openai",
                    "pageRange": "1",
                    "seedRoles": [],
                })

        self.assertEqual(import_studio_server.SESSIONS[session_id]["previewPages"][0]["text"], "GOMEZ - Vater")

    def test_analyze_roles_openai_uses_structured_output_client(self):
        session_id = "session-openai"
        import_studio_server.SESSIONS[session_id] = {
            "title": "Demo",
            "sourceName": "demo.pdf",
            "previewPages": [{"pageNumber": 1, "text": "Besetzung\nGomez Addams, Vater\nMorticia Addams, Mutter", "source": "text"}],
        }
        calls = []

        def fake_client(request_payload, api_key):
            calls.append((request_payload, api_key))
            return {
                "roles": [
                    {
                        "label": "GOMEZ",
                        "aliases": ["Gomez Addams"],
                        "description": "Vater",
                        "page": 1,
                        "confidence": "high",
                    },
                    {
                        "label": "MORTICIA",
                        "aliases": ["Morticia Addams"],
                        "description": "Mutter",
                        "page": 1,
                        "confidence": "high",
                    },
                ]
            }

        with mock.patch.dict(import_studio_server.os.environ, {"OPENAI_API_KEY": "test-key", "OPENAI_MODEL": "test-model"}, clear=True):
            payload = import_studio_server.analyze_roles_from_session({
                "sessionId": session_id,
                "mode": "openai",
                "pageRange": "1",
                "seedRoles": [],
            }, openai_client=fake_client)

        self.assertEqual([role["label"] for role in payload["roleCandidates"]], ["GOMEZ", "MORTICIA"])
        self.assertEqual(payload["roleCandidates"][0]["source"], "openai")
        self.assertEqual(calls[0][1], "test-key")
        self.assertEqual(calls[0][0]["model"], "test-model")
        self.assertEqual(calls[0][0]["text"]["format"]["type"], "json_schema")


if __name__ == "__main__":
    unittest.main()
