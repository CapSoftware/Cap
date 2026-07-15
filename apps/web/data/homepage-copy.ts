export interface HeaderCopyVariants {
	default: {
		title: string;
		description: string;
	};
}

export interface HeaderCopy {
	announcement: {
		text: string;
		href: string;
	};
	variants: HeaderCopyVariants;
	modes: {
		id: "instant" | "studio" | "screenshot";
		label: string;
		title: string;
	}[];
	links: {
		label: string;
		href: string;
	}[];
	cta: {
		primaryButton: string;
		secondaryButton: string;
		freeVersionText: string;
		seeOtherOptionsText: string;
	};
}

export interface RecordingModesCopy {
	title: string;
	subtitle: string;
	modes: {
		name: string;
		description: string;
	}[];
}

export interface FeaturesCopy {
	title: string;
	subtitle: string;
	features: {
		title: string;
		description: string;
	}[];
}

export interface BentoCopy {
	eyebrow: string;
	title: string;
	subtitle: string;
	cards: {
		key: string;
		title: string;
		description: string;
	}[];
	cta: {
		label: string;
		href: string;
	};
}

export interface TestimonialsCopy {
	title: string;
	subtitle: string;
	cta: string;
}

export interface PricingCopy {
	title: string;
	subtitle: string;
	lovedBy: string;
	commercial: {
		title: string;
		description: string;
		features: string[];
		cta: string;
		pricing: {
			yearly: number;
			lifetime: number;
		};
		labels: {
			licenses: string;
			yearly: string;
			lifetime: string;
		};
	};
	pro: {
		badge: string;
		title: string;
		description: string;
		features: string[];
		cta: string;
		pricing: {
			annual: number;
			monthly: number;
		};
		labels: {
			users: string;
			monthly: string;
			annually: string;
		};
	};
}

export interface FaqCopy {
	title: string;
	items: {
		question: string;
		answer: string;
	}[];
}

export interface ReadyToGetStartedCopy {
	title: string;
	buttons: {
		primary: string;
		secondary: string;
	};
}

export interface HomePageCopy {
	header: HeaderCopy;
	textReveal: string;
	recordingModes: RecordingModesCopy;
	features: FeaturesCopy;
	bento: BentoCopy;
	testimonials: TestimonialsCopy;
	pricing: PricingCopy;
	faq: FaqCopy;
	readyToGetStarted: ReadyToGetStartedCopy;
}

