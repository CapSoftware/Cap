import { Effect } from "effect";
import { Policy, Video } from "@cap/web-domain";

import { VideosPolicy } from "./VideosPolicy";
import { VideosRepo } from "./VideosRepo";

export class Videos extends Effect.Service<Videos>()("Videos", {
  accessors: true,
  effect: Effect.gen(function* () {
    const [repo, policy] = yield* Effect.all([VideosRepo, VideosPolicy]);

    return {
      /*
       * Get a video by ID. Will fail if the user does not have access.
       */
      getById: (id: Video.VideoId) =>
        repo
          .getById(id)
          .pipe(
            Policy.withPublicPolicy(policy.canView(id)),
            Effect.withSpan("Videos.getById")
          ),
    };
  }),
  dependencies: [VideosPolicy.Default, VideosRepo.Default],
}) {}
