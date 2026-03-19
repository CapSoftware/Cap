"use server";
import { cookies } from "next/headers";

export const setTheme = async (newTheme: "light" | "dark") => {
	const cookieStore = await cookies();
	cookieStore.set("theme", newTheme);
};
