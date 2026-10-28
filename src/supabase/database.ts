export type DbRow = { cells: (string | number)[]; version: number };

export class SupabaseDatabase {
  constructor(private readonly url: string, private readonly key: string, private readonly serverToken = "") {
    if (!url || (!key && !serverToken)) throw new Error("SUPABASE_URL dan akses server Supabase wajib diatur.");
    if (!/^https:\/\//.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1):/.test(url))
      throw new Error("SUPABASE_URL tidak valid.");
  }
  async rpc<T>(name: string, body: Record<string, unknown> = {}): Promise<T> {
    const gateway = !this.key;
    const response = await fetch(`${this.url.replace(/\/$/, "")}${gateway ? "/functions/v1/iap-data" : "/rest/v1/rpc/" + name}`, {
      method: "POST", headers: { ...(gateway ? { "x-iap-server-token": this.serverToken } : { apikey: this.key,
        ...(this.key.startsWith("sb_secret_") ? {} : { Authorization: `Bearer ${this.key}` }),
        }), "Content-Type": "application/json" },
      body: JSON.stringify(gateway ? { name, payload: body } : body), cache: "no-store", signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      const detail = await response.json().catch(() => ({})) as { message?: string };
      throw new Error(`Supabase ${name} (${response.status}): ${detail.message ?? "request gagal"}`);
    }
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }
  snapshot(): Promise<DbRow[]> { return this.rpc("iap_snapshot"); }
  /** The rows and the tracker rev they were read at; only the rev while it is still `since`. */
  snapshotSince(since: number | null = null): Promise<{ rev: number; rows?: DbRow[] }> {
    return this.rpc("iap_snapshot_since", { p_rev: since });
  }
}
export function databaseKind(): "memory" | "supabase" {
  const kind = process.env.DATA_BACKEND;
  if (kind === "memory" || (!kind && process.env.SHEETS_TRANSPORT === "memory")) return "memory";
  if (kind && kind !== "supabase") throw new Error("DATA_BACKEND harus supabase atau memory.");
  return "supabase";
}
export function database(): SupabaseDatabase {
  // The server talks to the same project the browser signs in to; SUPABASE_URL only
  // needs setting when the data lives elsewhere.
  return new SupabaseDatabase(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "",
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
    process.env.SUPABASE_IAP_SERVER_TOKEN ?? "");
}
