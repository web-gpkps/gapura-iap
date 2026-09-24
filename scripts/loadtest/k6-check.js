import { parseHTML } from 'k6/html';
import { hiddenFields, actionReferences, actionOK } from './protocol.mjs';
export const options = { vus: 1, iterations: 1 };
export default function () {
  const html = parseHTML('<form><input type="hidden" name="$ACTION_REF_1"><input type="hidden" name="$ACTION_1:0" value="&quot;bound&quot;"></form><form><input type="hidden" name="$ACTION_ID_abc"><button data-testid="sign-out">Keluar</button></form>');
  const fields = hiddenFields(html, 'form:has([data-testid="sign-out"])');
  if (JSON.stringify(fields) !== '{"$ACTION_ID_abc":""}') throw new Error('Logout selector failed');
  if (hiddenFields(html)['$ACTION_1:0'] !== '"bound"') throw new Error('Hidden correlation failed');
  if (!actionOK('1:{"ok":true}\n') || actionOK('1:{"ok":false}\n')) throw new Error('RSC result parser failed');
  if (!actionReferences('(0,x.createServerReference)("40041de9da922639967e196556c5f4597084264723",x.callServer,void 0,x.findSourceMapURL,"createCaseAction")').createCaseAction) throw new Error('Action discovery failed');
  console.log('k6 native HTML, deployed action ID parser, RSC parser: passed (zero network)');
}
