import { Folder, Organisation, Space, Video } from "@cap/web-domain";
import { describe, expect, it } from "vitest";
import {
	buildMoveFolderDestinationRows,
	describeDraggedCaps,
	MAX_MOVE_ITEMS,
	moveLocationFolderSpaceId,
	parseCapDrag,
	parseFolderDrag,
	resolveMoveLocation,
	serializeCapDrag,
	serializeFolderDrag,
} from "@/lib/move-items";

const folderId = Folder.FolderId.make;

describe("move item helpers", () => {
	it("resolves personal, organization, and space locations", () => {
		const organizationId = Organisation.OrganisationId.make("org-1");

		expect(resolveMoveLocation(null, organizationId)).toEqual({
			type: "personal",
		});
		expect(resolveMoveLocation(organizationId, organizationId)).toEqual({
			type: "organization",
		});
		expect(
			resolveMoveLocation(Space.SpaceId.make("space-1"), organizationId),
		).toEqual({ type: "space", spaceId: "space-1" });
	});

	it("builds searchable paths and disables a folder and its descendants", () => {
		const rows = buildMoveFolderDestinationRows(
			[
				{ id: folderId("child"), name: "Child", parentId: folderId("root") },
				{ id: folderId("other"), name: "Other", parentId: null },
				{ id: folderId("root"), name: "Root", parentId: null },
				{
					id: folderId("grandchild"),
					name: "Grandchild",
					parentId: folderId("child"),
				},
			],
			folderId("child"),
		);

		expect(
			rows.map(({ id, path, depth, disabled }) => ({
				id,
				path,
				depth,
				disabled,
			})),
		).toEqual([
			{ id: "other", path: "Other", depth: 0, disabled: false },
			{ id: "root", path: "Root", depth: 0, disabled: false },
			{ id: "child", path: "Root / Child", depth: 1, disabled: true },
			{
				id: "grandchild",
				path: "Root / Child / Grandchild",
				depth: 2,
				disabled: true,
			},
		]);
	});

	it("handles invalid cycles without looping", () => {
		const rows = buildMoveFolderDestinationRows([
			{ id: folderId("one"), name: "One", parentId: folderId("two") },
			{ id: folderId("two"), name: "Two", parentId: folderId("one") },
		]);

		expect(rows).toHaveLength(2);
	});

	it("maps a move location to the space id new folders are created in", () => {
		const organizationId = Organisation.OrganisationId.make("org-1");
		expect(
			moveLocationFolderSpaceId({ type: "personal" }, organizationId),
		).toBe(null);
		expect(
			moveLocationFolderSpaceId({ type: "organization" }, organizationId),
		).toBe("org-1");
		expect(
			moveLocationFolderSpaceId(
				{ type: "space", spaceId: Space.SpaceId.make("space-1") },
				organizationId,
			),
		).toBe("space-1");
	});
});

describe("drag payloads", () => {
	const cap = { id: Video.VideoId.make("a"), name: "Demo" };

	it("drags the whole selection when the dragged Cap is part of it", () => {
		const selected = ["a", "b", "b", "c"].map((id) => Video.VideoId.make(id));
		const payload = parseCapDrag(serializeCapDrag(cap, selected));
		expect(payload).toEqual({ id: "a", name: "Demo", ids: ["a", "b", "c"] });
		expect(payload && describeDraggedCaps(payload)).toBe("3 Caps");
	});

	it("drags only the Cap itself when it is not selected", () => {
		const payload = parseCapDrag(
			serializeCapDrag(cap, [Video.VideoId.make("b")]),
		);
		expect(payload?.ids).toEqual(["a"]);
		expect(payload && describeDraggedCaps(payload)).toBe('"Demo"');
	});

	it("reads payloads written before multi-select dragging", () => {
		expect(parseCapDrag(JSON.stringify({ id: "a", name: "Demo" }))).toEqual({
			id: "a",
			name: "Demo",
			ids: ["a"],
		});
	});

	it("caps the number of dragged Caps at the move limit", () => {
		const selected = Array.from({ length: MAX_MOVE_ITEMS + 5 }, (_, index) =>
			Video.VideoId.make(index === 0 ? "a" : `v${index}`),
		);
		expect(parseCapDrag(serializeCapDrag(cap, selected))?.ids).toHaveLength(
			MAX_MOVE_ITEMS,
		);
	});

	it.each(["", "not json", "[]", "null", '{"name":"x"}', '{"id":3}'])(
		"ignores a malformed Cap payload %#",
		(raw) => {
			expect(parseCapDrag(raw)).toBeNull();
		},
	);

	it("round-trips a folder payload and rejects one without a location", () => {
		const payload = {
			id: folderId("f1"),
			name: "SEO",
			locationKey: "personal",
		};
		expect(parseFolderDrag(serializeFolderDrag(payload))).toEqual(payload);
		expect(parseFolderDrag(JSON.stringify({ id: "f1", name: "SEO" }))).toBe(
			null,
		);
	});
});
