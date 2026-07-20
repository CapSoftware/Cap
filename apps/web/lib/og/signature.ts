// HMAC signing for /api/og params. Metadata is always generated server-side
// (metadata consts / generateMetadata), so URLs carry a signature proving the
// text came from us — third parties can't render arbitrary copy on our
// branded endpoint. Unsigned/forged URLs fall back to the default image.

import { createHmac, timingSafeEqual } from "node:crypto";

export type SignableOgParams = {
	title: string;
	tag?: string;
	description?: string;
};

// Read directly from process.env (what serverEnv wraps) — signing must not
// throw when the full env isn't validated, e.g. in unit tests. Sign + verify
// only need to agree within a deployment.
const secret = () => process.env.NEXTAUTH_SECRET ?? "";

const payload = ({ title, tag, description }: SignableOgParams) =>
	[title, tag ?? "", description ?? ""].join("\n");

export const signOgParams = (params: SignableOgParams) =>
	createHmac("sha256", secret())
		.update(payload(params))
		.digest("hex")
		.slice(0, 32);

export const verifyOgSignature = (
	params: SignableOgParams,
	signature: string | null,
) => {
	if (!signature) return false;
	const expected = Buffer.from(signOgParams(params));
	const provided = Buffer.from(signature);
	return (
		expected.length === provided.length && timingSafeEqual(expected, provided)
	);
};
