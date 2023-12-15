"use client";
import { createContext, useContext } from "react";
import type { Database } from "@/utils/database/supabase/types";
import { useSharedContext } from "@/app/dashboard/_components/DynamicSharedLayout";
import { useParams } from "next/navigation";

type WebsiteContext = {
  activeWebsite: Database["public"]["Tables"]["websites"]["Row"] | null;
};

const Context = createContext<WebsiteContext>({} as WebsiteContext);

export function WebsiteLayout({ children }: { children: React.ReactNode }) {
  const params = useParams();

  const { websiteData } = useSharedContext();

  const activeWebsite = (websiteData?.find(
    (website) => website.active === true
  ) ?? null) as WebsiteContext["activeWebsite"];

  console.log("activeWebsite:");
  console.log(activeWebsite);

  return (
    <Context.Provider value={{ activeWebsite }}>{children}</Context.Provider>
  );
}

export const useWebsiteContext = () => useContext(Context);