export const homepageCopy: HomePageCopy = {
	header: {
		announcement: {
			text: "早期用户优惠即将结束——立即锁定折扣",
			href: "/pricing",
		},
		variants: {
			default: {
				title: "一款应用，满足所有屏幕录制需求",
				description:
					"Cap 将三种模式集成在一款应用中，可替代录屏、编辑、截图和视频托管工具。它完全开源，还能连接你自己的 Google 云端硬盘或 S3 存储桶，让每一份录制内容真正属于你。",
			},
		},
		modes: [
			{
				id: "instant",
				label: "即时",
				title: "数秒内完成录制与分享",
			},
			{
				id: "studio",
				label: "工作室",
				title: "在本地录制并编辑",
			},
			{
				id: "screenshot",
				label: "截图",
				title: "截取、标注并复制",
			},
		],
		links: [
			{ label: "屏幕录制", href: "/screen-recorder" },
			{ label: "截图", href: "/features" },
			{ label: "隐私", href: "/privacy" },
			{ label: "开源", href: "/open-source-screen-recorder" },
		],
		cta: {
			primaryButton: "升级到 Cap Pro",
			secondaryButton: "在 GitHub 查看",
			freeVersionText: "无需信用卡。本地录制，由你决定何时分享。",
			seeOtherOptionsText: "更多下载选项",
		},
	},
	textReveal: "录制。编辑。分享。",
	recordingModes: {
		title: "三种模式，毫不妥协",
		subtitle:
			"即时模式会边录边上传，停止录制时分享链接已准备就绪；工作室模式将一切保留在本地，便于精细编辑；只需要一个画面时，就用截图模式。",
		modes: [
			{
				name: "Instant Mode",
				description:
					"点击录制、停止，再分享链接。视频数秒内即可上线，并自动生成字幕、标题、摘要和章节等内容。非常适合快速反馈、错误报告，或需要迅速演示某项内容的场景。",
			},
			{
				name: "Studio Mode",
				description:
					"专业级录制，支持本地编辑、自定义背景和多种导出选项。适合制作精细的演示、教程或展现品牌形象的演示文稿。",
			},
		],
	},
	features: {
		title: "为真实工作方式而打造",
		subtitle:
			"我们打磨每一个细节，让你无需操心。每项功能都旨在节省时间，并让成果更专业。",
		features: [
			{
				title: "你的存储，由你掌控",
				description:
					"连接你自己的 Google 云端硬盘或 S3 存储桶、使用 Cap 云端，或将所有内容保留在本地。无需绑定我们的基础设施，适合有合规要求的团队，以及重视数据主权的用户。",
			},
			{
				title: "默认保护隐私，自主选择分享",
				description:
					"需要时即时分享，想要时本地录制。可公开或私密分享、为敏感录制添加密码，或只保存在本地。",
			},
			{
				title: "真正高效的异步协作",
				description:
					"评论、回应和文字稿让沟通持续推进，无需再开一场会议。查看谁已观看、及时收到反馈通知，并将录制内容转化为可执行的下一步，彻底告别所谓的‘快速同步’电话。",
			},
			{
				title: "覆盖整个团队的跨平台体验",
				description:
					"为 macOS 和 Windows 提供贴合各自平台的原生应用，也提供适合浏览器录制的 Chrome 扩展。录制快速可靠，可融入现有工具和工作流程。",
			},
			{
				title: "专业水准的画质",
				description:
					"支持 4K 录制、60 帧捕获和智能压缩，在保证画质的同时控制文件大小。",
			},
			{
				title: "真正开源",
				description:
					"清楚了解 Cap 的工作原理、贡献你需要的功能，或通过自托管获得完全控制。加入由开发者组成的社区，共同打造透明、可扩展且尊重用户的优秀工具。",
			},
			{
				title: "用 Cap AI 加速工作流程",
				description:
					"为每段录制自动生成标题、摘要、可点击章节和文字稿。真正节省时间，而不是增加额外工作。",
			},
			{
				title: "导入 Loom 视频",
				description:
					"正在从 Loom 迁移？使用内置导入工具，将现有录制直接导入 Cap，无需从头开始，即可集中管理所有内容。",
			},
		],
	},
	bento: {
		eyebrow: "为何选择 Cap",
		title: "为真正属于你而打造",
		subtitle:
			"每项功能都尊重你的真实工作方式——你的存储、你的平台、你的流程。没有厂商锁定，也无需妥协。",
		cards: [
			{
				key: "storage",
				title: "使用你自己的存储",
				description:
					"接入你自己的 Google 云端硬盘或 S3 存储桶、使用 Cap 云端，或将录制完全保留在本地。视频、存储和费用都由你掌控，永远没有厂商锁定。",
			},
			{
				key: "ai",
				title: "让 Cap AI 处理繁琐工作",
				description:
					"每段录制都会由 AI 生成标题、摘要、可点击章节和可全文搜索的文字稿，让录制后的整理工作自动完成。",
			},
			{
				key: "async",
				title: "持续推进的异步沟通",
				description:
					"串联评论、表情回应和观看分析将单向视频变成双向交流，真正替代固定会议。",
			},
			{
				key: "native",
				title: "真正原生，而非 Electron 标签页",
				description:
					"基于 Tauri 和 Rust 构建，在 macOS 和 Windows 上提供真正原生的性能。没有臃肿浏览器，也不额外消耗电量，只有快速轻量的录制体验。",
			},
			{
				key: "oss",
				title: "从端到端，完全开源",
				description:
					"审查每一行代码、贡献期待已久的功能，或自托管完整技术栈。公平、透明，并可自由派生。",
			},
			{
				key: "pixel",
				title: "像素级精准捕获",
				description:
					"通过硬件加速编码，以最高 4K、60 帧录制。文字清晰、画面流畅、文件大小合理，呈现作品应有的质量。",
			},
		],
		cta: {
			label: "探索所有功能",
			href: "/features",
		},
	},
	testimonials: {
		title: "深受创作者喜爱，获得团队信赖",
		subtitle: "加入数千名将 Cap 作为日常视觉沟通工具的用户。",
		cta: "查看更多用户评价",
	},
	pricing: {
		title: "简单透明的价格",
		subtitle: "免费开始，需要更多功能时再升级。早期用户价格永久锁定。",
		lovedBy: "获得 40,000 多名用户信赖",
		commercial: {
			title: "桌面许可证",
			description: "Cap 桌面应用商业许可证——不限次数的本地录制和编辑。",
			features: [
				"商业使用权",
				"不限次数的本地录制和编辑",
				"含完整编辑器的工作室模式",
				"每月 20 个云端分享链接（每段最长 5 分钟）",
				"导出为任意格式",
				"社区支持",
			],
			cta: "获取桌面许可证",
			pricing: {
				yearly: 29,
				lifetime: 58,
			},
			labels: {
				licenses: "许可证类型",
				yearly: "按年",
				lifetime: "一次性",
			},
		},
		pro: {
			badge: "最超值",
			title: "Cap Pro",
			description:
				"包含桌面许可证全部功能，并提供不限量云端功能，实现顺畅分享与协作。",
			features: [
				"桌面许可证的全部功能",
				"不限量云存储和带宽",
				"为每段录制自动生成标题、摘要、可点击章节和文字稿",
				"自定义域名（cap.yourdomain.com）",
				"密码保护分享",
				"观看分析与互动数据",
				"团队工作区",
				"Loom 视频导入工具",
				"支持自定义 S3 存储桶和 Google 云端硬盘",
				"优先支持和抢先体验功能",
			],
			cta: "立即开始",
			pricing: {
				annual: 8.16,
				monthly: 12,
			},
			labels: {
				users: "每位用户",
				monthly: "按月",
				annually: "按年（节省 32%）",
			},
		},
	},
	faq: {
		title: "有问题？这里有答案。",
		items: [
			{
				question: "Cap Pro 和桌面许可证有什么区别？",
				answer:
					"Cap Pro 是付费方案，包含桌面许可证的全部功能，并增加用于顺畅分享和协作的云端功能。桌面许可证则为单个用户提供商业使用权。",
			},
			{
				question: "是否有免费版本？",
				answer:
					"有。Cap 个人使用完全免费，你可以通过工作室模式在本地录制和分享；商业用途需要付费方案。",
			},
			{
				question: "免费版本可以录制多长时间？",
				answer: "免费版本单次可录制 5 分钟，超过后需要升级到付费方案。",
			},
			{
				question: "Cap AI 如何工作？",
				answer:
					"Cap AI 可为录制生成标题、摘要、可点击章节和文字稿。所有 Cap Pro 用户均可使用，并且没有用量限制。",
			},
			{
				question: "Cap 与 Loom 有什么不同？",
				answer:
					"Cap 兼具 Loom 的简洁和专业工具的强大能力。我们开源、支持自定义存储、价格更合理，桌面应用还能离线工作；更重要的是，内容真正属于你。已经在使用 Loom？内置导入工具可帮助你轻松迁移。",
			},
			{
				question: "取消订阅后，我的录制会怎样？",
				answer:
					"录制内容永远属于你。取消 Pro 后，现有分享仍然有效，你也可以随时导出全部内容。降级到免费方案后仍可继续本地录制，或通过自托管保留所有功能。",
			},
			{
				question: "是否提供团队方案？",
				answer:
					"提供。Cap Pro 包含团队工作区，可用于整理录制、管理权限和协作。超过 10 名用户的团队可享批量优惠；如需定制企业功能，请联系我们。",
			},
			{
				question: "支持哪些平台？",
				answer:
					"提供适用于 macOS（Apple 芯片和 Intel）及 Windows 的原生桌面应用，分享链接可在任何地方查看。",
			},
			{
				question: "可以将 Cap 用于商业用途吗？",
				answer:
					"可以。任何付费方案（桌面许可证或 Cap Pro）都包含完整商业使用权，可用于客户项目、销售课程或在任意位置嵌入录制。免费版本仅供个人使用。",
			},
			{
				question: "我的数据安全吗？",
				answer:
					"安全是 Cap 的核心。作为开源项目，我们的代码完全透明且可审计，你可以清楚了解数据如何被处理。云存储端到端加密、自有基础设施选项，以及社区推动的安全审查，共同保护你的内容。",
			},
			{
				question: "GDPR/HIPAA 合规性如何？",
				answer:
					"为满足 GDPR 合规要求，Cap Pro 允许使用自有存储，包括任意区域的自定义 S3 存储桶或你自己的 Google 云端硬盘。对于 HIPAA 等其他法规，自托管方案可提供完全控制；我们也可为企业客户提供已签署的 BAA。",
			},
		],
	},
	readyToGetStarted: {
		title: "准备好升级沟通方式了吗？",
		buttons: {
			primary: "升级到 Cap Pro",
			secondary: "免费下载",
		},
	},
};
