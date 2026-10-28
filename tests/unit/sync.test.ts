import test from "node:test";
import assert from "node:assert/strict";
import { reconcile, normalize, TRACKER_HEADERS, type Cells } from "../../src/sync/reconcile";
import { syncOnce, type MirrorSheet } from "../../src/sync/worker";
import { SupabaseDatabase } from "../../src/supabase/database";
import { GoogleQuota } from "../../src/sync/google-quota";

const row = (id = "TEST", step = 1): Cells =>
 [1,id,"Judul","CGK",step,"Langkah","Tindakan","PIC","","14 Okt 2026","Belum Dimulai",0,"","","","","","","","","","",""];
const edit = (cells: Cells, column: number, value: string | number) => {
 const r = [...cells]; r[column] = value; return r;
};
test("first import, unchanged polls, and direct DB edits", () => {
 const r = row();
 assert.equal(reconcile([], [r], []).changes.length, 1);
 assert.deepEqual(reconcile([r], [r], [{cells:r,version:1}]), {changes:[],conflicts:[]});
 const d = edit(r,7,"NEW PIC");
 assert.deepEqual(reconcile([r],[r],[{cells:d,version:2}]),{changes:[],conflicts:[]});
});
test("independent columns merge; conflicting columns keep Supabase with audit", () => {
 const r=row(), s=edit(r,7,"Sheets PIC"), d=edit(r,14,"Database evidence");
 const plan=reconcile([r],[s],[{cells:d,version:2}]);
 assert.equal(plan.changes[0]!.cells![7],"Sheets PIC");
 assert.equal(plan.changes[0]!.cells![14],"Database evidence");
 assert.equal(plan.changes[0]!.version,2);
 const conflict=reconcile([r],[s],[{cells:edit(r,7,"DB PIC"),version:3}]);
 assert.equal(conflict.changes.length,0);
 assert.deepEqual(conflict.conflicts.map(c=>c.column),["pic"]);
 assert.equal(conflict.conflicts[0]!.sheet,"Sheets PIC");
});
test("deletions propagate; concurrent delete/edit is recorded", () => {
 const r=row();
 assert.equal(reconcile([r],[],[{cells:r,version:4}]).changes[0]!.cells,null);
 assert.equal(reconcile([r],[r],[]).changes.length,0);
 const plan=reconcile([r],[],[{cells:edit(r,7,"new"),version:5}]);
 assert.equal(plan.changes.length,0);
 assert.equal(plan.conflicts[0]!.column,"__row__");
});
test("duplicate composite keys and invalid sheet numbers fail atomically", () => {
 assert.throws(()=>reconcile([],[row(),row()],[]),/Duplikat/);
 assert.throws(()=>normalize(edit(row(),4,"invalid")),/Angka/);
 assert.throws(()=>normalize(edit(row(),11,101)),/progres/);
});

