import { RpcGroup } from "@effect/rpc";

import { FolderRpcs } from "./Folder.ts";
import { OrganisationRpcs } from "./Organisation.ts";
import { UserRpcs } from "./User.ts";
import { VideoRpcs } from "./Video.ts";

export const Rpcs = RpcGroup.make().merge(
	VideoRpcs,
	FolderRpcs,
	UserRpcs,
	OrganisationRpcs,
);
