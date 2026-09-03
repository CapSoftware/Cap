import { classNames } from "@cap/utils/helpers";
import Image from "next/image";
import Link from "next/link";
import { testimonials } from "@/data/testimonials";
import { Eyebrow } from "./Eyebrow";
import { BODY_TEXT, BTN_SECONDARY, H_SECTION, MODE_THEME } from "./theme";

/**
 * The homepage's wall of quotes, straightened out: real cards in a masonry
 * column instead of a rotated scatter, so the type stays on the same grid as
 * the rest of the page. Steven Tey is deliberately absent, he leads the
 * ownership section above.
 */

const PICKS = [
	"Olivia",
	"CJ",
	"evening kid",
	"Roger Mattos",
	"Greg_Ld",
	"Rohith Gilla",
	"Hrushi",
	"Bilal Budhani",
	"diana",
];

const QUOTES = PICKS.map((name) =>
	testimonials.find((item) => item.name === name),
).filter((item): item is (typeof testimonials)[number] => Boolean(item));

export const Testimonials = () => (
	<section className="px-5 py-20 lg:py-28">
		<div className="mx-auto max-w-[1200px]">
			<div className="mx-auto flex max-w-[760px] flex-col items-center text-center">
				<Eyebrow accent={MODE_THEME.share.accent}>Testimonials</Eyebrow>
				<h2
					className={`${H_SECTION} mt-6 text-balance text-[clamp(38px,5vw,56px)]`}
				>
					Loved by builders, trusted by teams
				</h2>
				<p
					className={`${BODY_TEXT} mt-6 max-w-[440px] text-balance text-[16.5px] leading-[1.5] text-[rgba(17,17,17,0.78)] sm:text-[17.5px]`}
				>
					Join the thousands who made Cap their daily driver for showing work
					instead of writing about it.
				</p>
			</div>

			<div className="mt-14 gap-4 sm:columns-2 lg:columns-3">
				{QUOTES.map((quote) => (
					<a
						key={quote.name}
						href={quote.url}
						target="_blank"
						rel="noopener noreferrer"
						className="mb-4 block break-inside-avoid rounded-[14px] bg-white p-6 shadow-[0_0_0_1px_rgba(17,17,17,0.05)] transition-shadow duration-200 hover:shadow-[0_0_0_1px_rgba(17,17,17,0.12),0_14px_30px_-18px_rgba(17,17,17,0.35)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#111111]"
					>
						<p
							className={`${BODY_TEXT} whitespace-pre-line text-[15.5px] leading-[1.55] text-[rgba(17,17,17,0.82)]`}
						>
							{quote.content}
						</p>
						<span className="mt-5 flex items-center gap-3">
							<Image
								src={quote.image}
								alt=""
								width={36}
								height={36}
								className="size-9 rounded-full object-cover"
							/>
							<span className="min-w-0">
								<span className="block truncate text-[14px] font-medium text-[#111111]">
									{quote.name}
								</span>
								<span className="block truncate text-[13px] text-[rgba(17,17,17,0.5)]">
									{quote.handle}
								</span>
							</span>
						</span>
					</a>
				))}
			</div>

			<div className="mt-6 flex justify-center">
				<Link href="/testimonials" className={classNames(BTN_SECONDARY)}>
					Read more testimonials
				</Link>
			</div>
		</div>
	</section>
);
