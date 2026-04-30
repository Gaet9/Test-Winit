/**
 * Shared by the Playwright CLI worker and any long-running host (e.g. Render).
 * Render often uses SUPABASE_URL; Next/Vercel use NEXT_PUBLIC_SUPABASE_URL.
 */

export function resolveSupabaseProjectUrl(): string | undefined {
  const u =
    process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || process.env.SUPABASE_URL?.trim() || ""
  return u || undefined
}

export function resolveSupabaseServiceRoleKey(): string | undefined {
  const k = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || ""
  return k || undefined
}
