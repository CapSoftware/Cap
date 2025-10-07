import { Folder, InternalError } from "@cap/web-domain";
import { Effect } from "effect";

import { Folders } from "./index.ts";

export const FolderRpcsLive = Folder.FolderRpcs.toLayer(
	Effect.gen(function* () {
		const folders = yield* Folders;

		return {
			FolderDelete: (folderId) =>
				folders
					.delete(folderId)
					.pipe(
						Effect.catchTag(
							"DatabaseError",
							() => new InternalError({ type: "database" }),
						),
					),

			FolderCreate: (data) =>
				folders
					.create(data)
					.pipe(
						Effect.catchTag(
							"DatabaseError",
							() => new InternalError({ type: "database" }),
						),
					),

			FolderUpdate: (data) =>
				folders
					.update(data.id, data)
					.pipe(
						Effect.catchTag(
							"DatabaseError",
							() => new InternalError({ type: "database" }),
						),
					),
		};
	}),
);
