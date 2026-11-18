import { Logo } from "@cap/ui/logo";
import Image from "next/image";
import Link from "next/link";
import { testimonials } from "@/data/testimonials";
import { formatStarCount, getGitHubStars } from "@/utils/github";
import { CapFridayMark } from "./CapFridayMark";
import { Claim } from "./Claim";
import { CodeChip } from "./CodeChip";
import { Countdown } from "./Countdown";
import {
	ANCHORS,
	ENDS_LABEL,
	FAQ,
	FEATURES,
	RENEWAL_MAIL,
	TESTIMONIAL_NAMES,
} from "./content";
import { FeatureIcon } from "./FeatureIcon";
import { Film } from "./Film";
import { OfferCard } from "./OfferCard";
import { CARD, DIM, GHOST, SUN_TEXT } from "./theme";

const WRAP = "mx-auto w-full max-w-[1184px] px-5 sm:px-8";
const H2 =
	"text-balance text-[32px] font-medium leading-[1.05] tracking-[-0.03em] sm:text-[48px]";

const QUOTES = TESTIMONIAL_NAMES.map((name) =>
	testimonials.find((t) => t.name === name),
).filter((t) => t !== undefined);

function Header() {
	return (
		<header className="absolute inset-x-0 top-0 z-50">
			<div className={`${WRAP} flex h-16 items-center justify-between gap-4`}>
				<Link
					href="/"
					className="group -ml-2 inline-flex items-center gap-2 rounded-full py-1.5 pl-2 pr-3 text-[14px] text-[rgba(245,241,234,0.72)] transition-colors hover:text-[#F5F1EA] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#F5F1EA]"
				>
					<svg
						viewBox="0 0 16 16"
						aria-hidden="true"
						className="size-3.5 transition-transform duration-200 group-hover:-translate-x-0.5 motion-reduce:transition-none"
					>
						<path
							d="M9.75 3.75 5.5 8l4.25 4.25"
							fill="none"
							stroke="currentColor"
							strokeWidth="1.6"
							strokeLinecap="round"
							strokeLinejoin="round"
						/>
					</svg>
					<Logo white className="h-auto w-[78px]" />
					<span className="sr-only">Back to the Cap homepage</span>
				</Link>
				<Claim location="header" small />
			</div>
		</header>
	);
}

function Hero() {
	return (
		<section className="relative isolate overflow-hidden pb-16 pt-28 sm:pb-24 sm:pt-36">
			<div
				aria-hidden="true"
				className="absolute inset-x-0 top-0 -z-10 h-[720px] bg-[radial-gradient(60%_55%_at_50%_0%,rgba(255,111,142,0.22),rgba(255,179,107,0.08)_45%,rgba(10,10,11,0)_75%)]"
			/>
			<div className={`${WRAP} flex flex-col items-center text-center`}>
				<CapFridayMark className="w-[min(82vw,560px)] animate-bf-write [filter:drop-shadow(0_0_18px_rgba(255,77,141,0.4))] motion-reduce:animate-none" />
				<h1 className="mt-5 text-balance text-[40px] font-medium leading-[1] tracking-[-0.035em] sm:text-[68px]">
					50% off Cap Pro Yearly
				</h1>
				<p
					className={`mt-5 max-w-[520px] text-balance text-[17px] leading-[1.5] sm:text-[19px] ${DIM}`}
				>
					Record, share and get AI notes on every video, at half the yearly
					price.
				</p>
				<Claim location="hero" className="mt-8" />
				<p className={`mt-4 text-balance text-[14px] ${DIM}`}>
					Code <CodeChip location="hero" /> is applied at checkout.{" "}
					<Countdown />.
				</p>
			</div>
			<div className={`${WRAP} mt-12 sm:mt-16`}>
				<Film />
			</div>
		</section>
	);
}

