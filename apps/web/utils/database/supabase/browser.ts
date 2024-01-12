import { createPagesBrowserClient } from "@supabase/auth-helpers-nextjs";
import type { Database } from "@cap/utils";

export const createBrowserClient = () =>
  createPagesBrowserClient<Database>({
    supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
    supabaseKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  });
