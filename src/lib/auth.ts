import "server-only";

import { cache } from "react";
import { redirect } from "next/navigation";
import { isOfflineAuth, isOpenAccess } from "@/lib/offline";
import { supabaseServer } from "@/lib/supabase/server";
import { PUSAT, isBranchCode } from "@/domain/branches";

export interface Profile {
  id: string;
  email: string;
  fullName: string;
  branchCode: string;
  role: "admin" | "user";
  status: "pending" | "active" | "inactive";
}

/** Stands in for a signed-in head-office admin when there is no real project behind the app. */
const OFFLINE_PROFILE: Profile = {
  id: "offline",
  email: "offline@local",
  fullName: "Mode Offline",
  branchCode: PUSAT,
  role: "admin",
  status: "active",
};

/** The same stand-in for break-glass open access, named for what people will see. */
const OPEN_ACCESS_PROFILE: Profile = {
  id: "open-access",
  email: "",
  fullName: "Akses Terbuka",
  branchCode: PUSAT,
  role: "admin",
  status: "active",
};

/**
 * The signed-in user's profile, or null when nobody is signed in.
 *
 * Memoised per render so a page and its layout do not each pay for the lookup.
 * `getClaims` verifies the token's signature against the project's JWKS (cached in
 * memory) rather than trusting a cookie the browser supplied. On every route that
 * needs a session the middleware has already called `getUser` on this same request
 * and turned the request away if Supabase refused it, so the session is still
 * checked with Supabase once per request — this avoids paying that round trip twice.
 */
export const currentProfile = cache(() => loadProfile("claims"));

/**
 * The same, verified with Supabase by `getUser`. For public pages only: there the
 * middleware lets the request through even when Supabase refused the session, so a
 * token that merely verifies locally must not count as signed in.
 */
export const verifiedProfile = cache(() => loadProfile("server"));

async function loadProfile(verify: "claims" | "server"): Promise<Profile | null> {
  // Neither form of verification can reach a project that is not answering, so
  // open access has to short-circuit both.
  if (isOpenAccess()) return OPEN_ACCESS_PROFILE;
  if (isOfflineAuth()) return OFFLINE_PROFILE;

  const supabase = await supabaseServer();
  const userId = verify === "server"
    ? (await supabase.auth.getUser()).data.user?.id
    : (await supabase.auth.getClaims()).data?.claims.sub;
  if (!userId) return null;

  const { data } = await supabase
    .from("profiles")
    .select("id, email, full_name, branch_code, role, status")
    .eq("id", userId)
    .single();
  if (!data || !isBranchCode(data.branch_code) ||
      !["admin", "user"].includes(data.role) ||
      !["pending", "active", "inactive"].includes(data.status)) return null;

  return {
    id: data.id,
    email: data.email,
    fullName: data.full_name,
    branchCode: data.branch_code,
    role: data.role,
    status: data.status,
  };
}

/**
 * Gate for every page that shows tracker data. An account that exists but has not
 * been approved — or has been deactivated — is bounced to the login screen with a
 * reason rather than shown an empty dashboard.
 */
export async function requireActiveProfile(): Promise<Profile> {
  const profile = await currentProfile();
  if (!profile) redirect("/login");
  if (profile.status === "pending") redirect("/login?notice=pending");
  if (profile.status === "inactive") redirect("/login?notice=inactive");
  if (profile.status !== "active") redirect("/login");
  return profile;
}

export async function requireAdmin(): Promise<Profile> {
  const profile = await requireActiveProfile();
  if (profile.role !== "admin") redirect("/");
  return profile;
}
