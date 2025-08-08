import { Context, Effect, Option } from "effect";
import { Policy, Video } from "@cap/web-domain";
import { VideosRepo } from "./VideosRepo";

export class VideosPolicy extends Effect.Service<VideosPolicy>()(
  "VideosPolicy",
  {
    effect: Effect.gen(function* () {
      const videosRepo = yield* VideosRepo;

      const canView = (id: Video.VideoId) =>
        Policy.publicPolicy(
          Effect.fn(function* (user) {
            const video = yield* videosRepo.getById(id);

            if (Option.isNone(video)) return true;

            if (
              user.pipe(
                Option.filter((user) => user.id === video.value.ownerId),
                Option.isSome
              )
            )
              return true;

            yield* Video.verifyPassword(video.value);

            return true;
          })
        );

      return { canView };
    }),
    dependencies: [VideosRepo.Default],
  }
) {}
