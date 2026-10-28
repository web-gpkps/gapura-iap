import Link from "next/link";
import { signOutAction } from "@/app/auth/actions";
import { branchLabel, PUSAT } from "@/domain/branches";
import type { Profile } from "@/lib/auth";
import { isOpenAccess } from "@/lib/offline";
import { Logo } from "./Logo";

/**
 * Account bar above the dashboard.
 *
 * The branch is set as a chip rather than run together with the name in one line of
 * middot-separated text: it is the one fact that changes what the page below shows,
 * so a branch user is never left wondering whether they are looking at a partial
 * tracker or an empty one.
 */
export function AppHeader({ profile }: { profile: Profile }) {
  const isPusat = profile.branchCode === PUSAT;
  const isAdmin = profile.role === "admin";
  // Nothing to sign out of, and no accounts to manage, while the account layer is
  // the part that is down. Saying so beats two buttons that only produce errors.
  const open = isOpenAccess();

  return (
    <div className="sticky top-0 z-20 border-b border-line bg-surface/90 backdrop-blur-sm">
      <div className="mx-auto flex min-h-[var(--app-header-h)] max-w-[1400px] flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5 sm:px-8">
        <Link href="/" className="flex shrink-0 items-center" aria-label="Beranda dasbor">
          <Logo height={28} priority />
        </Link>

        <span aria-hidden className="hidden h-6 w-px bg-line sm:block" />

        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <span
            className={`pill ${
              isPusat ? "bg-plan-soft text-plan-ink" : "bg-head text-ink-mid"
            }`}
            title={branchLabel(profile.branchCode)}
            data-testid="branch-chip"
          >
            {isPusat ? "Kantor Pusat · seluruh cabang" : `Cabang ${profile.branchCode}`}
          </span>

          <span className="min-w-0 truncate text-[12px] text-muted">
            <span className="font-semibold text-ink">
              {profile.fullName || profile.email}
            </span>
            <span className="ml-1.5 text-faint">
              {isAdmin ? "Admin" : "Pengguna cabang"}
            </span>
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {open ? (
            <span className="pill bg-late/10 text-late-ink" data-testid="open-access">
              Akses terbuka · tanpa login
            </span>
          ) : (
            <>
              {isAdmin ? (
                <Link href="/admin/users" className="btn">
                  Manajemen Pengguna
                </Link>
              ) : null}
              <form action={signOutAction}>
                {/* Outlined rather than solid: it reads unmistakably as the red exit,
                    without outweighing the work the page is actually for. */}
                <button
                  type="submit"
                  className="btn border-late/40 text-late-ink hover:!bg-late hover:border-late hover:text-white"
                  data-testid="sign-out"
                >
                  Keluar
                </button>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
