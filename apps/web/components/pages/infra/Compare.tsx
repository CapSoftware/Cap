import { classNames } from "@cap/utils/helpers";
import { Fragment } from "react";
import { CompareRates } from "./CompareRates";
import {
	AS_OF,
	BUNNY_DOLLARS_PER_GB,
	ENCODING,
	EXAMPLE_MONTH,
	EXAMPLE_MONTH_BILLS,
	MUX_PAID_ENCODING_PER_1000_MINUTES,
	PROVIDERS,
	SOURCE_ORDER,
	SPEECH_PER_AUDIO_HOUR,
	SPEECH_SCALE_MAX,
} from "./comparison";
import { ANCHORS, TIER_LABEL, usd, usdRate, usdWhole } from "./content";
import { type RateRow, RateTable } from "./RateTable";
import { Actions, Section, SectionHeading } from "./shared";
import { TierSwitch } from "./TierSwitch";
import { MONO, TEXT_LINK } from "./theme";

const grouped = new Intl.NumberFormat("en-US");

const speechRows: readonly RateRow[] = SPEECH_PER_AUDIO_HOUR.map((row) => {
	const beyond = row.rate > SPEECH_SCALE_MAX;
	const text = usdRate(row.rate);
	return {
		key: `${row.provider}-${row.model ?? "all"}`,
		name: PROVIDERS[row.provider].name,
		detail: row.model,
		ours: row.provider === "cap",
		share: beyond ? 1 : row.rate / SPEECH_SCALE_MAX,
		beyond,
		figure: (
			<>
				{text}
				{text.length < 6 ? (
					<span aria-hidden="true" className="invisible">
						0
					</span>
				) : null}
			</>
		),
	};
});

const encodingRows: readonly RateRow[] = ENCODING.map((row) => ({
	key: row.provider,
	name: PROVIDERS[row.provider].name,
	ours: row.provider === "cap",
	aside: row.detail,
	figure: row.price,
}));

const beyondSpeechScale = SPEECH_PER_AUDIO_HOUR.find(
	(row) => row.rate > SPEECH_SCALE_MAX,
);

const NOTE =
	"m-0 text-pretty text-[12.5px] leading-[1.65] text-[rgba(232,236,244,0.42)]";

const SourceLink = ({ href, label }: { href: string; label: string }) => (
	<a
		href={href}
		target="_blank"
		rel="noreferrer"
		className={`${TEXT_LINK} text-[rgba(232,236,244,0.6)] hover:text-[#E8ECF4]`}
	>
		{label}
	</a>
);

