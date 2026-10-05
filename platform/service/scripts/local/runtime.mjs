/** Dedicated persistent local instance. Never reads DATABASE_URL or cloud credentials. */
import { existsSync, readFileSync, writeFileSync, mkdirSync, openSync, closeSync, realpathSync } from 'node:fs';
import { readFile, readdir, writeFile, rm, cp, mkdir } from 'node:fs/promises';
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const service = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const repository = resolve(service, '../..');
const marker = 'dop-local-persistence-stage1';
const home = resolve(process.env.DOP_LOCAL_HOME ?? join(repository, '.local/dop'));
const command = process.argv[2];
const pgBinArgument = process.argv.indexOf('--pg-bin');
const configHome = resolve(process.env.DOP_LOCAL_CONFIG_HOME ?? join(repository, ".local/personal"));
const configurationPath = join(home, 'runtime.json');
const randomSecret = () => randomBytes(32).toString('hex');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const pgEnvironment = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PG')));
function binary(config, name) { return join(config.pgBin, name); }
function control(config, args, extra={}) { return execFileSync(binary(config, 'pg_ctl'), ['-D', join(home, 'postgres'), ...args],
  { encoding:'utf8', env:pgEnvironment(), ...extra }); }
function configuration() {
  const config = JSON.parse(readFileSync(configurationPath, 'utf8'));
  if (config.marker !== marker || realpathSync(home) !== home ||
      ![config.appPort, config.databasePort].every(p => Number.isInteger(p) && p >= 1024 && p <= 65535)
      || config.appPort === config.databasePort || !/^[a-f0-9]{64}$/.test(config.adminPassword)
      || !/^[a-f0-9]{64}$/.test(config.databasePassword)) throw Error('Invalid dedicated local configuration');
  return config;
}
function admin(config, database='postgres') { return new pg.Client({ host:'127.0.0.1', port:config.databasePort,
  user:'postgres', password:config.adminPassword, database, connectionTimeoutMillis:5000 }); }