async function Loved() {
	const stars = formatStarCount(await getGitHubStars());
	return (
		<section className="py-16 sm:py-24">
			<div className={WRAP}>
				<div className="mx-auto max-w-[640px] text-center">
					<h2 className={H2}>Loved by people who record a lot</h2>
					<p className={`mt-4 text-[17px] ${DIM}`}>
						Open source, with {stars} stars on GitHub.
					</p>
				</div>
				<div className="mt-12 columns-1 gap-4 sm:columns-2 lg:columns-3">
					{QUOTES.map((quote, index) => (
						<figure
							key={quote.name}
							className={`${CARD} mb-4 break-inside-avoid p-6 ${index >= 3 ? "hidden sm:block" : ""}`}
						>
							<blockquote className="text-[16px] leading-[1.6] text-[rgba(245,241,234,0.88)]">
								{quote.content}
							</blockquote>
							<figcaption className="mt-5 flex items-center gap-3">
								<Image
									src={quote.image}
									alt=""
									width={36}
									height={36}
									className="size-9 rounded-full object-cover"
								/>
								<span className="flex flex-col text-[14px] leading-tight">
									<span className="font-medium">{quote.name}</span>
									<span className={DIM}>{quote.handle}</span>
								</span>
							</figcaption>
						</figure>
					))}
				</div>
			</div>
		</section>
	);
}

function Features() {
	return (
		<section className="relative isolate py-16 sm:py-24">
			<div className={WRAP}>
				<div className="mx-auto max-w-[680px] text-center">
					<h2 className={H2}>
						Everything in Cap Pro, <span className={SUN_TEXT}>half price</span>
					</h2>
					<p className={`mt-4 text-[17px] leading-[1.55] ${DIM}`}>
						A fast, native screen recorder for Mac and Windows, with the cloud,
						AI and team tools to share what you record.
					</p>
				</div>
				<div className="relative mt-12">
					<div
						aria-hidden="true"
						className="absolute inset-x-[8%] -bottom-6 top-[20%] -z-10 bg-[radial-gradient(50%_50%_at_50%_50%,rgba(255,111,142,0.28),rgba(10,10,11,0))]"
					/>
					<Image
						src="/illustrations/app.webp"
						alt="The Cap editor with a recording, background presets and zoom segments on the timeline"
						width={2108}
						height={1284}
						sizes="(min-width: 1184px) 1120px, 100vw"
						className="h-auto w-full rounded-[14px] shadow-[0_0_0_1px_rgba(245,241,234,0.1),0_30px_80px_-30px_rgba(0,0,0,0.9)] sm:rounded-[20px]"
					/>
				</div>
				<div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
					{FEATURES.map((feature) => (
						<div
							key={feature.title}
							className={`${CARD} flex items-start gap-4 p-5 sm:block sm:p-6`}
						>
							<span className="grid size-10 shrink-0 place-items-center rounded-[12px] bg-[linear-gradient(135deg,rgba(255,179,107,0.18),rgba(194,75,179,0.18))] text-[#FFB59A] shadow-[inset_0_0_0_1px_rgba(255,179,107,0.2)]">
								<FeatureIcon name={feature.icon} />
							</span>
							<div>
								<h3 className="text-[17px] font-medium tracking-[-0.01em] sm:mt-5 sm:text-[18px]">
									{feature.title}
								</h3>
								<p
									className={`mt-1.5 text-[15px] leading-[1.55] sm:mt-2 ${DIM}`}
								>
									{feature.body}
								</p>
							</div>
						</div>
					))}
				</div>
			</div>
		</section>
	);
}

function Offer() {
	return (
		<section id={ANCHORS.offer} className="scroll-mt-8 py-16 sm:py-24">
			<div className={WRAP}>
				<OfferCard />
			</div>
		</section>
	);
}

