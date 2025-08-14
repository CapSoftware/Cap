import { faMinus, faPlus } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import clsx from "clsx";
import { AnimatePresence, motion } from "framer-motion";
import { useState } from "react";
import { homepageCopy } from "../../../data/homepage-copy";

interface FaqItem {
	question: string;
	answer: string;
}

const Faq = () => {
	const [openIndex, setOpenIndex] = useState<number | null>(null);

	const toggleFaq = (index: number) => {
		setOpenIndex(openIndex === index ? null : index);
	};

	return (
		<div className="mx-auto max-w-[1000px] px-5">
			<h2 className="mb-10 text-4xl text-gray-12">{homepageCopy.faq.title}</h2>
			<div className="space-y-4">
				{homepageCopy.faq.items.map((item, index) => (
					<div
						key={index}
						className={clsx(
							"rounded-xl overflow-hidde border border-gray-5",
							openIndex === index
								? "bg-blue-500 text-white"
								: "bg-gray-1 hover:bg-gray-3 text-gray-12",
							"transition-colors duration-200",
						)}
					>
						<button
							className="flex justify-between items-center px-6 py-4 w-full text-left"
							onClick={() => toggleFaq(index)}
						>
							<p
								className={clsx(
									"text-lg font-medium",
									openIndex === index ? "text-gray-1" : "text-gray-12",
								)}
							>
								{item.question}
							</p>
							{openIndex === index ? (
								<FontAwesomeIcon
									icon={faMinus}
									className="flex-shrink-0 w-5 h-5 text-gray-1"
								/>
							) : (
								<FontAwesomeIcon
									icon={faPlus}
									className="flex-shrink-0 w-5 h-5"
								/>
							)}
						</button>

						<AnimatePresence>
							{openIndex === index && (
								<motion.div
									initial={{ height: 0, opacity: 0 }}
									animate={{ height: "auto", opacity: 1 }}
									exit={{ height: 0, opacity: 0 }}
									transition={{ duration: 0.3 }}
									className="overflow-hidden"
								>
									<p className="px-6 pb-4 text-gray-3">{item.answer}</p>
								</motion.div>
							)}
						</AnimatePresence>
					</div>
				))}
			</div>
		</div>
	);
};

export default Faq;
