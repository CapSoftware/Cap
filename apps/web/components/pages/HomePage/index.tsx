import { STRIPE_PLAN_IDS } from "@cap/utils";
import {
	DeferredHomepageClosingSections,
	DeferredHomepageSections,
} from "./DeferredHomepageSections";
import Faq from "./Faq";
import Header from "./Header";
import { HomePageSchema } from "./HomePageSchema";

interface HomePageProps {
	serverHomepageCopyVariant?: string;
}

export function HomePage({ serverHomepageCopyVariant = "" }: HomePageProps) {
	const plans =
		process.env.VERCEL_ENV === "production"
			? STRIPE_PLAN_IDS.production
			: STRIPE_PLAN_IDS.development;

	return (
		<>
			<HomePageSchema />
			<Header serverHomepageCopyVariant={serverHomepageCopyVariant} />
			<DeferredHomepageSections plans={plans} />
			<div className="mt-20 sm:mt-[120px] lg:mt-[180px]">
				<Faq />
			</div>
			<DeferredHomepageClosingSections />
		</>
	);
}
