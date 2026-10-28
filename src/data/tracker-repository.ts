import "server-only";
import { cache } from "react";
import { database, databaseKind, type DbRow } from "@/supabase/database";
import { rowToItem, safeLink, safeLinks } from "@/domain/rows";
import { viewOnlyLink } from "@/domain/evidence";
import { todayInJakarta } from "@/domain/dates";
import type { ItemKey } from "@/domain/types";
import type { CaseInput, StepInput, FieldErrors } from "@/domain/validate";
import { contextsFromCells, type CaseContext } from "@/domain/context";
import type { ActionItem } from "@/domain/types";
import * as offline from "./sheet-tracker-repository";
import { readContexts as offlineContexts } from "./sheet-case-context";

export type MutationResult = { ok: true } | { ok: false; errors: FieldErrors };

/**
 * The last snapshot this server instance read. A render asks Supabase only whether
 * the tracker moved past that rev, so a refresh with nothing new costs a few bytes
 * of egress instead of the whole table. Branch filtering still runs per request on
 * whatever this returns, and consumers only read the shared rows.
 */
let latest: { rev: number; rows: DbRow[] } | undefined;
export const readDatabaseRows = cache(async (): Promise<DbRow[]> => {
  const known = latest;
  const { rev, rows } = await database().snapshotSince(known?.rev ?? null);
  if (!rows) return known!.rows;
  // A slower request must not replace a newer snapshot; the rev only ever rises.
  if (!latest || rev >= latest.rev) latest = { rev, rows };
  return rows;
});
export const readItems = cache(async () => databaseKind() === "memory"
  ? offline.readItems() : (await readDatabaseRows()).map(r => rowToItem(r.cells)));

/**
 * Items and case context from one snapshot. `cache` only memoises inside a React
 * render, so a route handler calling `readItems` and `readContexts` separately
 * would fetch the snapshot twice; this fetches it once anywhere.
 */
export const readTracker = cache(async (): Promise<{
  items: ActionItem[];
  contexts: Record<string, CaseContext>;
}> => {
  if (databaseKind() === "memory") {
    const [items, contexts] = await Promise.all([offline.readItems(), offlineContexts()]);
    return { items, contexts };
  }
  const cells = (await readDatabaseRows()).map((row) => row.cells);
  return { items: cells.map(rowToItem), contexts: contextsFromCells(cells) };
});

const links = (raw: string) => [...new Set(safeLinks(raw).map(viewOnlyLink))].join("\n");
const step = (input: StepInput) => ({ ...input, evidenceLink: links(input.evidenceLink) });
async function mutate(operation: string, payload: Record<string, unknown>): Promise<MutationResult> {
  return database().rpc("iap_mutate", {
    p_operation: operation, p_payload: payload, p_today: todayInJakarta(),
  });
}
export async function updateStep(key: ItemKey, input: StepInput) {
  return databaseKind() === "memory" ? offline.updateStep(key, input)
    : mutate("update_step", { ...key, input: step(input) });
}
export async function createStep(iapId: string, input: StepInput) {
  return databaseKind() === "memory" ? offline.createStep(iapId, input)
    : mutate("create_step", { iapId, input: step(input) });
}
export async function deleteStep(key: ItemKey) {
  return databaseKind() === "memory" ? offline.deleteStep(key) : mutate("delete_step", { ...key });
}
export async function createCase(input: CaseInput) {
  return databaseKind() === "memory" ? offline.createCase(input)
    : mutate("create_case", { ...input, steps: input.steps.map(step) });
}
export async function updateCaseMeta(iapId: string, title: string, station: string, context?: CaseContext) {
  return databaseKind() === "memory" ? offline.updateCaseMeta(iapId, title, station)
    : mutate("update_case", { iapId, title, station, ...(context ? { context } : {}) });
}
export async function deleteCase(iapId: string) {
  return databaseKind() === "memory" ? offline.deleteCase(iapId) : mutate("delete_case", { iapId });
}
export async function appendEvidenceLinks(keys: readonly ItemKey[], rawLink: string): Promise<MutationResult> {
  if (!keys.length) return { ok: false, errors: { steps: "Pilih minimal satu langkah." } };
  const clean = safeLink(rawLink);
  if (!clean || clean.includes("\n")) return { ok: false, errors: {
    evidenceLink: "Link evidence baru harus satu URL http/https yang valid.",
  } };
  return databaseKind() === "memory" ? offline.appendEvidenceLinks(keys, rawLink)
    : mutate("append_evidence", { keys, link: viewOnlyLink(clean) });
}
export const appendEvidenceLink = (key: ItemKey, link: string) => appendEvidenceLinks([key], link);
