import { createHmac } from "node:crypto";

const getSecret = () => {
	const s = process.env.NEXTAUTH_SECRET;
	if (!s) throw new Error("NEXTAUTH_SECRET is required for folder share signing");
	return s;
};

const sign = (folderId: string) => {
	return createHmac("sha256", getSecret())
		.update(`folder-share:${folderId}`)
		.digest("base64url")
		.slice(0, 16);
};

const toBase64Url = (s: string) =>
	Buffer.from(s, "utf8").toString("base64url");

const fromBase64Url = (s: string) =>
	Buffer.from(s, "base64url").toString("utf8");

export const signFolderShareSlug = (folderId: string): string => {
	return `${toBase64Url(folderId)}.${sign(folderId)}`;
};

export const verifyFolderShareSlug = (slug: string): string | null => {
	const parts = slug.split(".");
	if (parts.length !== 2) return null;
	const [encodedId, sig] = parts;
	if (!encodedId || !sig) return null;
	let folderId: string;
	try {
		folderId = fromBase64Url(encodedId);
	} catch {
		return null;
	}
	if (sign(folderId) !== sig) return null;
	return folderId;
};
