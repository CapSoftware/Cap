import { RpcGroup } from "@effect/rpc";

import { AppsRpcs } from "./Apps.ts";
import { FolderRpcs } from "./Folder.ts";
import { VideoRpcs } from "./Video.ts";

export const Rpcs = RpcGroup.make().merge(VideoRpcs, FolderRpcs, AppsRpcs);
