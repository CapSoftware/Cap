import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

const session = process.env.CAP_BUILDING_SESSION;
if (!session?.startsWith("org-video-lock-")) {
	throw new Error("This walkthrough requires its isolated building session");
}

const id = (name) =>
	createHash("sha256").update(`${session}:${name}`).digest("hex").slice(0, 15);

export const ids = {
	owner: id("user"),
	organization: id("organization"),
	member: id("demo-member"),
	outsider: id("demo-outsider"),
	outsideOrganization: id("demo-outside-org"),
	publicVideo: id("demo-public-video"),
	privateVideo: id("demo-private-video"),
	publicSpace: id("demo-public-space"),
	protectedSpace: id("demo-protected-space"),
	domainOrganization: id("demo-domain-organization"),
	domainMembership: id("demo-domain-membership"),
	domainSpace: id("demo-domain-space"),
	externalVideo: id("demo-external-video"),
	externalPrivateVideo: id("demo-external-private-video"),
	externalPasswordVideo: id("demo-external-password-video"),
	emailOrganization: id("demo-email-organization"),
	emailRestrictedVideo: id("demo-email-restricted-video"),
	emailGrantedVideo: id("demo-email-granted-video"),
};
export const directory = join(tmpdir(), `cap-${session}`);
export const origin = `http://127.0.0.1:${process.env.PORT}`;
