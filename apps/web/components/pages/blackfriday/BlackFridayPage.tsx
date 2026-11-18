import { Logo } from "@cap/ui/logo";
import localFont from "next/font/local";
import Image from "next/image";
import Link from "next/link";
import { Claim } from "./Claim";
import { CodeChip } from "./CodeChip";
import { Countdown } from "./Countdown";
import { ANCHORS, ENDS_LABEL, FAQ, RENEWAL_MAIL } from "./content";
import { Film, WatchFilm } from "./Film";
import { OfferCard } from "./OfferCard";
import { DIM, GHOST, GRAIN, NEON, SUN_TEXT } from "./theme";

// A retro Miami script for the title (Yellowtail, Apache 2.0).
const script = localFont({
	src: "../../../public/fonts/Yellowtail-Regular.ttf",
	display: "swap",
	preload: true,
});

const WRAP = "mx-auto w-full max-w-[1184px] px-5 sm:px-8";

const Grain = ({ className = "" }: { className?: string }) => (
	<div
		aria-hidden="true"
		className={`pointer-events-none absolute inset-0 bg-[length:160px_160px] opacity-[0.11] mix-blend-overlay ${className}`}
		style={{ backgroundImage: GRAIN }}
	/>
);

const Title = ({ className }: { className: string }) => (
	<span className={`${script.className} ${NEON} ${className}`}>Cap Friday</span>
);

function Header() {
	return (
		<header className="fixed inset-x-0 top-0 z-50 bg-[linear-gradient(180deg,rgba(10,10,11,0.55),rgba(10,10,11,0))]">
			<div className={`${WRAP} flex h-16 items-center justify-between gap-4`}>
				<Link
					href="/"
					aria-label="Cap home"
					className="rounded-[6px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#F5F1EA]"
				>
					<Logo white className="h-auto w-[92px]" />
				</Link>
				<Claim location="header" small />
			</div>
		</header>
	);
}

function Hero() {
	return (
		<section className="relative isolate flex min-h-[100svh] flex-col justify-end overflow-hidden">
			{/* On phones the wide frame sits as a band at the top (plane and banner
			    both in shot) with the copy below it on dark; wider screens get
			    the full-bleed picture with a soft wash behind the copy. */}
			<div
				aria-hidden="true"
				className="absolute inset-x-0 top-0 -z-10 h-[62svh] overflow-hidden sm:inset-0 sm:h-auto"
			>
				<Image
					src="/blackfriday/hero.webp"
					alt=""
					fill
					fetchPriority="high"
					sizes="100vw"
					className="size-full origin-[70%_20%] object-cover object-[33%_20%] animate-bf-drift motion-reduce:animate-none sm:object-[62%_18%]"
				/>
				<div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(10,10,11,0.5)_0%,rgba(10,10,11,0)_16%),linear-gradient(180deg,rgba(10,10,11,0)_40%,#0A0A0B_100%)] sm:bg-[linear-gradient(180deg,rgba(10,10,11,0.5)_0%,rgba(10,10,11,0)_16%),linear-gradient(180deg,rgba(10,10,11,0)_34%,rgba(10,10,11,0.62)_62%,#0A0A0B_100%)]" />
				<div className="absolute inset-0 hidden bg-[radial-gradient(ellipse_52%_40%_at_50%_72%,rgba(10,10,11,0.55),rgba(10,10,11,0))] sm:block" />
				<Grain />
			</div>

			<div className={`${WRAP} pb-14 pt-[40svh] text-center sm:pb-20 sm:pt-40`}>
				<h1 className="flex flex-col items-center">
					<Title className="text-[clamp(76px,13vw,184px)]" />
					<span className="mt-1 text-[clamp(30px,4.4vw,56px)] font-medium leading-[1.02] tracking-[-0.03em] text-[#F5F1EA] animate-bf-rise [animation-delay:1.1s] motion-reduce:animate-none">
						50% off Cap Pro Yearly
					</span>
				</h1>
				<div className="animate-bf-rise [animation-delay:1.35s] motion-reduce:animate-none">
					<div className="mt-9 flex flex-col items-center justify-center gap-2 sm:flex-row sm:gap-4">
						<Claim location="hero" />
						<WatchFilm />
					</div>
					<p
						className={`mx-auto mt-5 max-w-[320px] text-balance text-[14px] sm:max-w-none ${DIM}`}
					>
						Code <CodeChip location="hero" /> is applied at checkout.{" "}
						<Countdown />.
					</p>
				</div>
			</div>
		</section>
	);
}

