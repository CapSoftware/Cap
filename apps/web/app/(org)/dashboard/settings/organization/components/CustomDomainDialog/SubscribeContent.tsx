import { motion } from "motion/react";

const capsDomainText = "caps.yourdomain.com";
const capsDomainLetters = capsDomainText
	.split("")
	.reduce<{ delay: number; key: string; letter: string }[]>(
		(letters, letter) => {
			const occurrence = letters.filter(
				(item) => item.letter === letter,
			).length;

			letters.push({
				delay: 0.9 + letters.length * 0.075,
				key: `${letter}-${occurrence}`,
				letter,
			});

			return letters;
		},
		[],
	);

const SubscribeContent = () => {
	return (
		<div className="flex absolute z-10 flex-col gap-3 justify-center items-center w-full h-full backdrop-blur-md">
			<div className="flex flex-col items-center mb-1">
				<motion.p
					initial={{ y: -10, filter: "blur(5px)", opacity: 0 }}
					animate={{ y: 0, filter: "blur(0px)", opacity: 1 }}
					transition={{ duration: 0.3, ease: "easeOut" }}
					className="text-lg text-center text-gray-12"
				>
					This feature requires Pro
				</motion.p>
				<motion.p
					initial={{ y: -10, filter: "blur(5px)", opacity: 0 }}
					animate={{ y: 0, filter: "blur(0px)", opacity: 1 }}
					transition={{ duration: 0.3, ease: "easeOut", delay: 0.3 }}
					className="text-sm text-center text-gray-11"
				>
					your domain could look like this
				</motion.p>
			</div>

			<motion.div
				initial={{ y: 10, scale: 1.4, opacity: 0 }}
				animate={{ y: 0, scale: 1, opacity: 1 }}
				transition={{ duration: 0.3, ease: "easeOut", delay: 0.5 }}
				className="overflow-hidden relative px-3 py-1 rounded-xl"
				style={{
					background:
						"linear-gradient(322deg,rgba(255, 255, 255, 1) 0%, rgba(255, 255, 255, 1) 19%, rgba(199, 199, 199, 1) 29%, rgba(217, 217, 217, 1) 52%, rgba(255, 255, 255, 1) 62%, rgba(158, 158, 158, 1) 83%, rgba(163, 163, 163, 1) 93%)",
				}}
			>
				<motion.div
					className="absolute inset-0 z-10 rounded-xl"
					initial={{ x: "-100%" }}
					animate={{
						x: ["-100%", "200%", "-100%"],
					}}
					transition={{
						delay: capsDomainText.length * 0.1 + 0.2,
						duration: 1.5,
						ease: "easeInOut",
						repeat: Infinity,
						repeatDelay: 2,
					}}
					style={{
						background:
							"linear-gradient(90deg, transparent, rgba(255,255,255,1), transparent)",
						mixBlendMode: "screen",
						transform: "skewX(-20deg)",
					}}
				/>

				<div className="flex relative z-10">
					{capsDomainLetters.map(({ delay, key, letter }) => (
						<motion.span
							key={key}
							className="text-[13px] font-medium relative z-0 text-black/50 mix-blend-screen"
							initial={{ opacity: 0, y: -5 }}
							animate={{ opacity: 1, y: 0 }}
							transition={{
								delay,
								duration: 0.2,
								ease: "easeOut",
							}}
						>
							{letter === " " ? "\u00A0" : letter}
						</motion.span>
					))}
				</div>
			</motion.div>
		</div>
	);
};

export default SubscribeContent;
