/** Offline privileges are confined to explicit, isolated local fixture runs. */
export function isLocalFixtureMode(): boolean {
  return process.env.ENABLE_OFFLINE_TEST_MODE === "1" &&
    process.env.SHEETS_TRANSPORT?.trim().toLowerCase() === "memory" &&
    !process.env.VERCEL &&
    !process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL?.trim() &&
    !process.env.GOOGLE_PRIVATE_KEY?.trim() &&
    !process.env.GOOGLE_DRIVE_OAUTH_REFRESH_TOKEN?.trim();
}

/** Security integration tests keep real application auth gates enabled. */
export function isOfflineAuth(): boolean {
  return isLocalFixtureMode() && process.env.REQUIRE_AUTH_IN_FIXTURE_MODE !== "1";
}

/**
 * Break-glass: serve the tracker straight from Google Sheets, with no sign-in.
 *
 * Supabase carries both the accounts and the tracker data, so when the project is
 * unreachable — a blown free-tier quota, an outage — every screen is dead, login
 * first. This flag trades the account layer away to keep the tracker working: the
 * data backend falls back to the spreadsheet and anyone who can reach the URL is
 * treated as a head-office admin. `DATA_BACKEND=memory` is required alongside it,
 * because open access to a dashboard that still cannot load its rows is no use.
 *
 * Per-branch filtering disappears with the accounts, so this is for the short
 * stretch until Supabase answers again, not a way to run the app.
 */
export function isOpenAccess(): boolean {
  return process.env.IAP_OPEN_ACCESS === "1" && process.env.DATA_BACKEND === "memory";
}
