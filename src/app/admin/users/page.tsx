import Link from "next/link";
import { AppHeader } from "@/components/AppHeader";
import { UserAdmin, type AdminUser } from "@/components/UserAdmin";
import { requireAdmin } from "@/lib/auth";
import { isOfflineAuth, isOpenAccess } from "@/lib/offline";
import { supabaseServer } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * Registration dates are formatted here rather than in the table, so the server and
 * the browser cannot disagree about the timezone — the rest of the dashboard reads
 * in Asia/Jakarta and this follows it.
 */
const REGISTERED_ON = new Intl.DateTimeFormat("id-ID", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "Asia/Jakarta",
});

export default async function AdminUsersPage() {
  const admin = await requireAdmin();
  // Offline fixture mode has no Supabase project behind it, so there are no accounts
  // to manage. Saying so beats a permission error from a query that cannot succeed.
  const offline = isOfflineAuth() || isOpenAccess();
  const supabase = offline ? null : await supabaseServer();

  // Row level security already limits this to admins; `requireAdmin` above is what
  // turns a non-admin away with a redirect rather than an empty page.
  const { data, error } = offline
    ? { data: [], error: null }
    : await supabase!
        .from("profiles")
        .select("id, email, full_name, branch_code, role, status, created_at")
        .order("created_at", { ascending: false });

  const users: AdminUser[] = (data ?? []).map((row) => ({
    id: row.id,
    email: row.email,
    fullName: row.full_name,
    branchCode: row.branch_code,
    role: row.role,
    status: row.status,
    createdAt: REGISTERED_ON.format(new Date(row.created_at)),
  }));

  return (
    <>
      {/* The same bar the dashboard carries, so signing out and switching between
          the two screens works the same way on both. */}
      <AppHeader profile={admin} />

      <main className="mx-auto max-w-[1100px] px-4 pt-7 pb-16 sm:px-8 sm:pt-9">
      <header className="mb-7 flex flex-wrap items-start justify-between gap-5">
        <div>
          <p className="mb-1.5 text-[12px] font-semibold tracking-[0.12em] text-accent uppercase">
            Administrasi
          </p>
          <h1 className="text-[24px] font-bold text-ink-strong sm:text-[30px]">
            Manajemen Pengguna
          </h1>
          <p className="mt-1.5 text-[13px] text-muted">
            Setujui pendaftaran baru, atur cabang dan peran, nonaktifkan atau hapus akun.
          </p>
        </div>
        <Link href="/" className="btn">
          Kembali ke dasbor
        </Link>
      </header>

      {offline ? (
        <p className="card px-4 py-4 text-[13px] text-muted">
          Tidak ada proyek Supabase yang terhubung saat ini, sehingga tidak ada akun
          untuk dikelola.
        </p>
      ) : error ? (
        <p role="alert" className="card px-4 py-4 text-[13px] text-late-ink">
          Gagal memuat daftar pengguna. Silakan coba lagi atau hubungi admin.
        </p>
      ) : (
        <UserAdmin users={users} currentUserId={admin.id} />
      )}
      </main>
    </>
  );
}