function postgresRunning(config) { try { control(config, ['status'], {stdio:'pipe'}); return true; } catch { return false; } }
async function health(config) {
  try { const r=await fetch(`http://127.0.0.1:${config.appPort}/health`, {signal:AbortSignal.timeout(1000)});
    return r.ok && (await r.json()).mode === marker; } catch { return false; }
}
async function initialize(config) {
  const maintenance = admin(config); await maintenance.connect();
  let created = false;
  try {
    if ((await maintenance.query("SELECT 1 FROM pg_database WHERE datname='dop_local_stage1'")).rowCount)
      throw Error('Existing database without completed bootstrap: refusing to overwrite');
    await maintenance.query('CREATE DATABASE dop_local_stage1'); created = true;
    const client = admin(config, 'dop_local_stage1'); await client.connect();
    try {
      const migrationDir = resolve(service, '../database/migrations');
      const seeds = {'001_core_schema.sql':'001_accounting_pilot_cohort.sql',
        '009_work_configuration_releases.sql':'002_m14_configuration_registry.sql',
        '010_subject_onboarding_and_case_provisioning.sql':'003_m15_onboarding_packages.sql'};
      const files = (await readdir(migrationDir)).filter(n => /^\d+.*\.sql$/.test(n)).sort();
      const checksums = {};
      for (const name of files) {
        // Historical 052 expects this 051 ledger row. It is explicitly LOCAL,
        // never evidence that a cloud deployment or historical attestation occurred here.
        if (name.startsWith('052_')) await client.query(`INSERT INTO dop_schema_migration_ledger
          (version,filename,sha256,execution_mode,git_commit,applied_by,evidence_note)
          VALUES('051','051_governed_synthetic_demo_form_entry.sql',$1,'baseline_verified',
          '7ddd95dc3d87b2b996f0f9b16066b017d326e7d2','local-bootstrap',
          'LOCAL synthetic prerequisite for historical migration 052; not cloud deployment evidence.')`,
          [hash(await readFile(join(migrationDir,'051_governed_synthetic_demo_form_entry.sql')))]);
        const sql = await readFile(join(migrationDir,name)); checksums[name]=hash(sql);
        try { await client.query(sql.toString('utf8')); }
        catch (error) { throw Error(`Local migration ${name} failed (${error.code})`); }
        if (seeds[name]) await client.query(await readFile(resolve(service,'../database/seeds/dev',seeds[name]),'utf8'));
      }
      await client.query(`UPDATE organizations SET display_name='本地虚构资料演示',
        settings=settings || '{"local_persistence_mode":"stage1"}'::jsonb
        WHERE organization_key='dev-accounting-firm'`);
      await client.query(`INSERT INTO actors (organization_id,external_subject_id,actor_type,display_name,email)
        SELECT id,'local-stage1-employee','staff','本机演示员工','local@demo.invalid'
        FROM organizations WHERE organization_key='dev-accounting-firm'`);
      const localSql = await readFile(resolve(service,'../database/local/001_local_upload.sql'),'utf8');
      await client.query(localSql); checksums['local/001_local_upload.sql']=hash(localSql);
      // Safe generated hex literal; never interpolate supplied passwords/SQL.
      await client.query(`CREATE ROLE dop_local_app LOGIN PASSWORD '${config.databasePassword}'`);
      await client.query('GRANT dop_app TO dop_local_app');
      await client.query('ALTER ROLE dop_local_app SET row_security=on');
      await client.query('CREATE TABLE dop_local_installation (key text PRIMARY KEY, value text NOT NULL)');
      await client.query('INSERT INTO dop_local_installation VALUES ($1,$2),($3,$4)',
        ['marker',marker,'migration_checksums',JSON.stringify(checksums)]);
      await client.query('GRANT SELECT ON dop_local_installation TO dop_local_app');
      await writeFile(join(home,'bootstrap-evidence.json'), JSON.stringify({mode:marker,
        initializedAt:new Date().toISOString(), migrationCount:files.length, checksums,
        seededDocuments:Number((await client.query('SELECT count(*) FROM documents')).rows[0].count),
        note:'Local synthetic seed data only. No cloud import or cloud migration.'},null,2), {mode:0o600});
    } finally { await client.end(); }
  } catch (error) {
    // Only the database created by THIS failed bootstrap, before any app is started.
    if (created) await maintenance.query('DROP DATABASE dop_local_stage1 WITH (FORCE)');
    throw error;
  } finally { await maintenance.end(); }
  config.initialized=true;
  await writeFile(configurationPath, JSON.stringify(config,null,2), {mode:0o600});
}
async function upgradeLocal(config) {
  const client=admin(config,'dop_local_stage1'); await client.connect();
  try {
    if ((await client.query("SELECT value FROM dop_local_installation WHERE key='marker'")).rows[0]?.value!==marker)
      throw Error('Refusing to upgrade an unmarked database');
    const directory=resolve(service,'../database/local');
    for(const name of (await readdir(directory)).filter(n=>/^\d+.*\.sql$/.test(n)&&n!=='001_local_upload.sql').sort()) {
      const sql=await readFile(join(directory,name),'utf8'), checksum=hash(sql), key='local-migration:'+name;
      await client.query('BEGIN');
      try {
        await client.query("SELECT pg_advisory_xact_lock(hashtext('dop-local-upgrade'))");
        const applied=(await client.query('SELECT value FROM dop_local_installation WHERE key=$1',[key])).rows[0];
        if(applied && applied.value!==checksum) throw Error('Applied local migration changed: '+name);
        if(!applied) { await client.query(sql); await client.query('INSERT INTO dop_local_installation VALUES($1,$2)',[key,checksum]); }
        await client.query('COMMIT');
      } catch(error) { await client.query('ROLLBACK'); throw error; }
    }
  } finally { await client.end(); }
}
async function start() {
  if (!existsSync(configurationPath)) {
    if (existsSync(home) && (await readdir(home)).length) throw Error('Local directory is not empty; refusing to adopt it');
    const pgBin = pgBinArgument >= 0 ? resolve(process.argv[pgBinArgument+1] ?? '') : process.env.DOP_LOCAL_PG_BIN;
    if (!pgBin || !existsSync(join(pgBin,'initdb'))) throw Error('Supply --pg-bin /path/to/postgresql/bin (PostgreSQL 17 with pgcrypto)');
    const version=execFileSync(join(pgBin,'postgres'),['--version'],{encoding:'utf8'});
    if (!/PostgreSQL\) 17\./.test(version)) throw Error('This local bootstrap currently supports PostgreSQL 17');
    mkdirSync(home,{recursive:true,mode:0o700});
    const config={marker, initialized:false, appPort:Number(process.env.DOP_LOCAL_APP_PORT??4318),
      databasePort:Number(process.env.DOP_LOCAL_DATABASE_PORT??55439),
      adminPassword:randomSecret(), databasePassword:randomSecret(), sessionSecret:randomSecret(),
      pgBin, configHome};
    writeFileSync(configurationPath,JSON.stringify(config,null,2),{mode:0o600,flag:'wx'});
  }
  const config=configuration();
  if (!config.configHome) { config.configHome=configHome; await writeFile(configurationPath,JSON.stringify(config,null,2),{mode:0o600}); }
  if (!existsSync(join(config.configHome,"settings.json"))) throw Error("Run node scripts/local/setup.mjs once to set your personal login before starting.");
  if (await health(config)) { console.log(`Already running: http://127.0.0.1:${config.appPort}/workbench`); return; }
  // Remove obsolete generated login material only from this marked local instance.
  // The fixed verifier is in personal settings, independent of database/demo contents.
  if ('loginEmail' in config || 'passwordSalt' in config || 'passwordHash' in config) {
    delete config.loginEmail; delete config.passwordSalt; delete config.passwordHash;
    await writeFile(configurationPath, JSON.stringify(config,null,2), {mode:0o600});
  }
  await rm(join(home,'login.txt'),{force:true});
  // Build before starting PostgreSQL so a compiler failure cannot leave a new server behind.
  execFileSync(process.execPath,[join(service,'node_modules/typescript/bin/tsc'),'-p',join(service,'tsconfig.json')],{cwd:service,stdio:'inherit'});
  const data=join(home,'postgres');
  if (!existsSync(join(data,'PG_VERSION'))) {
    const passwordFile=join(home,'.init-password'); writeFileSync(passwordFile,config.adminPassword,{mode:0o600});
    try { execFileSync(binary(config,'initdb'),['-D',data,'-U','postgres','--auth-local=scram-sha-256','--auth-host=scram-sha-256',
      '--no-locale','--encoding=UTF8',`--pwfile=${passwordFile}`],{env:pgEnvironment(),stdio:'pipe'}); }
    finally { await rm(passwordFile,{force:true}); }
  }
  const startedPg=!postgresRunning(config);
  if (startedPg) control(config,['-l',join(home,'postgres.log'),'-o',`-h 127.0.0.1 -p ${config.databasePort} -c unix_socket_directories=''`,'-w','start'],{stdio:'pipe'});
  try {
    if (!config.initialized) await initialize(config);
    await upgradeLocal(config);
    const log=openSync(join(home,'app.log'),'a',0o600);
    const child=spawn(process.execPath,[join(service,'dist/src/local-main.js')],{
      cwd:service,detached:true,stdio:['ignore',log,log],env:{PATH:process.env.PATH??'',DOP_LOCAL_HOME:home}});
    closeSync(log); child.unref();
    writeFileSync(join(home,'app.pid'),String(child.pid),{mode:0o600});
    for(let attempt=0;attempt<50;attempt++) {
      if(await health(config)) {
        console.log(`Local workbench: http://127.0.0.1:${config.appPort}/workbench\nLogin: your saved local account and password\nPersistent data: ${home}`); return;
      }
      await new Promise(r=>setTimeout(r,100));
    }
    throw Error(`Local app failed to start; inspect ${join(home,'app.log')}`);
  } catch(error) { if(startedPg) control(config,['-w','stop','-m','fast'],{stdio:'pipe'}); throw error; }
}
async function stop() {
  const config=configuration(), pidFile=join(home,'app.pid');
  if(existsSync(pidFile)) {
    const pid=Number(readFileSync(pidFile,'utf8'));
    if(!Number.isInteger(pid)||pid<2)throw Error('Invalid local app PID');
    let args='';
    try { args=execFileSync('ps',['-p',String(pid),'-o','command='],{encoding:'utf8'}); } catch {}
    if(args && !args.includes(join(service,'dist/src/local-main.js')))throw Error('PID belongs to another process; refusing to stop');
    if(args) {
      process.kill(pid,'SIGTERM');
      for(let n=0;n<100;n++) {
        try { process.kill(pid,0); } catch { break; }
        await new Promise(r=>setTimeout(r,100));
        if(n===99)throw Error('Local app has not stopped; leaving PostgreSQL running');
      }
    }
    await rm(pidFile,{force:true});
  }
  if(postgresRunning(config))control(config,['-w','stop','-m','fast'],{stdio:'pipe'});
  console.log('Local app and PostgreSQL stopped. All records and originals retained.');
}
async function backup() {
  const config=configuration();
  if(await health(config)||postgresRunning(config))throw Error('Stop this local instance before taking a consistent backup.');
  const destination=resolve(process.env.DOP_LOCAL_BACKUP_DIR ?? join(repository,'.local/backups',new Date().toISOString().replace(/[:.]/g,'-')));
  if(destination===home||destination.startsWith(home+'/')||existsSync(destination))throw Error('Backup destination must be new and outside the data directory.');
  await mkdir(destination,{recursive:true,mode:0o700});
  await cp(home,join(destination,'data'),{recursive:true,errorOnExist:true,force:false});
  await cp(config.configHome ?? configHome,join(destination,'personal'),{recursive:true,errorOnExist:true,force:false});
  const originals={};
  for(const name of await readdir(join(home,'originals')).catch(()=>[])) {
    const original=await readFile(join(home,'originals',name));
    if(hash(original)!==hash(await readFile(join(destination,'data/originals',name))))throw Error('Backup original hash mismatch');
    originals[name]=hash(original);
  }
  await writeFile(join(destination,'manifest.json'),JSON.stringify({createdAt:new Date().toISOString(),kind:'local-cold-backup',
    postgresMajor:17,sourceHome:home,originals,verifiedOriginalCount:Object.keys(originals).length,
    containsPrivateCredentials:true,note:'Keep private. Same-platform PostgreSQL 17 cold copy; cross-machine restore not yet verified.'},null,2),{mode:0o600});
  console.log('Private cold backup created; original hashes verified: '+destination);
}
try {
  if(command==='start')await start();
  else if(command==='stop')await stop();
  else if(command==='backup')await backup();
  else if(command==='status') { const config=configuration();console.log(JSON.stringify({app:await health(config),postgres:postgresRunning(config),home})); }
  else throw Error('Usage: node scripts/local/runtime.mjs start [--pg-bin /path/to/bin] | stop | status | backup');
} catch(error) { console.error(error.message); process.exitCode=1; }