export const Compare = () => (
	<Section id={ANCHORS.compare} className="pt-28 lg:pt-40">
		<div className="grid gap-x-16 gap-y-10 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)]">
			<SectionHeading title="The lowest price at every resolution.">
				<p>
					Storage, delivery and speech to text, against the published list price
					of every provider.
				</p>
			</SectionHeading>
			<figure className="m-0 min-w-0">
				<figcaption className="text-pretty text-[15px] leading-[1.5] text-[rgba(232,236,244,0.56)]">
					<span className="block leading-[inherit] text-[#E8ECF4]">
						One month of video at {TIER_LABEL[EXAMPLE_MONTH.tier]}
					</span>
					{grouped.format(EXAMPLE_MONTH.minutesStored)} minutes stored,{" "}
					{grouped.format(EXAMPLE_MONTH.minutesWatched)} minutes watched
				</figcaption>
				<dl className="m-0 mt-6 grid border-t border-[rgba(222,230,246,0.08)] sm:grid-cols-5 sm:pt-6">
					{EXAMPLE_MONTH_BILLS.map((bill) => {
						const ours = bill.provider === "cap";
						return (
							<div
								key={bill.provider}
								className="flex items-baseline justify-between gap-4 border-b border-[rgba(222,230,246,0.08)] py-3 sm:flex-col-reverse sm:items-start sm:justify-end sm:gap-2.5 sm:border-b-0 sm:border-l sm:py-0 sm:pl-4 sm:first:border-l-0 sm:first:pl-0"
							>
								<dt
									className={classNames(
										"text-[13.5px] leading-[1.3]",
										ours ? "text-[#E8ECF4]" : "text-[rgba(232,236,244,0.5)]",
									)}
								>
									{PROVIDERS[bill.provider].name}
								</dt>
								<dd
									className={classNames(
										MONO,
										"m-0 text-[17px] leading-none tracking-[-0.04em] tabular-nums sm:text-[clamp(20px,2.1vw,26px)]",
										ours ? "text-white" : "text-[rgba(232,236,244,0.46)]",
									)}
								>
									{usd(bill.total)}
								</dd>
							</div>
						);
					})}
				</dl>
				<p className={`${NOTE} mt-4 sm:mt-5`}>
					List rates, with no free allowances or credits applied.
				</p>
			</figure>
		</div>

		<div className="mt-16 flex flex-col gap-x-10 gap-y-5 sm:flex-row sm:items-center sm:justify-between lg:mt-24">
			<p className="m-0 max-w-[440px] text-pretty text-[13.5px] leading-[1.55] text-[rgba(232,236,244,0.46)]">
				Every rate, drawn to scale. Prices from each provider's public pricing
				page on {AS_OF}.
			</p>
			<TierSwitch label="Resolution to compare" className="shrink-0" />
		</div>

		<div className="mt-8 lg:mt-10">
			<CompareRates />
		</div>

		<div className="mt-14 grid gap-x-16 gap-y-14 lg:mt-16 lg:grid-cols-2">
			<RateTable
				wideNames
				title="Speech to text"
				unit="per hour of audio"
				rows={speechRows}
				scale={{ from: "$0", to: usdRate(SPEECH_SCALE_MAX) }}
				note={
					beyondSpeechScale
						? `${PROVIDERS[beyondSpeechScale.provider].name} lists ${usd(beyondSpeechScale.rate / 60)} per minute, which runs past this scale.`
						: undefined
				}
			/>
			<RateTable
				title="Encoding"
				unit="per 1,000 minutes"
				rows={encodingRows}
				note={`Mux charges ${usdWhole(MUX_PAID_ENCODING_PER_1000_MINUTES.from)} to ${usdWhole(MUX_PAID_ENCODING_PER_1000_MINUTES.to)} per 1,000 minutes on its higher quality levels.`}
			/>
		</div>

		<div className="mt-14 flex flex-col gap-x-10 gap-y-5 sm:flex-row sm:items-center sm:justify-between lg:mt-16">
			<p className="m-0 max-w-[440px] text-pretty text-[15.5px] leading-[1.55] text-[rgba(232,236,244,0.78)]">
				The lowest list price for storage, delivery and speech to text. Encoding
				is free.
			</p>
			<Actions
				className="shrink-0"
				secondary={{
					label: "Estimate your bill",
					href: `#${ANCHORS.pricing}`,
				}}
			/>
		</div>

		<div className="mt-12 grid gap-x-16 gap-y-4 border-t border-[rgba(222,230,246,0.08)] pt-6 lg:mt-14 lg:grid-cols-2">
			<div className="space-y-2">
				<p className={NOTE}>
					Mux and the others list further volume discounts. The tables show
					published list rates.
				</p>
				<p className={NOTE}>
					Sources:{" "}
					{SOURCE_ORDER.map((id, i) => {
						const provider = PROVIDERS[id];
						return (
							<Fragment key={id}>
								{i > 0 ? ", " : null}
								<SourceLink href={provider.source} label={provider.name} />
								{provider.references?.map((reference) => (
									<Fragment key={reference.href}>
										{", "}
										<SourceLink href={reference.href} label={reference.label} />
									</Fragment>
								))}
							</Fragment>
						);
					})}
					.
				</p>
			</div>
			<p className={NOTE}>
				* Bunny bills per gigabyte, not per minute. Its figures here are worked
				out from its published prices ({usd(BUNNY_DOLLARS_PER_GB.stored)} per GB
				stored, {usdRate(BUNNY_DOLLARS_PER_GB.deliveredVolume)} per GB delivered
				on its volume network, {usd(BUNNY_DOLLARS_PER_GB.deliveredStandard)} on
				its standard network) and its documented default encoding bitrates, with
				its default resolutions enabled. 1440p and 4K at Bunny need its paid
				premium encoding.
			</p>
		</div>
	</Section>
);
