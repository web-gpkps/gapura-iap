import { SupabaseDatabase, type DbRow } from "../supabase/database";
import { equal, indexRows, keyOf, normalize, reconcile, TRACKER_HEADERS, type Cells } from "./reconcile";
export interface MirrorSheet {
  readRange(range: string): Promise<string[][]>;
  writeRanges(updates: readonly { range: string; values: Cells[] }[]): Promise<void>;
}
type State = { initialized: boolean; baseline_count: number; baseline_hash: string | null;
  synced_rev: number | null; rev: number };
function column(i: number) { return String.fromCharCode(65 + i); }
/** Order-free SHA-256 of tracker rows, so a sheet can be compared with the baseline without downloading it. */
async function fingerprint(rows: readonly Cells[]) {
  const sorted = rows.map(row => [keyOf(row), row] as const).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(sorted)));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
async function snapshot(db: SupabaseDatabase): Promise<{ rev: number; rows: DbRow[] }> {
  const { rev, rows } = await db.snapshotSince();
  if (!rows) throw new Error("Snapshot Supabase tidak berisi baris.");
  return { rev, rows };
}
/**
 * `force` is set by the Apps Script webhook so a live sheet edit does not wait
 * out the idle cooldown. Failure backoff is still honoured inside the RPC.
 */
export async function syncOnce(db: SupabaseDatabase, sheet: MirrorSheet, tab = "Tracker", force = false) {
  const token = crypto.randomUUID();
  const state = await db.rpc<State | null>("iap_sync_acquire", { p_token: token, p_force: force });
  if (!state) return { skipped: true };
  const range = `'${tab.replace(/'/g, "''")}'!A1:W`;
  try {
    const source = await sheet.readRange(range);
    if (!equal(source[0]?.slice(0,23).map(h => h.trim()), TRACKER_HEADERS))
      throw new Error("Header Tracker A–W berubah; sesuaikan mapping schema sebelum sinkronisasi.");
    const raw = source.slice(1);
    const sheetRows = raw.filter(row => String(row[1] ?? "").trim()).map(normalize);
    // Fail the entire import on malformed or duplicate keys; never partially import.
    indexRows(sheetRows);
    if (state.initialized && state.baseline_count && !sheetRows.length)
      throw new Error("Tracker kosong; sinkronisasi dihentikan untuk mencegah penghapusan massal.");
    // The baseline is what both sides held after the last sync, so a side whose
    // fingerprint or rev has not moved still equals it.
    const sheetUnchanged = (await fingerprint(sheetRows)) === state.baseline_hash;
    if (state.initialized && sheetUnchanged && state.rev === state.synced_rev) {
      // Nothing to do; finishing without a baseline downloads and rewrites nothing.
      await db.rpc("iap_sync_finish", { p_token: token, p_error: null });
      return { skipped: false, idle: true };
    }
    const initial = await snapshot(db);
    const baseline = sheetUnchanged ? sheetRows
      : initial.rev === state.synced_rev ? initial.rows.map(r => r.cells)
      : await db.rpc<Cells[] | null>("iap_sync_baseline", { p_token: token });
    if (!baseline) throw new Error("Sync lease lost");
    const plan = reconcile(baseline, sheetRows, initial.rows);
    await db.rpc("iap_sync_apply", { p_token: token, p_changes: plan.changes, p_conflicts: plan.conflicts });
    // Without changes the apply wrote nothing, so the first snapshot is still the one
    // to mirror. A later app edit raises the rev and is picked up next cycle.
    const final = plan.changes.length ? await snapshot(db) : initial;
    // Detect edits and row moves while the database transaction was running.
    const observed = await sheet.readRange(range);
    if (!equal(source, observed)) throw new Error("Google Sheets berubah selama sinkronisasi; ulangi pada siklus berikutnya.");
    const positions = new Map<string, number>();
    raw.forEach((row, i) => { if (String(row[1] ?? "").trim()) positions.set(keyOf(normalize(row)), i + 2); });
    const desired = new Map(final.rows.map(row => [keyOf(row.cells), row.cells]));
    const updates: { range: string; values: Cells[] }[] = [];
    const escapedTab = `'${tab.replace(/'/g, "''")}'`;
    for (const [key, position] of positions) {
      const existing = normalize(raw[position - 2]!);
      const target = desired.get(key);
      if (!target) updates.push({ range: `${escapedTab}!A${position}:W${position}`, values: [Array(23).fill("") as Cells] });
      else for (let i = 0; i < 23; i++) if (!equal(existing[i], target[i])) {
        updates.push({ range: `${escapedTab}!${column(i)}${position}`, values: [[target[i]!]] });
      }
    }
    // Fixed ranges make retries idempotent even if a Google response times out after committing.
    let next = raw.length + 2;
    for (const [key, target] of desired) if (!positions.has(key)) {
      updates.push({ range: `${escapedTab}!A${next}:W${next}`, values: [target] });
      next++;
    }
    // Verify outbound writes before acknowledging the baseline; a timeout is never success.
    if (updates.length) await sheet.writeRanges(updates);
    const verified = await sheet.readRange(range);
    if (!equal(verified[0], source[0])) throw new Error("Header Google Sheets berubah saat mirror.");
    const actual = indexRows(verified.slice(1).filter(r => String(r[1] ?? "").trim()).map(normalize));
    for (const [key, cells] of desired) if (!equal(actual.get(key), cells))
      throw new Error("Verifikasi mirror Google Sheets gagal; perubahan belum diakui.");
    if (actual.size !== desired.size) throw new Error("Baris Google Sheets berubah saat mirror.");
    const cells = final.rows.map(r => r.cells);
    await db.rpc("iap_sync_finish", { p_token: token, p_baseline: cells, p_error: null,
      p_baseline_hash: await fingerprint(cells), p_rev: final.rev });
    return { skipped: false, rows: cells.length, imported: plan.changes.length,
      writes: updates.length, conflicts: plan.conflicts.length };
  } catch (error) {
    await db.rpc("iap_sync_finish", { p_token: token,
      p_error: error instanceof Error ? error.message : "Sync gagal",
      p_retry_after_seconds: Math.max(0, Math.ceil(
        Number((error as { retryAfterMs?: number })?.retryAfterMs ?? 0) / 1000)) });
    throw error;
  }
}
