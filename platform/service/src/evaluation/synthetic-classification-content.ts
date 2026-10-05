// Pure content generators extracted from M44. No credentials, filesystem or provider access.
export function bankStatement(subject:string,period:string,index:number):string[]{
  const amount=(1000+index*17.31).toFixed(2);
  return ["SYNTHETIC BANK STATEMENT","TEST DATA - NOT A REAL FINANCIAL RECORD",`ACCOUNT HOLDER: ${subject}`,
    `ACCOUNT NUMBER: 00-${String(100000+index).padStart(6,"0")}-${index%10}`,`STATEMENT PERIOD: ${period}`,
    `OPENING BALANCE: NZD ${amount}`,`2026-07-${String(index%28+1).padStart(2,"0")} CLIENT RECEIPT NZD ${(index*31.17).toFixed(2)}`,
    `2026-08-${String(index%28+1).padStart(2,"0")} SOFTWARE PAYMENT NZD ${(index*7.13).toFixed(2)}`,
    `CLOSING BALANCE: NZD ${(Number(amount)+index*24.04).toFixed(2)}`,`SYNTHETIC FAMILY SERIAL: BP-Q3-${index}`];
}

export function highRiskDocument(code:string,subject:string,index:number):string[]{
  if(code==="invoice") return ["SYNTHETIC TAX INVOICE",`CUSTOMER: ${subject}`,`INVOICE: SYN-INV-${index}`,
    `DATE: 2026-08-${String(10+index).padStart(2,"0")}`,`TOTAL: NZD ${(120+index*9.5).toFixed(2)}`,"GST INCLUDED","TEST DATA ONLY"];
  if(code==="expense_receipt") return ["SYNTHETIC EXPENSE RECEIPT",`PURCHASER: ${subject}`,`RECEIPT: SYN-RCP-${index}`,
    `DATE: 2026-07-${String(10+index).padStart(2,"0")}`,`TOTAL: AUD ${(30+index*4.25).toFixed(2)}`,"FOREIGN CURRENCY PURCHASE","TEST DATA ONLY"];
  return ["SYNTHETIC CONTRACTOR STATEMENT",`CLIENT: ${subject}`,`CONTRACTOR: FICTIONAL CONTRACTOR ${index}`,
    "PERIOD: 2026-Q3",`GROSS PAYMENT: NZD ${(1500+index*125).toFixed(2)}`,"TEST DATA ONLY"];
}
