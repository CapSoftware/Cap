import { authOptions } from "@cap/database/auth/auth-options";
import NextAuth from "next-auth";
import { recordWebAuthenticationSuccess } from "@/lib/analytics/authentication-events";

export const dynamic = "force-dynamic";

const options = authOptions();
options.events = {
	...options.events,
	signIn: ({ user }) => recordWebAuthenticationSuccess(user.id),
};
const handler = NextAuth(options);

export { handler as GET, handler as POST };
