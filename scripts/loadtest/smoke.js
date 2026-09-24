import http from 'k6/http';
import { sleep } from 'k6';
import exec from 'k6/execution';
import { Rate } from 'k6/metrics';

// ponytail: public smoke only; authenticated CRUD needs the isolated full suite.
const base = (__ENV.BASE_URL || 'https://gapura-iap-tracker.vercel.app').replace(/\/$/, '');
if (!/^https:\/\/[a-z0-9.-]+$/.test(base)) throw new Error('BASE_URL must be an HTTPS origin');
const errors = new Rate('request_errors');
const overload = new Rate('overload');
const timeouts = new Rate('function_timeouts');
export const options = {
  scenarios: { smoke: { executor: 'ramping-vus', startVUs: 0, stages: [
    { duration: '20s', target: 1 }, { duration: '30s', target: 5 },
    { duration: '30s', target: 10 }, { duration: '40s', target: 0 },
  ], gracefulRampDown: '15s', gracefulStop: '15s' } },
  maxRedirects: 0,
  summaryTrendStats: ['med', 'p(95)', 'p(99)', 'max'],
  thresholds: {
    request_errors: ['rate<0.05', { threshold: 'rate<=0.10', abortOnFail: true, delayAbortEval: '5s' }],
    http_req_duration: ['p(95)<5000'],
    overload: ['rate<=0.03'],
    function_timeouts: ['rate<=0.10'],
  },
};
let requests = 0;
let slow = 0;
export default function () {
  // Hard ceiling: 10 VUs × 10 requests, including failures. No automatic redirects/retries.
  if (requests >= 10) { sleep(10); return; }
  requests++;
  const r = http.get(`${base}/login`, {
    timeout: '12s',
    headers: { 'X-Loadtest-Run': __ENV.RUN_ID || 'loadtest_public_smoke', 'User-Agent': 'Gapura-authorized-k6-smoke' },
    tags: { name: 'GET /login' },
  });
  const ok = r.status === 200 && String(r.body).includes('name="email"') && String(r.body).includes('name="password"');
  errors.add(!ok);
  overload.add(r.status === 429 || r.status === 503);
  timeouts.add(String(r.body).includes('FUNCTION_INVOCATION_TIMEOUT'));
  slow = r.timings.duration > 10000 || r.error_code === 1050 ? slow + 1 : 0;
  if (r.status === 429 || r.status === 503) exec.test.abort(`Stop: HTTP ${r.status}; no retry against production`);
  if (slow >= 3) exec.test.abort('Stop: three consecutive requests over 10 seconds in one VU');
  sleep(10 + Math.random() * 2);
}
export function handleSummary(data) {
  return { [__ENV.SUMMARY_PATH || 'test-results/loadtest-smoke.json']: JSON.stringify(data, null, 2) };
}
