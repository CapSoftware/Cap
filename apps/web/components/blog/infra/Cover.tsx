import { HeroArt } from "@/components/pages/infra/Plain";

/**
 * The /infra hero scene, dust and all, used as the post's cover image. The
 * scene is sized for the landing hero, so it is pinned to the middle of the
 * cover and to its height here.
 */
export function InfraCover() {
	return (
		<div className="relative isolate left-1/2 mb-10 h-[220px] w-[min(calc(100vw-2.5rem),50rem)] -translate-x-1/2 sm:mb-12 sm:h-[400px] [&>div]:!left-1/2 [&>div]:!h-full">
			<HeroArt />
		</div>
	);
}