class FakeDatabase extends SupabaseDatabase {
 rows: {cells:Cells;version:number}[] = [];
 calls: {name:string;body:Record<string,unknown>}[] = [];
 baseline: Cells[]=[]; baselineHash:string|null=null; syncedRev:number|null=null; rev=0;
 initialized=false; available=true; failApply=false;
 constructor() { super("https://example.supabase.co","secret"); }
 /** An edit made in the app: the row changes and the tracker rev rises with it. */
 appEdit(column:number,value:string|number) {
  const r=this.rows[0]!; this.rows[0]={cells:edit(r.cells,column,value),version:r.version+1}; this.rev++;
 }
 override async rpc<T>(name:string,body:Record<string,unknown>={}):Promise<T> {
  this.calls.push({name,body});
  if(name==="iap_sync_acquire")return (this.available?{initialized:this.initialized||!!this.baseline.length,
   baseline_count:this.baseline.length,baseline_hash:this.baselineHash,synced_rev:this.syncedRev,rev:this.rev}:null) as T;
  if(name==="iap_sync_baseline")return structuredClone(this.baseline) as T;
  if(name==="iap_sync_apply") {
   if(this.failApply)throw new Error("snapshot changed");
   const changes=body.p_changes as {cells:Cells;version:number|null;iapId:string;stepNo:number}[];
   for(const c of changes){
    this.rows=this.rows.filter(r=>r.cells[1]!==c.iapId||r.cells[4]!==c.stepNo);
    if(c.cells)this.rows.push({cells:c.cells,version:(c.version??0)+1});
   }
   if(changes.length)this.rev++;
  }
  if(name==="iap_snapshot_since")return {rev:this.rev,rows:structuredClone(this.rows)} as T;
  if(name==="iap_sync_finish"&&body.p_error===null) {
   this.initialized=true;
   if(body.p_baseline){
    this.baseline=body.p_baseline as Cells[];
    this.baselineHash=body.p_baseline_hash as string;this.syncedRev=body.p_rev as number;
   }
  }
  return undefined as T;
 }
}
class FakeSheet implements MirrorSheet {
 raw:string[][]=[]; writes:{range:string;values:Cells[]}[]=[]; failWrite=false;
 changeOnSecondRead=false; reads=0;
 async readRange() {
  this.reads++;
  if(this.changeOnSecondRead && this.reads===2) this.raw[0]![7]="other editor";
  return [TRACKER_HEADERS, ...structuredClone(this.raw)];
 }
 async writeRanges(updates:readonly {range:string;values:Cells[]}[]) {
  if(this.failWrite) throw new Error("quota exhausted");
  this.writes.push(...updates);
  for(const u of updates){
   const m=u.range.match(/!([A-Z])(\d+)/)!;
   const i=Number(m[2])-2, col=m[1]!.charCodeAt(0)-65;
   this.raw[i]??=Array(23).fill("");
   u.values[0]!.forEach((v,j)=>this.raw[i]![col+j]=String(v));
  }
 }
}
test("worker imports and acknowledges only verified sheet data",async()=>{
 const db=new FakeDatabase(),sheet=new FakeSheet();sheet.raw=[row().map(String)];
 const result=await syncOnce(db,sheet);
 assert.equal(result.imported,1);assert.equal(sheet.writes.length,0);
 const finish=db.calls.find(c=>c.name==="iap_sync_finish")!;
 assert.equal(finish.body.p_error,null);
 assert.deepEqual(finish.body.p_baseline,[row()]);
});
test("cron runs stay throttled while the sheet webhook forces a cycle",async()=>{
 const cron=new FakeDatabase(),webhook=new FakeDatabase();
 await syncOnce(cron,new FakeSheet());
 await syncOnce(webhook,new FakeSheet(),"Tracker",true);
 assert.equal(cron.calls.find(c=>c.name==="iap_sync_acquire")!.body.p_force,false);
 assert.equal(webhook.calls.find(c=>c.name==="iap_sync_acquire")!.body.p_force,true);
});
test("worker writes only changed cells and keeps columns from other authors",async()=>{
 const db=new FakeDatabase(),sheet=new FakeSheet(),r=row();
 db.baseline=[r];db.rows=[{cells:edit(r,7,"NEW PIC"),version:2}];sheet.raw=[r.map(String)];
 await syncOnce(db,sheet);
 assert.deepEqual(sheet.writes,[{range:"'Tracker'!H2",values:[["NEW PIC"]]}]);
 assert.equal(sheet.raw[0]![16],"");
});
test("quota failure preserves baseline for retry",async()=>{
 const db=new FakeDatabase(),sheet=new FakeSheet(),r=row();
 db.baseline=[r];db.rows=[{cells:edit(r,7,"NEW PIC"),version:2}];sheet.raw=[r.map(String)];sheet.failWrite=true;
 await assert.rejects(()=>syncOnce(db,sheet),/quota/);
 const finish=db.calls.find(c=>c.name==="iap_sync_finish")!;
 assert.equal(finish.body.p_error,"quota exhausted");
 assert.equal(finish.body.p_baseline,undefined);
 assert.deepEqual(db.baseline,[r]);
});
test("an unchanged cycle downloads nothing and rewrites no baseline",async()=>{
 const db=new FakeDatabase(),sheet=new FakeSheet();sheet.raw=[row().map(String)];
 await syncOnce(db,sheet);
 db.calls=[];sheet.reads=0;
 assert.deepEqual(await syncOnce(db,sheet),{skipped:false,idle:true});
 assert.deepEqual(db.calls.map(c=>c.name),["iap_sync_acquire","iap_sync_finish"]);
 assert.equal(db.calls[1]!.body.p_baseline,undefined);
 assert.equal(sheet.reads,1);assert.equal(sheet.writes.length,0);
});
test("a change on one side merges against the side that did not move",async()=>{
 const db=new FakeDatabase(),sheet=new FakeSheet();sheet.raw=[row().map(String)];
 await syncOnce(db,sheet);
 db.calls=[];db.appEdit(7,"APP PIC");
 await syncOnce(db,sheet);
 assert.deepEqual(db.calls.map(c=>c.name),["iap_sync_acquire","iap_snapshot_since","iap_sync_apply","iap_sync_finish"]);
 assert.equal(sheet.raw[0]![7],"APP PIC");
 db.calls=[];sheet.raw[0]![14]="Sheets evidence";
 assert.equal((await syncOnce(db,sheet)).imported,1);
 assert.equal(db.calls.some(c=>c.name==="iap_sync_baseline"),false);
 assert.equal(db.rows[0]!.cells[14],"Sheets evidence");
});
test("the baseline is downloaded only when both sides changed",async()=>{
 const db=new FakeDatabase(),sheet=new FakeSheet();sheet.raw=[row().map(String)];
 await syncOnce(db,sheet);
 db.calls=[];db.appEdit(7,"APP PIC");sheet.raw[0]![14]="Sheets evidence";
 await syncOnce(db,sheet);
 assert.equal(db.calls.filter(c=>c.name==="iap_sync_baseline").length,1);
 assert.equal(db.rows[0]!.cells[7],"APP PIC");assert.equal(db.rows[0]!.cells[14],"Sheets evidence");
 assert.equal(sheet.raw[0]![7],"APP PIC");
});
test("row moves or concurrent sheet edits prevent outbound writes",async()=>{
 const db=new FakeDatabase(),sheet=new FakeSheet(),r=row();
 db.baseline=[r];db.rows=[{cells:edit(r,7,"NEW PIC"),version:2}];sheet.raw=[r.map(String)];sheet.changeOnSecondRead=true;
 await assert.rejects(()=>syncOnce(db,sheet),/berubah/);
 assert.equal(sheet.writes.length,0);
});
test("DB compare-and-set failure does not acknowledge or write",async()=>{
 const db=new FakeDatabase(),sheet=new FakeSheet();sheet.raw=[row().map(String)];db.failApply=true;
 await assert.rejects(()=>syncOnce(db,sheet),/snapshot changed/);
 assert.equal(sheet.writes.length,0);
 assert.equal(db.calls.at(-1)!.body.p_error,"snapshot changed");
});
test("lease coalesces overlapping worker invocations",async()=>{
 const db=new FakeDatabase(),sheet=new FakeSheet();db.available=false;
 assert.deepEqual(await syncOnce(db,sheet),{skipped:true});
 assert.equal(sheet.reads,0);
});
test("empty populated tracker blocks destructive import", async () => {
 const db = new FakeDatabase(), sheet = new FakeSheet();
 db.baseline = [row()]; db.rows = [{cells: row(), version: 1}];
 await assert.rejects(() => syncOnce(db, sheet), /penghapusan massal/);
 assert.equal(db.calls.some(c => c.name === "iap_sync_apply"), false);
 assert.equal(sheet.writes.length, 0);
});
test("429 retries then succeeds; long Retry-After leaves retry to job backoff", async () => {
 const quota = new GoogleQuota(); let calls = 0;
 const result = await quota.run("read", async () => {
  calls++; if (calls === 1) throw { response: { status: 429, headers: new Headers() } };
  return "success";
 });
 assert.equal(result, "success"); assert.equal(calls, 2);
 const other = new GoogleQuota(); calls = 0;
 await assert.rejects(() => other.run("read", async () => {
  calls++; throw { response: { status: 429, headers: new Headers({"Retry-After":"120"}) } };
 }));
 assert.equal(calls, 1);
});
test("permission errors are not retried and do not poison quota queue",async()=>{
 const quota=new GoogleQuota();let calls=0;
 await assert.rejects(()=>quota.run("read",async()=>{calls++;throw {code:403};}));
 assert.equal(calls,1);
 assert.equal(await quota.run("write",async()=>42),42);
});
