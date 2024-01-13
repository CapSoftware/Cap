"use client";
import { type Session } from "@supabase/auth-helpers-nextjs";
import { createContext, useContext } from "react";

type MaybeSession = Session | null;

type SupabaseContext = {
  session: MaybeSession;
};

// @ts-ignore
const Context = createContext<SupabaseContext>();

export default function SupabaseProvider({
  children,
  session,
}: {
  children: React.ReactNode;
  session: MaybeSession;
}) {
  return (
    <Context.Provider value={{ session }}>
      <>{children}</>
    </Context.Provider>
  );
}

export const useSupabase = () => useContext(Context);
