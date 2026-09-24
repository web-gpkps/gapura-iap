import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';
import { auth, drive as driveApi } from '@googleapis/drive';
import transport from '../../src/sheets/google-transport.ts';
const { GoogleSheetsTransport } = transport;
import sheetConfig from '../../src/sheets/config.ts';
const { googleCredentials, TRACKER_TAB } = sheetConfig;
import branchConfig from '../../src/domain/branches.ts';
const { BRANCHES } = branchConfig;
import { caseId, ownedUser, validateManifest } from './protocol.mjs';

const command = process.argv[2] || 'plan';
const root = path.resolve('test-results/loadtest');
const manifestPath = path.resolve(process.env.MANIFEST || `${root}/manifest.json`);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const must = name => { const value = process.env[name]?.trim(); if (!value) throw new Error(`${name} required`); return value; };
function save(plan) {
  const temporary = `${manifestPath}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(plan, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, manifestPath);
}
function client(plan) {
  if (plan) validateManifest(plan);
  const url = must('NEXT_PUBLIC_SUPABASE_URL');
  if (plan && plan.supabase !== url) throw new Error('Manifest belongs to a different Supabase project');
  if (process.env.SUPABASE_URL && process.env.SUPABASE_URL !== url) throw new Error('Auth/data projects differ: unsupported');
  return createClient(url, must('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(15000) }) },
  });
}
function checked(result) { if (result.error) throw new Error(`Provider error: ${result.error.code || result.error.status || result.error.message}`); return result.data; }
async function allUsers(db) {
  const users = [];
  for (let page = 1; ; page++) {
    const data = checked(await db.auth.admin.listUsers({ page, perPage: 1000 }));
    users.push(...data.users);
    if (data.users.length < 1000) return users;
  }
}
async function rows(db) {
  const out = [];
  for (let offset = 0; ; offset += 1000) {
    const page = checked(await db.from('iap_tracker').select('*').order('iap_id').order('step_no').range(offset, offset + 999));
    out.push(...page);
    if (page.length < 1000) return out;
  }
}
function drive(plan) {
  if (must('GOOGLE_DRIVE_EVIDENCE_FOLDER_ID') !== plan.folder) throw new Error('Drive folder mismatch');
  const oauth = new auth.OAuth2(must('GOOGLE_DRIVE_OAUTH_CLIENT_ID'), must('GOOGLE_DRIVE_OAUTH_CLIENT_SECRET'));
  oauth.setCredentials({ refresh_token: must('GOOGLE_DRIVE_OAUTH_REFRESH_TOKEN') });
  return driveApi({ version: 'v3', auth: oauth });
}
async function ownedFiles(plan) {
  const api = drive(plan), files = [];
  const targets = new Set(plan.accounts.map((_, i) => createHash('sha256').update(`${caseId(plan.run, i + 1)}\0${1}`).digest('hex')));
  let pageToken;
  do {
    const r = await api.files.list({ q: `'${plan.folder}' in parents and trashed = false`, pageSize: 1000, pageToken,
      fields: 'nextPageToken,files(id,name,appProperties,createdTime)' }, { timeout: 15000, retry: false });
    files.push(...(r.data.files || []).filter(f => f.name?.startsWith(`loadtest_${plan.run}_`) &&
      targets.has(f.appProperties?.iapUploadTarget) && f.createdTime >= plan.started));
    pageToken = r.data.nextPageToken;
  } while (pageToken);
  return files;
}
async function sheetRows(plan) {
  if (must('GOOGLE_SHEETS_SPREADSHEET_ID') !== plan.sheet) throw new Error('Sheet mismatch');
  return new GoogleSheetsTransport(googleCredentials()).readRange(`'${TRACKER_TAB}'!A:W`);
}
function preserved(plan, current) {
  const lookup = new Map(current.map(row => [JSON.stringify([row.iap_id, row.step_no]), row]));
  return plan.baseline.every(old => JSON.stringify(lookup.get(JSON.stringify([old.iap_id, old.step_no]))) === JSON.stringify(old));
}
async function verify(plan, db) {
  const current = await rows(db), users = await allUsers(db), files = await ownedFiles(plan);
  const sheet = await sheetRows(plan);
  const sync = checked(await db.from('iap_sync_state').select('baseline').eq('id', true).single());
  const conflicts = checked(await db.from('iap_sync_conflicts').select('iap_id').like('iap_id', `loadtest\\_${plan.run}\\_%`));
  const sheetIndex = new Map(sheet.slice(1).map(row => [JSON.stringify([row[1], row[4]]), row]));
  const sheetUnchanged = !plan.sheetBaseline || plan.sheetBaseline.slice(1).every(old => JSON.stringify(sheetIndex.get(JSON.stringify([old[1], old[4]]))) === JSON.stringify(old));
  const report = {
    existingSheetRecordsUnchanged: sheetUnchanged,
    checkedAt: new Date().toISOString(), existingRecordsUnchanged: preserved(plan, current),
    trackerRemaining: current.filter(r => plan.cases.includes(r.iap_id)).length,
    accountsRemaining: users.filter(u => [...plan.accounts, ...plan.registrations].some(a => ownedUser(u, a, plan.run, plan.started))).length,
    profilesRemaining: checked(await db.from('profiles').select('id').like('full_name', `loadtest\\_${plan.run}\\_%`)).length,
    filesRemaining: files.length,
    sheetRemaining: sheet.filter(r => String(r[1]).startsWith(`loadtest_${plan.run}_`)).length,
    mirrorRemaining: (sync.baseline || []).filter(r => String(r[1]).startsWith(`loadtest_${plan.run}_`)).length,
    conflictsRemaining: conflicts.length,
  };
  report.clean = report.existingRecordsUnchanged && report.existingSheetRecordsUnchanged && Object.entries(report).filter(([key]) => key.endsWith('Remaining')).every(([, value]) => value === 0);
  fs.writeFileSync(`${root}/verification.json`, JSON.stringify(report, null, 2), { mode: 0o600 });
  return report;
}
async function seed() {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  if (fs.existsSync(manifestPath)) throw new Error('Manifest exists; cleanup/verify it, then archive the run directory before a new run');
  const db = client();
  const base = (process.env.BASE_URL || 'https://gapura-iap-tracker.vercel.app').replace(/\/$/, '');
  if (!/^https:\/\/[a-z0-9.-]+$/.test(base)) throw new Error('HTTPS origin required');
  const run = Date.now().toString(36) + randomBytes(3).toString('hex');
  const started = new Date().toISOString();
  const accounts = BRANCHES.flatMap(({ code }) => Array.from({ length: 5 }, (_, i) => ({
    branch: code, number: i + 1, email: `test+${code.toLowerCase()}+${String(i + 1).padStart(2, '0')}@example.com`,
    fullName: `loadtest_${run}_${code}_${i + 1}`,
  })));
  const registrations = BRANCHES.flatMap(({ code }) => [6, 7].map(number => ({ branch: code, number,
    email: `test+${code.toLowerCase()}+${String(number).padStart(2, '0')}@example.com`, fullName: `loadtest_${run}_${code}_${number}` })));
  const existingUsers = await allUsers(db);
  if (existingUsers.some(u => [...accounts, ...registrations].some(a => u.email === a.email))) throw new Error('Test email already exists; never reuse or delete pre-existing accounts');
  const baseline = await rows(db);
  const sequence = baseline.map(r => r.no).sort((a, b) => a - b);
  if (!sequence.every((n, i) => n === i + 1)) throw new Error('Existing row numbering is not contiguous; application create can modify old rows');
  const isolated = process.env.ISOLATED === '1';
  if (isolated && (baseline.length || base === 'https://gapura-iap-tracker.vercel.app' || must('NEXT_PUBLIC_SUPABASE_URL').includes('znyrztcjglyichgarwbu'))) throw new Error('ISOLATED cannot target production or a non-empty tracker');
  const plan = { run, started, base, supabase: must('NEXT_PUBLIC_SUPABASE_URL'), folder: must('GOOGLE_DRIVE_EVIDENCE_FOLDER_ID'),
    sheet: must('GOOGLE_SHEETS_SPREADSHEET_ID'), accounts, registrations, baseline, isolated,
    registration: process.env.REGISTRATION === '1', ready: false,
    cases: accounts.flatMap((_, i) => ['seed', 0, 1, 2, 3, 4, 5].map(cycle => caseId(run, i + 1, cycle))) };
  if (plan.registration && !isolated) throw new Error('Real signup with reserved emails requires isolated Auth and a mail sink; production signup disabled');
  // Verify cleanup access before any writes. Never emit credentials or user records.
  await ownedFiles(plan); plan.sheetBaseline = await sheetRows(plan);
  save(plan); // Journal all planned identities before requests that could time out after committing.
  try {
    for (let i = 0; i < accounts.length; i++) {
      const a = accounts[i];
      const { user } = checked(await db.auth.admin.createUser({ email: a.email, password: must('LOADTEST_PASSWORD'), email_confirm: true,
        app_metadata: { loadtest_run: run }, user_metadata: { full_name: a.fullName, branch_code: a.branch } }));
      a.id = user.id; save(plan);
      const approved = checked(await db.from('profiles').update({ status: 'active', role: 'user', branch_code: a.branch }).eq('id', user.id).select('id'));
      if (approved.length !== 1) throw new Error('Profile creation/approval failed');
      if ((i + 1) % 20 === 0) console.log(`Seeded ${i + 1}/${accounts.length} accounts`);
      await pause(500);
    }
    // Direct append: no iap_mutate renumbering during setup.
    checked(await db.from('iap_tracker').insert(accounts.map((a, i) => ({ no: baseline.length + i + 1,
      iap_id: caseId(run, i + 1), title: caseId(run, i + 1), station: a.branch,
      step_no: 1, step: 'loadtest_seed', action: 'loadtest_seed', status: 'Belum Dimulai', progress: 0, stored_overdue: 'Sesuai Rencana' }))));
    if (!preserved(plan, await rows(db))) throw new Error('Baseline changed during seed; stop and inspect without restoring live rows');
    plan.ready = true; save(plan);
    console.log(`Ready: ${accounts.length} accounts; ${accounts.length} seed records; run ${run}`);
  } catch (e) { console.error('Seed failed; cleaning journaled identities'); await cleanup(plan); throw e; }
}
async function cleanup(plan) {
  const db = client(plan), failures = [];
  const attempt = async task => { try { await task(); } catch (e) { failures.push(String(e)); } };
  const users = await allUsers(db);
  let removed = 0;
  for (const u of users) {
    const account = [...plan.accounts, ...plan.registrations].find(a => ownedUser(u, a, plan.run, plan.started));
    if (!account) continue;
    await attempt(async () => {
      checked(await db.from('profiles').update({ status: 'inactive' }).eq('id', u.id));
      checked(await db.auth.admin.deleteUser(u.id));
      if (++removed % 50 === 0) console.log(`Cleanup: ${removed} test accounts removed`);
    });
  }
  // Client abort does not cancel an in-flight Vercel function. Drain the app's
  // 60-second Drive calls before sweeping orphaned files and records.
  console.log('Cleanup: draining in-flight requests before file/record removal');
  await pause(65000);
  await attempt(async () => {
    const api = drive(plan);
    for (const f of await ownedFiles(plan)) await api.files.delete({ fileId: f.id }, { timeout: 15000, retry: false });
  });
  // Exact IDs plus run-owned title. No broad LIKE test_% deletion, no renumbering.
  for (let i = 0; i < plan.cases.length; i += 50) {
    const ids = plan.cases.slice(i, i + 50);
    await attempt(async () => { checked(await db.from('iap_tracker').delete().in('iap_id', ids).in('title', ids)); });
    await attempt(async () => { checked(await db.from('iap_sync_conflicts').delete().in('iap_id', ids)); });
  }
  // Let the application's normal mirror propagate deletes. Never overwrite the full live sheet.
  let report;
  for (let i = 0; i < 13; i++) {
    report = await verify(plan, db);
    if (report.clean) break;
    if (i < 12) await pause(15000);
  }
  console.log(JSON.stringify(report));
  if (failures.length || !report.clean) throw new Error(`Cleanup incomplete: ${failures.join('; ')}; inspect verification.json and rerun cleanup`);
  plan.cleanedAt = new Date().toISOString(); save(plan);
}
async function fixtures() {
  const { default: sharp } = await import('sharp');
  const dir = `${root}/fixtures`; fs.mkdirSync(dir, { recursive: true });
  const pixels = randomBytes(128 * 128 * 3);
  await sharp(pixels, { raw: { width: 128, height: 128, channels: 3 } }).png().toFile(`${dir}/sample.png`);
  await sharp(pixels, { raw: { width: 128, height: 128, channels: 3 } }).jpeg({ quality: 90 }).toFile(`${dir}/sample.jpg`);
  let pdf = '%PDF-1.4\n', offsets = [0];
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R >>', '<< /Length 0 >>\nstream\n\nendstream'];
  objects.forEach((o, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += 'xref\n0 5\n0000000000 65535 f \n' + offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  fs.writeFileSync(`${dir}/sample.pdf`, pdf);
}
async function run() {
  const plan = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (!plan.ready || plan.cleanedAt) throw new Error('Run requires an unused ready manifest');
  if (plan.launchedAt) throw new Error('Manifest already launched; cleanup before creating another run');
  must('LOADTEST_PASSWORD');
  await fixtures();
  plan.launchedAt = new Date().toISOString(); save(plan);
  // Explicit env allowlist: service-role, OAuth, and Google secrets never reach k6.
  const env = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'BASE_URL', 'PEAK', 'MAX_RPS', 'LOADTEST_PASSWORD'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
  Object.assign(env, { MANIFEST: manifestPath, FIXTURE_DIR: `${root}/fixtures`, SUMMARY_PATH: `${root}/summary.json` });
  let code = 1;
  try {
    const child = spawn(process.env.K6_BIN || 'k6', ['run', '--quiet', 'scripts/loadtest/journey.js'], { env, stdio: 'inherit' });
    const stop = () => child.kill('SIGINT');
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    const timer = setTimeout(stop, 19 * 60 * 1000);
    try { code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', c => resolve(c ?? 1)); }); }
    finally { clearTimeout(timer); process.off('SIGINT', stop); process.off('SIGTERM', stop); }
  } finally { await cleanup(plan); }
  process.exitCode = code;
}
try {
  if (command === 'plan') console.log(JSON.stringify({ branches: BRANCHES.length, accounts: BRANCHES.length * 5, registrations: BRANCHES.length * 2,
    stages: '0→10 (2m), →50 (3m), →200 (1m), hold (5m), →20 (2m), →0 (30s); drain ≤3m',
    production: 'read/create/update/upload/logout; app delete skipped because of global renumbering; signup skipped because of email limits',
    requestCeiling: '50 × peak VUs + 50 setup; global 4 RPS; no automatic write retries' }, null, 2));
  else if (command === 'seed') await seed();
  else if (command === 'run') await run();
  else if (command === 'cleanup') await cleanup(JSON.parse(fs.readFileSync(manifestPath, 'utf8')));
  else if (command === 'verify') { const p = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); const r = await verify(p, client(p)); console.log(JSON.stringify(r)); if (!r.clean) process.exitCode = 1; }
  else throw new Error('Command: plan | seed | run | cleanup | verify');
} catch (e) { console.error(String(e)); process.exitCode = 1; }
