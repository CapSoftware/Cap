import { RpcGroup } from "@effect/rpc";

import { FolderRpcs } from "./Folder";
import { VideoRpcs } from "./Video";

export const Rpcs = RpcGroup.make().merge(VideoRpcs, FolderRpcs);
