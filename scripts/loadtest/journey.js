import http from 'k6/http';
import { sleep } from 'k6';
import exec from 'k6/execution';
import { Rate, Trend, Counter } from 'k6/metrics';
import { actionReferences, actionOK, caseId, hiddenFields, multipartFields, validateManifest } from './protocol.mjs';

const plan = JSON.parse(open(__ENV.MANIFEST));
validateManifest(plan);
const base = plan.base;
const maxRps = Number(__ENV.MAX_RPS || 4);
if (!Number.isFinite(maxRps) || maxRps <= 0 || maxRps > 4) throw new Error('MAX_RPS must be >0 and <=4');
if (plan.isolated && (base === 'https://gapura-iap-tracker.vercel.app' || plan.supabase.includes('znyrztcjglyichgarwbu'))) throw new Error('Production cannot use isolated mode');
const peak = Math.min(Number(__ENV.PEAK || 200), plan.accounts.length);
if (!Number.isInteger(peak) || peak < 1 || peak > 200 || (!plan.ready && !(__ENV.CANARY === '1' && plan.accounts[0].id))) throw new Error('Prepared manifest required');
const errors = new Rate('request_errors');
const overloaded = new Rate('overload');
const timeouts = new Rate('function_timeouts');
const clientTimeouts = new Rate('client_timeouts');
const uploads = new Rate('upload_success');
const latency = new Trend('app_latency', true);
const operations = new Counter('operations');
const requests = new Counter('target_requests');
const files = ['pdf', 'jpg', 'png'].map(ext => ({ ext, bytes: open(`${__ENV.FIXTURE_DIR}/sample.${ext}`, 'b') }));
for (const f of files) if (f.bytes.byteLength < 1 || f.bytes.byteLength > 2 * 1024 * 1024) throw new Error('Fixture must be 1 byte–2 MiB');
export const options = {
  scenarios: __ENV.CANARY === '1' ? { canary: { executor: 'shared-iterations', vus: 1, iterations: 1, maxDuration: '30s' } } : { users: { executor: 'ramping-vus', startVUs: 0, stages: [
    { duration: '20s', target: Math.min(10, peak) }, { duration: '100s', target: Math.min(10, peak) },
    { duration: '3m', target: Math.min(50, peak) }, { duration: '1m', target: peak },
    { duration: '5m', target: peak }, { duration: '2m', target: Math.min(20, peak) }, { duration: '30s', target: 0 },
  ], gracefulRampDown: '3m', gracefulStop: '3m' } },
  // Single local k6 process only. This ceiling includes retries and setup traffic.
  rps: maxRps, maxRedirects: 0,
  summaryTrendStats: ['med', 'p(95)', 'p(99)', 'max'],
  thresholds: {
    request_errors: ['rate<0.05', { threshold: 'rate<=0.10', abortOnFail: true, delayAbortEval: '10s' }],
    app_latency: ['p(95)<5000'], overload: ['rate<=0.03'], function_timeouts: ['rate<=0.10'],
    upload_success: ['rate>0.99'],
  },
};
let count = 0, slow = 0;
function send(method, url, body, name, validate, headers = {}, retry = 0) {
  if (++count > 50) exec.test.abort('Hard request budget exhausted (50 per VU; setup has separate 50)');
  if (method === 'POST' && body && typeof body === 'object' && !headers['Content-Type']) {
    const form = multipartFields(body, `gapura-${plan.run}-${exec.vu.idInTest}-${count}`);
    body = form.body; headers = { ...headers, 'Content-Type': form.contentType };
  }
  const r = http.request(method, url, body, { timeout: '12s', redirects: 0,
    headers: { Origin: base, 'X-Loadtest-Run': plan.run, ...headers }, tags: { name } });
  const ok = validate(r);
  requests.add(1); errors.add(!ok); overloaded.add(r.status === 429 || r.status === 503);
  timeouts.add(String(r.body).includes('FUNCTION_INVOCATION_TIMEOUT'));
  clientTimeouts.add(r.error_code === 1050);
  latency.add(r.timings.duration, { operation: name });
  slow = r.timings.duration > 10000 || r.error_code === 1050 ? slow + 1 : 0;
  if (r.status === 429 || r.status === 503) exec.test.abort(`Provider protection: HTTP ${r.status}; no retry`);
  if (slow >= 3) exec.test.abort('Three consecutive requests >10s in one VU');
  if (!ok && retry > 0 && (r.status === 502 || r.status === 504 || r.status === 0)) {
    // Only idempotent reads retry. Honor Retry-After; never replay ambiguous writes.
    const h = r.headers['Retry-After'];
    const wait = h ? (Number(h) || Math.max(0, (Date.parse(h) - Date.now()) / 1000)) : 2 ** (3 - retry);
    sleep(Math.max(2 ** (3 - retry), wait || 0) + Math.random());
    return send(method, url, body, name, validate, headers, retry - 1);
  }
  if (!ok && name === 'login') console.error(JSON.stringify({ authError: r.html().find('[data-testid="auth-error"]').text(), dashboard: String(r.body).includes('data-testid="kpi-total"'), status: r.status }));
  if (!ok) throw new Error(`Failed ${name} (HTTP ${r.status}); response withheld`);
  return r;
}
const get = (path, name, valid = r => r.status === 200) => send('GET', base + path, null, name, valid, {}, 2);
const fields = (r, selector) => hiddenFields(r.html(), selector);
function login(account) {
  const form = fields(get('/login', 'login_form'));
  send('POST', base + '/login', { ...form, email: account.email, password: __ENV.LOADTEST_PASSWORD },
    'login', r => r.status === 303 && r.headers.Location === '/');
  return get('/', 'dashboard', r => r.status === 200 && String(r.body).includes('data-testid="kpi-total"'));
}
function logout(dashboard) {
  const form = fields(dashboard, 'form:has([data-testid="sign-out"])');
  send('POST', base + '/', form, 'logout', r => r.status === 303 && String(r.headers.Location).includes('/login'));
}
export function setup() {
  if (!__ENV.LOADTEST_PASSWORD) throw new Error('Password required');
  const dashboard = login(plan.accounts[0]);
  const actions = {};
  const nodes = dashboard.html().find('script[src]');
  const scripts = Array.from({ length: nodes.size() }, (_, i) => nodes.eq(i).attr('src'));
  for (const src of [...new Set(scripts)]) {
    if (!src.startsWith('/_next/static/') || !src.endsWith('.js')) continue;
    Object.assign(actions, actionReferences(get(src, 'action_discovery').body));
  }
  logout(dashboard);
  for (const name of ['createCaseAction', 'saveItemAction', 'deleteCaseAction']) {
    if (!actions[name]) throw new Error(`Cannot correlate deployed ${name}; refusing guessed action ID`);
  }
  return actions;
}
function mutate(actions, name, args) {
  send('POST', base + '/', JSON.stringify(args), name,
    r => r.status === 200 && actionOK(r.body), { 'Content-Type': 'text/plain;charset=UTF-8', 'Next-Action': actions[name] });
  operations.add(1, { operation: name });
}
function upload(id, index) {
  const f = files[index], type = f.ext === 'pdf' ? 'application/pdf' : f.ext === 'jpg' ? 'image/jpeg' : 'image/png';
  const kind = f.ext === 'pdf' ? 'document' : 'photo', name = `${id}_${index}.${f.ext}`;
  const path = `${base}/api/evidence/${encodeURIComponent(id)}/1`;
  let success = false;
  try {
    const s = send('POST', path, JSON.stringify({ kind, file: { name, type, size: f.bytes.byteLength }, stepNos: [1] }),
      'upload_start', r => r.status === 200 && !!r.json('sessionUrl'), { 'Content-Type': 'application/json' }).json();
    if (!/^https:\/\/www\.googleapis\.com\/upload\/drive\/v3\/files\?/.test(s.sessionUrl)) throw new Error('Unexpected upload origin');
    const fileId = send('PUT', s.sessionUrl, f.bytes, 'upload_bytes', r => r.status === 200 && !!r.json('id'),
      { 'Content-Type': type, 'Content-Range': `bytes 0-${f.bytes.byteLength - 1}/${f.bytes.byteLength}` }).json('id');
    send('PATCH', path, JSON.stringify({ fileId, nonce: s.nonce, kind, originalName: name, stepNos: [1] }),
      'upload_complete', r => r.status === 200 && !!r.json('url'), { 'Content-Type': 'application/json' });
    success = true;
  } finally { uploads.add(success); }
}
export default function (actions) {
  if (__ENV.CANARY === '1') return;
  const vu = exec.vu.idInTest, cycle = exec.vu.iterationInScenario;
  if (cycle >= 6) { sleep(180); return; }
  const account = plan.accounts[vu - 1], started = Date.now();
  if (cycle === 0) sleep((account.number - 1) % 5);
  let dashboard;
  try {
    dashboard = login(account);
    sleep(5 + Math.random() * 10);
    const slot = ((vu - 1) * 3 + cycle) % 10, id = caseId(plan.run, vu, cycle), seed = caseId(plan.run, vu);
    const input = { step: 'loadtest_step', action: 'loadtest_action', progress: 0, status: 'Belum Dimulai',
      pic: '', timeline: '', targetDate: '', actualDate: '', evidence: '', evidenceLink: '' };
    if (slot < 5) mutate(actions, 'createCaseAction', [{ iapId: id, title: id, station: account.branch, steps: [input] }]);
    if (slot < 3) mutate(actions, 'saveItemAction', [{ iapId: seed, stepNo: 1 }, { ...input, progress: 25, status: 'Sedang Berjalan' }]);
    if (cycle === 0) for (let i = 0; i < 1 + (vu % 3); i++) upload(seed, i);
    // Production's delete RPC renumbers unrelated rows. Execute deletes only on
    // an isolated target; production cleanup uses exact-ID direct deletion.
    if (slot === 0 && plan.isolated) mutate(actions, 'deleteCaseAction', [id]);
    sleep(5 + Math.random() * 10);
    get('/', 'dashboard_refresh', r => r.status === 200 && String(r.body).includes('data-testid="kpi-total"'));
  } catch (e) { console.error(String(e)); }
  finally {
    if (dashboard) {
      sleep(Math.max(0, 120 + Math.random() * 40 - (Date.now() - started) / 1000));
      logout(dashboard);
    }
  }
  if (cycle === 0 && account.number <= 2 && plan.registration) {
    const registration = plan.registrations.find(a => a.branch === account.branch && a.number === account.number + 5);
    const form = fields(get('/register', 'register_form'));
    send('POST', base + '/register', { ...form, email: registration.email, fullName: registration.fullName,
      branchCode: account.branch, password: __ENV.LOADTEST_PASSWORD, confirmPassword: __ENV.LOADTEST_PASSWORD },
    'register', r => r.status === 200 && String(r.body).includes('Pendaftaran diterima'));
  }
}
export function handleSummary(data) {
  return { [__ENV.SUMMARY_PATH]: JSON.stringify(data, null, 2) };
}
