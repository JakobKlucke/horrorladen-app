# Import Workflow

## 1. Import Studio starten

Empfohlener Weg:

```bash
python3 tools/import_studio_server.py
```

Der Server öffnet `horrorladen-app/importer.html` im Browser. Wenn Port `8765` belegt ist, nimmt er automatisch einen freien Port und zeigt die URL im Terminal.

Falls `pypdf` fehlt:

```bash
python3 -m pip install pypdf
```

Optional für die LLM-Rollen- und Sprechererkennung:

```bash
export OPENAI_API_KEY="sk-..."
export OPENAI_MODEL="gpt-5-mini"
python3 tools/import_studio_server.py
```

Der API-Key wird nur vom lokalen Server gelesen und nicht im Browser gespeichert.

## 2. Geführter Wizard

Der Browser-Wizard führt durch:

- `PDF`: Datei, Titel, OCR-Modus und `Figuren-Seiten` wählen.
- `Figuren`: Vorschläge aus den gewählten Seiten bestätigen, umbenennen, Aliase ergänzen, zusammenführen, entfernen oder manuell hinzufügen.
- `Sprecher`: vollständiges Textbuch mit Regeln oder optional per LLM den bestätigten Rollen zuordnen.
- `Text`: Sprecher und Zeilentyp pro Eintrag prüfen.
- `Songs`: Nummer, Titel und Sänger je Song pflegen.
- `Striche`: Original links behalten, Strichfassung rechts prüfen.
- `Export`: finales JSON und optional Review-CSV herunterladen.

Der PDF-Schritt erzeugt zunächst nur eine lokale Import-Session, Extraktionsdiagnose und Figurenvorschläge. Die Diagnose zeigt pro Rollen-Seite Zeichenanzahl, Textquelle (`text`, `ocr`, `empty`), OCR-Sprachen und Rohtext-Auszug. Wenn dort fast kein Text sichtbar ist, liegt das Problem an PDF-Text/OCR, nicht an der Rollenlogik.

Standardmäßig werden die ersten 10 Seiten für Figuren geprüft. Im Figuren-Schritt kannst du `Rollen lokal erkennen` erneut ausführen oder, wenn `OPENAI_API_KEY` gesetzt ist, `Rollen mit LLM erkennen`. Der Rollen-LLM-Schritt sendet nur den extrahierten Text der gewählten Rollen-Seiten an OpenAI, nicht die PDF-Datei.

Im Sprecher-Schritt wird das vollständige Textbuch strukturiert. `Mit Regeln zuordnen` ist deterministisch und schnell. `Mit LLM zuordnen` nutzt nur bestätigte Rollen und Aliase; unbekannte Rollen aus der LLM-Antwort werden verworfen. Wenn du Rollen danach änderst, werden Striche und Export gesperrt, bis die Sprecherzuordnung erneut ausgeführt wurde.

Das finale JSON behält die Originaleinträge. Gestrichene Zeilen werden über `cut: true` markiert und in der Lernapp standardmäßig ausgeblendet.

## 3. Terminal-Fallback

Der alte interaktive CLI-Weg bleibt verfügbar:

```bash
python3 tools/import_script.py
```

oder explizit:

```bash
python3 tools/import_script.py wizard
```

```bash
python3 tools/import_script.py import \
  "/pfad/zum/textbuch.pdf" \
  --output "/pfad/zum/neuen_stueck.json" \
  --review "/pfad/zur/neuen_stueck_review.csv" \
  --title "Neues Stück"
```

Optional:

```bash
python3 tools/import_script.py import \
  "/pfad/zum/textbuch.pdf" \
  --output "/pfad/zum/neuen_stueck.json" \
  --review "/pfad/zur/neuen_stueck_review.csv" \
  --force-ocr
```

## 4. Review-CSV bearbeiten

Wichtige Spalten:

- `issue_id`: gruppiert zusammengehörige Review-Zeilen
- `start_entry_id` / `end_entry_id`: Bereich im Skript
- `field`: zu änderndes Feld
- `value`: neuer Wert
- `status`: nur `accepted`-artige Werte werden angewendet

Unterstützte Felder:

- `sceneId`
- `sceneLabel`
- `songId`
- `songNumber`
- `songTitle`
- `speaker`
- `kind`
- `cut`

Die Review-CSV ist nur noch technisches Backup. Für normale Korrekturen ist der Wizard gedacht.

## 5. Review auf das JSON anwenden

```bash
python3 tools/import_script.py apply-review \
  "/pfad/zum/neuen_stueck.json" \
  "/pfad/zur/neuen_stueck_review.csv" \
  --output "/pfad/zum/neuen_stueck_final.json" \
  --review-out "/pfad/zur/neuen_stueck_review_aktuell.csv"
```

## 6. In die App einhängen

Eintrag in `horrorladen-app/scripts.json` ergänzen:

```json
{
  "label": "Neues Stück",
  "file": "neuen_stueck_final.json"
}
```

Danach lädt die App das fertige JSON direkt über die bestehende Skriptauswahl.
