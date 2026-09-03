import { homepageCopy } from "@/data/homepage-copy";
import { Eyebrow } from "./Eyebrow";
import { BODY_TEXT, H_SECTION, MODE_THEME } from "./theme";

/**
 * The homepage FAQ, same questions and answers, rebuilt as hairline rows with
 * a plus that turns into a minus. Plain `details` elements, so it opens with
 * no JavaScript and stays keyboard native.
 */
export const Faq = () => (
	<section className="px-5 py-20 lg:py-28">
		<div className="mx-auto grid max-w-[1100px] gap-12 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)] lg:gap-20">
			<div className="lg:sticky lg:top-28 lg:self-start">
				<Eyebrow accent={MODE_THEME.screenshot.accent}>FAQ</Eyebrow>
				<h2
					className={`${H_SECTION} mt-6 text-balance text-[clamp(34px,3.9vw,48px)]`}
				>
					Questions? We've got answers.
				</h2>
				<p
					className={`${BODY_TEXT} mt-5 max-w-[320px] text-[16px] leading-[1.5] text-[rgba(17,17,17,0.72)]`}
				>
					Still stuck? Mail{" "}
					<a
						href="mailto:hello@cap.so"
						className="underline decoration-[rgba(17,17,17,0.3)] underline-offset-[5px] transition-colors duration-200 hover:decoration-[#111111]"
					>
						hello@cap.so
					</a>{" "}
					and a human answers.
				</p>
			</div>

			<div>
				{homepageCopy.faq.items.map((item) => (
					<details
						key={item.question}
						className="group border-t border-[#E1E7EE] last:border-b"
					>
						<summary className="flex cursor-pointer list-none items-center justify-between gap-6 py-6 text-left text-[17px] font-normal tracking-[-0.02em] text-[rgba(17,17,17,0.75)] transition-colors duration-200 hover:text-[#111111] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#111111] group-open:text-[#111111] lg:text-[19px] [&::-webkit-details-marker]:hidden">
							{item.question}
							<span
								aria-hidden="true"
								className="relative grid size-8 shrink-0 place-items-center rounded-full bg-[#E7EDF3] transition-colors duration-200 group-hover:bg-[#DCE4EC]"
							>
								<span className="absolute h-[1.5px] w-3 rounded-full bg-[#111111]" />
								<span className="absolute h-3 w-[1.5px] rounded-full bg-[#111111] transition-transform duration-200 group-open:scale-y-0" />
							</span>
						</summary>
						<p
							className={`${BODY_TEXT} max-w-[640px] pb-7 pr-10 text-[15.5px] leading-[1.6] text-[rgba(17,17,17,0.72)]`}
						>
							{item.answer}
						</p>
					</details>
				))}
			</div>
		</div>
	</section>
);
