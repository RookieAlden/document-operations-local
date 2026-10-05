/** Once-only personal configuration, separate from all demo database homes. */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes, scryptSync } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../../..');
const home=resolve(process.env.DOP_LOCAL_CONFIG_HOME ?? join(root,'.local/personal'));
const file=join(home,'settings.json');
if(existsSync(file)) { console.log('Personal settings already exist; login and AI settings preserved.'); process.exit(0); }
if(!process.stdin.isTTY) throw Error('Run setup in an interactive terminal.');
let muted=false;
const output=new Writable({write(chunk,_encoding,done){if(!muted)process.stdout.write(chunk);done();}});
const input=createInterface({input:process.stdin,output,terminal:true});
try {
  const username=(await input.question('Local username [alden]: ')).trim()||'alden';
  if(!/^[a-zA-Z0-9._-]{2,80}$/.test(username)) throw Error('Use 2–80 letters, digits, dots, hyphens or underscores.');
  process.stdout.write('Local password (8+ characters, hidden): '); muted=true;
  const password=await input.question(''); muted=false;process.stdout.write('\n');
  if(password.length<8||password.length>1024)throw Error('Password must contain 8–1024 characters.');
  const salt=randomBytes(24).toString('hex');
  mkdirSync(home,{recursive:true,mode:0o700});
  writeFileSync(file,JSON.stringify({login:{username,salt,verifier:scryptSync(password,salt,64).toString('hex')},
    ai:{enabled:false,apiKey:'',model:'gpt-5.6-sol',budgetUsd:0,maxCalls:0}},null,2),{mode:0o600,flag:'wx'});
  console.log('Personal settings saved. This login stays unchanged across updates and demo data resets.');
} finally { input.close(); }
