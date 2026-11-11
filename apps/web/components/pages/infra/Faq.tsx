import Link from "next/link";
import { ANCHORS, infraFaqs, LINKS } from "./content";
import { Section, SectionHeading } from "./shared";
import { TEXT_LINK } from "./theme";

export const Faq = () => (
	<Section id={ANCHORS.faq} className="pt-24 lg:pt-32">
		<div className="grid gap-x-16 gap-y-8 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)]">
			<SectionHeading title="Questions">
				<p>
					The full reference is in the{" "}
					<Link href={LINKS.docs} className={TEXT_LINK}>
						docs
					</Link>
					.
				</p>
			</SectionHeading>
			<div>
				{infraFaqs.map((item) => (
					<details
						key={item.question}
						className="group border-b border-[rgba(222,230,246,0.08)] first:border-t"
					>
						<summary className="flex cursor-pointer list-none items-center justify-between gap-6 py-4 text-left text-[15px] text-[rgba(232,236,244,0.78)] transition-colors duration-200 hover:text-[#E8ECF4] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(232,236,244,0.7)] group-open:text-[#E8ECF4] [&::-webkit-details-marker]:hidden">
							{item.question}
							<span
								aria-hidden="true"
								className="relative grid size-4 shrink-0 place-items-center text-[rgba(232,236,244,0.5)] transition-colors duration-200 group-hover:text-[#E8ECF4]"
							>
								<span className="absolute h-px w-[11px] bg-current" />
								<span className="absolute h-[11px] w-px bg-current transition-transform duration-200 group-open:scale-y-0" />
							</span>
						</summary>
						<p className="m-0 max-w-[600px] pb-5 pr-10 text-pretty text-[14.5px] leading-[1.6] text-[rgba(232,236,244,0.56)]">
							{item.answer}
						</p>
					</details>
				))}
			</div>
		</div>
	</Section>
);
