import { getSafeNextPath } from "@/app/(org)/safe-next";

const CHECKOUT_SESSION_PLACEHOLDER = "{CHECKOUT_SESSION_ID}";

export const resolveCheckoutReturnUrls = (
	webUrl: string,
	returnPath: unknown,
) => {
	if (typeof returnPath !== "string" || returnPath.length === 0) return null;

	const base = webUrl.replace(/\/+$/, "");
	const path = getSafeNextPath(returnPath, base);
	const hashIndex = path.indexOf("#");
	const pathWithoutHash = hashIndex === -1 ? path : path.slice(0, hashIndex);
	const hash = hashIndex === -1 ? "" : path.slice(hashIndex);
	const separator = pathWithoutHash.includes("?") ? "&" : "?";

	return {
		successUrl: `${base}${pathWithoutHash}${separator}upgrade=true&session_id=${CHECKOUT_SESSION_PLACEHOLDER}${hash}`,
		cancelUrl: `${base}${path}`,
	};
};
