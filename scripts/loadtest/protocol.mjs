// Shared pure helpers; no deployment-specific action IDs or auth tokens.
export function actionReferences(source) {
  const result = {};
  const pattern = /createServerReference\)?\(\s*["']([a-f0-9]{40,})["'][^;\n]{0,350}?["'](\w+Action)["']\s*\)/g;
  for (const match of source.matchAll(pattern)) result[match[2]] = match[1];
  return result;
}
export function actionOK(body) {
  // The RSC action result is row 1. A dashboard payload containing another `ok`
  // must never turn a failed mutation into success.
  return String(body).split('\n').some(line => {
    if (!line.startsWith('1:')) return false;
    try { return JSON.parse(line.slice(2)).ok === true; } catch { return false; }
  });
}
export function caseId(run, vu, cycle = 'seed') {
  if (!/^[a-z0-9]{8,24}$/.test(run) || !Number.isInteger(vu) || vu < 1 || vu > 200 ||
      !(cycle === 'seed' || Number.isInteger(cycle) && cycle >= 0 && cycle < 6)) throw new Error('Invalid test identity');
  return `loadtest_${run}_${vu}_${cycle}`;
}
export function ownedUser(user, account, run, started) {
  return user.email === account.email && new Date(user.created_at).getTime() >= new Date(started).getTime() &&
    (user.app_metadata?.loadtest_run === run || user.user_metadata?.full_name === `loadtest_${run}_${account.branch}_${account.number}`);
}

export function hiddenFields(selection, selector = 'form') {
  const result = {}, hidden = selection.find(`${selector} input[type="hidden"]`);
  for (let i = 0; i < hidden.size(); i++) {
    const element = hidden.eq(i); result[element.attr('name')] = element.attr('value') || '';
  }
  if (!Object.keys(result).some(k => k.startsWith('$ACTION_'))) throw new Error('Missing dynamic action/CSRF fields');
  return result;
}

export function multipartFields(fields, boundary) {
  if (!/^[a-zA-Z0-9-]+$/.test(boundary)) throw new Error('Invalid multipart boundary');
  const body = Object.entries(fields).map(([name, value]) => {
    if (/["\r\n]/.test(name) || String(value).includes(boundary)) throw new Error('Invalid multipart field');
    return `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
  }).join('') + `--${boundary}--\r\n`;
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

export function validateManifest(plan) {
  if (!plan || !Array.isArray(plan.accounts) || plan.accounts.length < 1 || plan.accounts.length > 200) throw new Error('Invalid account plan');
  const expectedCases = plan.accounts.flatMap((_, i) => ['seed', 0, 1, 2, 3, 4, 5].map(cycle => caseId(plan.run, i + 1, cycle)));
  if (JSON.stringify(expectedCases) !== JSON.stringify(plan.cases)) throw new Error('Manifest case ownership mismatch');
  for (const a of [...plan.accounts, ...plan.registrations]) {
    if (!/^[A-Z]{3,5}$/.test(a.branch) || !Number.isInteger(a.number) || a.number < 1 || a.number > 7 ||
        a.email !== `test+${a.branch.toLowerCase()}+${String(a.number).padStart(2, '0')}@example.com` ||
        a.fullName !== `loadtest_${plan.run}_${a.branch}_${a.number}`) throw new Error('Manifest account ownership mismatch');
  }
  if (plan.baseline.some(row => plan.cases.includes(row.iap_id))) throw new Error('Manifest overlaps existing rows');
  if (!Number.isFinite(Date.parse(plan.started))) throw new Error('Invalid manifest timestamp');
}
