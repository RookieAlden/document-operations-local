"""Rebuild six fictional PDF inputs. Requires reportlab; never calls an API."""
from pathlib import Path
import hashlib,json,sys
from reportlab.pdfgen import canvas
from reportlab.lib.colors import HexColor
from reportlab.lib.pagesizes import A4
out=Path(sys.argv[1] if len(sys.argv)>1 else 'output/pdf/local-closeout')
out.mkdir(parents=True,exist_ok=True)
client='Blue Peak Consulting Limited'
samples=[
('01-bank-statement.pdf','Bank statement','bank_statement','standard',[
'Kauri Demo Bank | Account holder: '+client,'Account: DEMO-001 (not a real account)','Statement period: 1 September 2026 to 30 September 2026',
'Opening balance: NZD 1,000.00','03 Sep | Client payment | Credit 575.00 | Balance 1,575.00','12 Sep | Office supplies | Debit 115.00 | Balance 1,460.00','Closing balance: NZD 1,460.00']),
('02-sales-invoice.pdf','Tax invoice','invoice','standard',[
'Seller: '+client,'Bill to: Harbourlight Demo Services Limited','Invoice number: DEMO-2026-0901','Invoice date: 3 September 2026 | Due: 20 September 2026',
'Description: September consulting services','Net: NZD 500.00 | GST (15%): NZD 75.00','Total due: NZD 575.00']),
('03-expense-receipt.pdf','Payment receipt','expense_receipt','standard',[
'Kauri Demo Office Supplies | Receipt DEMO-R-0912','Customer: '+client,'Transaction date: 12 September 2026',
'Office stationery: NZD 100.00','GST (15%): NZD 15.00 | Total paid: NZD 115.00','Paid by demo card ending 0000 | Balance due: NZD 0.00']),
('04-independent-statement.pdf','ACCOUNT ACTIVITY','bank_statement','independent_layout',[
client.upper(),'Reporting interval 01/09/2026 - 30/09/2026','Demo account reference: NONSTANDARD-A','Balance brought forward NZD 250.00',
'2026-09-16  Incoming consulting payment    +345.00','2026-09-24  Office rent                  -230.00','Funds at end of interval: NZD 365.00']),
('05-wrong-period.pdf','Bank statement','bank_statement','wrong_period',[
'Kauri Demo Bank | Account holder: '+client,'Account: DEMO-OLD (not a real account)','Statement period: 1 August 2025 to 31 August 2025',
'Opening balance: NZD 100.00','15 Aug 2025 | Deposit 50.00 | Balance 150.00','Closing balance: NZD 150.00']),
('06-garden-notes.pdf','Weekend garden notes',None,'unknown',[
'Try planting mint in a separate pot.','Water the herbs after sunset.','Keep the seedlings away from strong wind.','This is a personal gardening note, not an accounting record.'])]
manifest=[]
for filename,title,kind,category,lines in samples:
 c=canvas.Canvas(str(out/filename),pagesize=A4,invariant=1)
 c.setTitle(title+' - fictional local demonstration')
 w,h=A4
 independent=category=='independent_layout'
 c.setFillColor(HexColor('#24435a' if independent else '#193e32'))
 c.rect(0,h-124,w,124,fill=1,stroke=0)
 c.setFillColor(HexColor('#ffffff'));c.setFont('Helvetica-Bold',22)
 c.drawString(42,h-61,title);c.setFont('Helvetica',10)
 c.drawString(42,h-85,'FICTIONAL DEMONSTRATION - NO REAL CUSTOMER OR BANK DATA')
 c.setFillColor(HexColor('#202b2a'))
 c.setFont('Courier' if independent else 'Helvetica',10 if independent else 11)
 for i,line in enumerate(lines):c.drawString(42,h-171-i*33,line)
 c.setStrokeColor(HexColor('#d3ddda'));c.line(42,67,w-42,67)
 c.setFont('Helvetica',9);c.drawString(42,47,'Local workflow acceptance sample | 1 / 1')
 c.save()
 manifest.append({'file':filename,'sha256':hashlib.sha256((out/filename).read_bytes()).hexdigest(),'category':category,'expectedType':kind,
 'expectedHandling':'Must flag the mismatched period and require review' if category=='wrong_period' else 'Must abstain / require review; never count toward requirements' if category=='unknown' else 'Classify from original content; review if uncertain'})
(out/'manifest.json').write_text(json.dumps({'fictional':True,'client':client,'casePeriod':{'start':'2026-09-01','end':'2026-09-30'},'purpose':'Six integration checks, not a statistical accuracy certification','files':manifest},indent=2)+'\n')
print('Created six fictional PDFs and a SHA-256 manifest.')
