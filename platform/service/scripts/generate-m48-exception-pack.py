"""Offline-only M48 first-time usability fixtures. Does not upload or call AI."""
from pathlib import Path
from hashlib import sha256
from shutil import copyfile
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A4
from reportlab.lib.colors import HexColor
from pypdf import PdfReader
import json

root = Path(__file__).resolve().parents[3]
base = root / "output/pdf/m48-zero-guidance-acceptance-pack"
target = base / "EXCEPTION_UPLOAD"
specs = [
    ("12_Maple_Ridge_Invoice_2027-02.pdf", "INVOICE", [
        "Maple Ridge Workshop Limited (Fictional)",
        "Issued to: Cedar Grove Services Limited (Fictional)",
        "Invoice MR-2702 | Issued 18 February 2027",
        "Service: workshop planning | Quantity 1 | Net NZD 200.00",
        "GST NZD 30.00 | Total NZD 230.00",
        "This invoice does not belong to Kauri Lantern Studio.",
    ], "wrong_subject"),
    ("13_Kauri_Lantern_Bank_Statement_2026-12.pdf", "BANK STATEMENT", [
        "Kauri Lantern Studio Limited (Fictional)",
        "Imaginary Example Bank | Demo account KL-0000",
        "Statement period: 01 December 2026 - 31 December 2026",
        "Opening balance NZD 1,000.00",
        "05 Dec | Fictional service income | +300.00",
        "16 Dec | Fictional office supplies | -100.00",
        "Closing balance NZD 1,200.00",
    ], "wrong_period"),
    ("14_Kauri_Lantern_Studio_Workshop_Agenda.pdf", "STUDIO WORKSHOP AGENDA", [
        "Kauri Lantern Studio Limited (Fictional)",
        "Quarter 2027-Q1 | Internal creative workshop",
        "09:00 - Discuss three fictional colour palettes.",
        "10:00 - Sketch imaginary exhibition layouts.",
        "11:00 - Share draft illustrations and collect feedback.",
        "This is not an invoice, receipt, bank statement or GST workpaper.",
        "No transaction, account balance or tax calculation is included.",
    ], "irrelevant_or_unknown"),
]
names = [s[0] for s in specs] + ["15_Kauri_Lantern_Bank_Statement_COPY.pdf"]
if any((target / name).exists() for name in names):
    raise SystemExit("Refusing to overwrite an existing acceptance fixture")
target.mkdir(parents=True, exist_ok=True)
manifest = []
for name, title, lines, expected in specs:
    path = target / name
    c = canvas.Canvas(str(path), pagesize=A4, invariant=1)
    width, height = A4
    c.setFillColor(HexColor("#8b3329"))
    c.setFont("Helvetica-Bold", 11)
    c.drawString(45, height - 48, "PURELY FICTIONAL - UAT TEST ONLY")
    c.setFillColor(HexColor("#182d33"))
    c.setFont("Helvetica-Bold", 21)
    c.drawString(45, height - 100, title)
    c.setStrokeColor(HexColor("#aac1bc"))
    c.line(45, height - 122, width - 45, height - 122)
    c.setFont("Helvetica", 11)
    for i, line in enumerate(lines):
        c.drawString(45, height - 159 - i * 31, line)
    c.setFont("Helvetica", 9)
    c.drawString(45, 65, "Invented names and transactions. No real customer or personal information.")
    c.drawString(45, 48, "Not valid for payment, banking, tax filing or identity verification.")
    c.showPage()
    c.save()
    pdf = PdfReader(str(path))
    assert len(pdf.pages) == 1 and "PURELY FICTIONAL" in pdf.pages[0].extract_text()
    manifest.append({"file": name, "expected": expected, "sha256": sha256(path.read_bytes()).hexdigest()})
original = base / "INITIAL_UPLOAD/01_Kauri_Lantern_Bank_Statement_2027-01.pdf"
duplicate = target / names[-1]
copyfile(original, duplicate)
assert original.read_bytes() == duplicate.read_bytes()
manifest.append({"file": duplicate.name, "expected": "exact_duplicate_not_counted",
                 "sha256": sha256(duplicate.read_bytes()).hexdigest()})
print(json.dumps({"offlineOnly": True, "files": manifest}, indent=2))
