"use server";
import { cookies } from "next/headers";

export const setTheme = async (newTheme: "light" | "dark") => {
  const cookieStore = cookies();
  cookieStore.set("theme", newTheme);
};