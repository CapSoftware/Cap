import { InternalError, Folder } from "@cap/web-domain";
import { Effect } from "effect";

import { Folders } from ".";

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
              () => new InternalError({ type: "database" })
            )
          ),
    };
  })
);
