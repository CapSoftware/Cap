import { createPagesBrowserClient } from "@supabase/auth-helpers-nextjs";
import type { Database } from "@cap/utils";

export const createBrowserClient = () => createPagesBrowserClient<Database>();
