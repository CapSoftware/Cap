import { createPagesBrowserClient } from "@supabase/auth-helpers-nextjs";
import { Database } from "./types";

export const createBrowserClient = () => createPagesBrowserClient<Database>();
