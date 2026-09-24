import assert from 'node:assert/strict';
import fs from 'node:fs';
import { actionReferences, actionOK, caseId, ownedUser, multipartFields, validateManifest } from './protocol.mjs';
const id = '40041de9da922639967e196556c5f4597084264723';
assert.deepEqual(actionReferences(`let Q=(0,l.createServerReference)("${id}",l.callServer,void 0,l.findSourceMapURL,"createCaseAction")`), { createCaseAction: id });
assert(actionOK('0:{"a":"$@1"}\n1:{"ok":true}\n'));
assert(!actionOK('0:{"ok":true}\n1:{"ok":false,"errors":{}}\n'));
assert(!actionOK('1:E{"digest":"123"}\n'));
assert.equal(caseId('abc1234567', 1), 'loadtest_abc1234567_1_seed');
assert.throws(() => caseId('abc%_123', 1));
assert.throws(() => caseId('abc1234567', 201));
const account = { email: 'test+cgk+01@example.com', branch: 'CGK', number: 1 };
const user = { email: account.email, created_at: '2026-09-24T01:01:00Z', app_metadata: { loadtest_run: 'abc1234567' } };
assert(ownedUser(user, account, 'abc1234567', '2026-09-24T01:00:00Z'));
assert(!ownedUser({ ...user, created_at: '2026-09-23T01:00:00Z' }, account, 'abc1234567', '2026-09-24T01:00:00Z'));
assert(!ownedUser({ ...user, app_metadata: {} }, account, 'abc1234567', '2026-09-24T01:00:00Z'));
assert(!ownedUser({ ...user, email: 'existing@example.com' }, account, 'abc1234567', '2026-09-24T01:00:00Z'));
const management = fs.readFileSync(new URL('./manage.mjs', import.meta.url), 'utf8');
assert(management.includes(".in('iap_id', ids).in('title', ids)"));

assert.equal(multipartFields({ '$ACTION_REF_1': '', email: 'test+cgk+01@example.com' }, 'boundary').contentType, 'multipart/form-data; boundary=boundary');
assert(multipartFields({ a: 'hello' }, 'boundary').body.endsWith('--boundary--\r\n'));
assert.throws(() => multipartFields({ 'bad\r\nname': 'x' }, 'boundary'));
const plan = { run: 'abc1234567', started: '2026-09-24T01:00:00Z', accounts: [{ ...account, fullName: 'loadtest_abc1234567_CGK_1' }], registrations: [], baseline: [], cases: ['seed', 0, 1, 2, 3, 4, 5].map(cycle => caseId('abc1234567', 1, cycle)) };
validateManifest(plan);
assert.throws(() => validateManifest({ ...plan, cases: ['existing_case'] }));
assert.throws(() => validateManifest({ ...plan, baseline: [{ iap_id: plan.cases[0] }] }));

console.log('Protocol correlation, multipart encoding, RSC result, identity bounds, and cleanup ownership checks passed.');
