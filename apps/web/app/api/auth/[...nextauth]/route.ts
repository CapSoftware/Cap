import NextAuth from "next-auth";
import { authOptions } from "@cap/database/auth/auth-options";

const handler = NextAuth(authOptions);

console.log("handler", handler);

export { handler as GET, handler as POST };