function FilmSection() {
	return (
		<section id={ANCHORS.film} className="relative scroll-mt-20 py-16 sm:py-24">
			<div className={WRAP}>
				<div className="mb-8 flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-end">
					<h2 className="text-[30px] font-medium leading-[1.05] tracking-[-0.025em] sm:text-[40px]">
						A plane, a banner, <span className={SUN_TEXT}>half off</span>.
					</h2>
					<p className={`text-[15px] ${DIM}`}>
						Streaming from Cap Infra, our video API.
					</p>
				</div>
				<Film />
			</div>
		</section>
	);
}

function OfferSection() {
	return (
		<section
			id={ANCHORS.offer}
			className="relative isolate scroll-mt-16 overflow-hidden py-20 sm:py-28"
		>
			<div aria-hidden="true" className="absolute inset-0 -z-10">
				<Image
					src="/blackfriday/hero.webp"
					alt=""
					fill
					sizes="100vw"
					className="size-full object-cover object-[50%_70%] [filter:grayscale(1)_contrast(1.15)_brightness(0.32)]"
				/>
				<div className="absolute inset-0 bg-[radial-gradient(ellipse_at_50%_40%,rgba(10,10,11,0)_0%,rgba(10,10,11,0.72)_78%),linear-gradient(180deg,#0A0A0B_0%,rgba(10,10,11,0)_18%,rgba(10,10,11,0)_80%,#0A0A0B_100%)]" />
				<Grain className="opacity-[0.16]" />
			</div>
			<div className={WRAP}>
				<OfferCard />
			</div>
		</section>
	);
}

function Renewal() {
	return (
		<section className="py-20 sm:py-28">
			<div className={`${WRAP} text-center`}>
				<h2 className="mx-auto max-w-[760px] text-[30px] font-medium leading-[1.1] tracking-[-0.025em] sm:text-[44px]">
					Already on Cap Pro Yearly?
				</h2>
				<p
					className={`mx-auto mt-4 max-w-[560px] text-[17px] leading-[1.55] sm:text-[19px] ${DIM}`}
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
		<section id={ANCHORS.faq} className="scroll-mt-16 pb-20 sm:pb-28">
			<div className={`${WRAP} max-w-[860px]`}>
				<h2 className="text-[28px] font-medium tracking-[-0.025em] sm:text-[36px]">
					Questions
				</h2>
				<div className="mt-6 divide-y divide-[rgba(245,241,234,0.1)] border-y border-[rgba(245,241,234,0.1)]">
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
		<section className="relative isolate overflow-hidden pb-24 pt-10 sm:pb-32">
			<div
				aria-hidden="true"
				className="absolute inset-x-0 bottom-0 -z-10 h-[70%] bg-[radial-gradient(ellipse_at_50%_100%,rgba(255,77,141,0.16),rgba(10,10,11,0)_65%)]"
			/>
			<div className={`${WRAP} flex flex-col items-center text-center`}>
				<Title className="text-[clamp(64px,9vw,128px)]" />
				<p className="mt-2 text-[26px] font-medium tracking-[-0.02em] sm:text-[34px]">
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
				<Logo white className="h-auto w-[84px] opacity-80" />
				<nav
					aria-label="Footer"
					className={`flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-[14px] ${DIM}`}
				>
					<Link href="/pricing" className="hover:text-[#F5F1EA]">
						Pricing
					</Link>
					<Link href="/download" className="hover:text-[#F5F1EA]">
						Download
					</Link>
					<Link href="/infra" className="hover:text-[#F5F1EA]">
						Cap Infra
					</Link>
					<Link href="/terms" className="hover:text-[#F5F1EA]">
						Terms
					</Link>
					<Link href="/privacy" className="hover:text-[#F5F1EA]">
						Privacy
					</Link>
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
			<Hero />
			<FilmSection />
			<OfferSection />
			<Renewal />
			<Faq />
			<Closing />
			<Footer />
		</div>
	);
}
