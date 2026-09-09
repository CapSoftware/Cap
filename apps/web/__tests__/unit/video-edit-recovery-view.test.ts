import { Video } from "@cap/web-domain";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({}) }));
vi.mock("@/actions/videos/save-edits", () => ({
	restoreVideoToOriginal: vi.fn(),
}));

import { EditRecovery } from "@/app/s/[videoId]/edit/edit-recovery";

const videoId = Video.VideoId.make("video");
describe("edit recovery controls", () => {
	it("offers only the recording link while restoration is unavailable", () => {
		const html = renderToStaticMarkup(
			createElement(EditRecovery, { videoId, canRestore: false }),
		);
		expect(html).not.toContain("<button");
		expect(html).not.toContain("Restore original");
		expect(html).toContain('href="/s/video"');
	});
	it("offers restoration for an eligible legacy edit", () => {
		const html = renderToStaticMarkup(
			createElement(EditRecovery, { videoId, canRestore: true }),
		);
		expect(html).toContain("<button");
		expect(html).toContain("Restore original");
	});
});