function Renewal() {
	return (
		<section className="py-12 sm:py-20">
			<div className={`${WRAP} text-center`}>
				<h2 className={H2}>Already on Cap Pro Yearly?</h2>
				<p
					className={`mx-auto mt-4 max-w-[560px] text-balance text-[17px] leading-[1.55] ${DIM}`}
				>
					Lock in another year at the discounted price. Email us before{" "}
					{ENDS_LABEL} and we'll add it to your account.
				</p>
				<a href={RENEWAL_MAIL} className={`${GHOST} mt-8`}>
					Email us to lock it in
				</a>
			</div>
		</section>
	);
}

function Faq() {
	return (
		<section id={ANCHORS.faq} className="scroll-mt-8 py-16 sm:py-24">
			<div className={`${WRAP} max-w-[820px]`}>
				<h2 className={`${H2} text-center`}>Questions</h2>
				<div className="mt-10 divide-y divide-[rgba(245,241,234,0.1)] border-y border-[rgba(245,241,234,0.1)]">
					{FAQ.map((item) => (
						<details key={item.question} className="group py-5">
							<summary className="flex cursor-pointer list-none items-center justify-between gap-6 text-[17px] [&::-webkit-details-marker]:hidden">
								{item.question}
								<svg
									viewBox="0 0 16 16"
									aria-hidden="true"
									className="size-4 shrink-0 text-[rgba(245,241,234,0.64)] transition-transform duration-200 group-open:rotate-45 motion-reduce:transition-none"
								>
									<path
										d="M8 3v10M3 8h10"
										stroke="currentColor"
										strokeWidth="1.5"
										strokeLinecap="round"
									/>
								</svg>
							</summary>
							<p
								className={`mt-3 max-w-[680px] text-[16px] leading-[1.6] ${DIM}`}
							>
								{item.answer}
							</p>
						</details>
					))}
				</div>
			</div>
		</section>
	);
}

function Closing() {
	return (
		<section className="relative isolate overflow-hidden pb-24 pt-12 sm:pb-32">
			<div
				aria-hidden="true"
				className="absolute inset-x-0 bottom-0 -z-10 h-[80%] bg-[radial-gradient(55%_60%_at_50%_100%,rgba(255,111,142,0.2),rgba(10,10,11,0))]"
			/>
			<div className={`${WRAP} flex flex-col items-center text-center`}>
				<CapFridayMark className="w-[min(70vw,380px)] [filter:drop-shadow(0_0_14px_rgba(255,77,141,0.4))]" />
				<p className="mt-4 text-[28px] font-medium tracking-[-0.025em] sm:text-[36px]">
					50% off Cap Pro Yearly
				</p>
				<Claim location="closing" className="mt-8" />
			</div>
		</section>
	);
}

function Footer() {
	return (
		<footer className="border-t border-[rgba(245,241,234,0.08)] py-10">
			<div
				className={`${WRAP} flex flex-col items-center justify-between gap-6 sm:flex-row`}
			>
				<Link
					href="/"
					aria-label="Cap home"
					className="rounded-[6px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#F5F1EA]"
				>
					<Logo white className="h-auto w-[78px] opacity-80" />
				</Link>
				<nav
					aria-label="Footer"
					className={`flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-[14px] ${DIM}`}
				>
					{[
						["Home", "/"],
						["Pricing", "/pricing"],
						["Download", "/download"],
						["Terms", "/terms"],
						["Privacy", "/privacy"],
					].map(([label, href]) => (
						<Link key={href} href={href} className="hover:text-[#F5F1EA]">
							{label}
						</Link>
					))}
				</nav>
			</div>
		</footer>
	);
}

export function BlackFridayPage() {
	return (
		<div className="relative min-h-screen overflow-x-clip bg-[#0A0A0B] text-[#F5F1EA] antialiased [color-scheme:dark]">
			<style>{"html,body{background:#0A0A0B}"}</style>
			<Header />
			<div>
				<Hero />
				<Loved />
				<Features />
				<Offer />
				<Renewal />
				<Faq />
				<Closing />
			</div>
			<Footer />
		</div>
	);
}
