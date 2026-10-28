import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { isLocalFixtureMode, isOfflineAuth, isOpenAccess } from "@/lib/offline";
import { contentSecurityPolicy } from "@/lib/security";

const PUBLIC_PATHS = new Set([
  "/login", "/register", "/forgot-password", "/reset-password", "/auth/callback",
]);

export async function middleware(request: NextRequest) {
  const nonce = btoa(crypto.randomUUID());
  const policy = contentSecurityPolicy(nonce);
  const requestHeaders = new Headers(request.headers);
  // Overwrite caller-supplied nonce headers before Next renders inline scripts.
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", policy);
  const secure = (response: NextResponse) => {
    response.headers.set("Content-Security-Policy", policy);
    response.headers.set("Cache-Control", "private, no-store, max-age=0");
    return response;
  };
  let response = NextResponse.next({ request: { headers: requestHeaders } });
  const path = request.nextUrl.pathname;
  // Open access is a production mode, so it must not unlock the fixture endpoints.
  if (path.startsWith("/api/test/") && !isLocalFixtureMode()) {
    return secure(new NextResponse("Not found", { status: 404 }));
  }
  if (isOpenAccess()) {
    // Supabase is what the account screens talk to, and it is the thing that is
    // unavailable; sending people to a login form that cannot answer is worse
    // than putting them on the dashboard they came for.
    if (!PUBLIC_PATHS.has(path)) return secure(response);
    return secure(NextResponse.redirect(new URL("/", request.url)));
  }
  if (isOfflineAuth()) return secure(response);

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    return secure(new NextResponse("Layanan belum tersedia. Hubungi admin.", { status: 503 }));
  }
  const supabase = createServerClient(url, key, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (written) => {
        for (const { name, value } of written) request.cookies.set(name, value);
        requestHeaders.set("cookie", request.cookies.toString());
        response = NextResponse.next({ request: { headers: requestHeaders } });
        for (const { name, value, options } of written) response.cookies.set(name, value, options);
      },
    },
  });
  const { data: { user } } = await supabase.auth.getUser();
  if (!user && !PUBLIC_PATHS.has(path)) {
    const denied = path.startsWith("/api/")
      ? NextResponse.json({ error: "Autentikasi diperlukan." }, { status: 401 })
      : NextResponse.redirect(new URL("/login", request.url));
    for (const cookie of response.cookies.getAll()) denied.cookies.set(cookie);
    return secure(denied);
  }
  return secure(response);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|logo-gapura.webp|api/health$).*)"],
};
