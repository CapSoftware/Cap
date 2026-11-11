import Link from "next/link";
import { ANCHORS, infraFaqs, LINKS } from "./content";
import { Section, SectionHeading } from "./shared";
import { BODY } from "./theme";

export const Faq = () => (
	<Section id={ANCHORS.faq}>
		<div className="grid gap-12 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)] lg:gap-20">
			<div className="lg:sticky lg:top-28 lg:self-start">
				<SectionHeading title="Questions">
					<p className="m-0">
						The full reference lives in the{" "}
						<Link
							href={LINKS.docs}
							className="underline decoration-[rgba(236,232,225,0.3)] underline-offset-[5px] transition-colors duration-200 hover:decoration-[#ECE8E1]"
						>
							docs
						</Link>
						.
					</p>
				</SectionHeading>
			</div>
			<div>
				{infraFaqs.map((item) => (
					<details
						key={item.question}
						className="group border-t border-[rgba(236,232,225,0.09)] last:border-b"
					>
						<summary className="flex cursor-pointer list-none items-center justify-between gap-6 py-6 text-left text-[17px] font-normal tracking-[-0.02em] text-[rgba(236,232,225,0.72)] transition-colors duration-200 hover:text-[#ECE8E1] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#ECE8E1] group-open:text-[#ECE8E1] lg:text-[19px] [&::-webkit-details-marker]:hidden">
							{item.question}
							<span
								aria-hidden="true"
								className="relative grid size-8 shrink-0 place-items-center rounded-full bg-[rgba(236,232,225,0.06)] shadow-[inset_0_0_0_1px_rgba(236,232,225,0.1)] transition-colors duration-200 group-hover:bg-[rgba(236,232,225,0.1)]"
							>
								<span className="absolute h-[1.5px] w-3 rounded-full bg-[#ECE8E1]" />
								<span className="absolute h-3 w-[1.5px] rounded-full bg-[#ECE8E1] transition-transform duration-200 group-open:scale-y-0" />
							</span>
						</summary>
						<p
							className={`${BODY} max-w-[640px] pb-7 pr-10 text-[15.5px] leading-[1.6] `}
						>
							{item.answer}
						</p>
					</details>
				))}
			</div>
		</div>
	</Section>
);
