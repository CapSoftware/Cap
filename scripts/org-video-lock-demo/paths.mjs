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
};
export const directory = join(tmpdir(), `cap-${session}`);
export const origin = `http://127.0.0.1:${process.env.PORT}`;
