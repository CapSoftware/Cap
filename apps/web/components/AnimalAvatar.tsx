"use client";

import clsx from "clsx";

interface AnimalAvatarProps {
	name: string;
	className?: string;
}

interface AnimalDef {
	bg: string;
	elements: React.ReactNode;
}

const animals: Record<string, AnimalDef> = {
	Walrus: {
		bg: "#94a3b8",
		elements: (
			<>
				<circle cx="18" cy="19" r="9" fill="#d1d5db" />
				<ellipse cx="18" cy="22" rx="5.5" ry="3.5" fill="#e5e7eb" />
				<circle cx="14.5" cy="16.5" r="1.3" fill="#1e293b" />
				<circle cx="14.9" cy="16.1" r="0.4" fill="#fff" />
				<circle cx="21.5" cy="16.5" r="1.3" fill="#1e293b" />
				<circle cx="21.9" cy="16.1" r="0.4" fill="#fff" />
				<ellipse cx="18" cy="20.5" rx="1.8" ry="1.2" fill="#9ca3af" />
				<rect
					x="14.5"
					y="24"
					width="1.2"
					height="3.5"
					rx="0.6"
					fill="#f1f5f9"
				/>
				<rect
					x="20.3"
					y="24"
					width="1.2"
					height="3.5"
					rx="0.6"
					fill="#f1f5f9"
				/>
			</>
		),
	},
	Capybara: {
		bg: "#a8927c",
		elements: (
			<>
				<ellipse cx="18" cy="20" rx="10" ry="9" fill="#c4a882" />
				<circle cx="14" cy="11" r="2.5" fill="#c4a882" />
				<circle cx="22" cy="11" r="2.5" fill="#c4a882" />
				<circle cx="14" cy="11" r="1.5" fill="#b09070" />
				<circle cx="22" cy="11" r="1.5" fill="#b09070" />
				<ellipse cx="18" cy="22" rx="4" ry="3" fill="#d4b896" />
				<ellipse cx="18" cy="21" rx="2" ry="1.5" fill="#8b7355" />
				<circle cx="14.5" cy="17.5" r="1.3" fill="#1e293b" />
				<circle cx="14.9" cy="17.1" r="0.4" fill="#fff" />
				<circle cx="21.5" cy="17.5" r="1.3" fill="#1e293b" />
				<circle cx="21.9" cy="17.1" r="0.4" fill="#fff" />
			</>
		),
	},
	Narwhal: {
		bg: "#7dd3fc",
		elements: (
			<>
				<ellipse cx="18" cy="21" rx="9" ry="8" fill="#bfdbfe" />
				<ellipse cx="18" cy="22" rx="7" ry="6" fill="#dbeafe" />
				<line
					x1="18"
					y1="4"
					x2="18"
					y2="14"
					stroke="#fcd34d"
					strokeWidth="2"
					strokeLinecap="round"
				/>
				<line
					x1="18"
					y1="6"
					x2="18"
					y2="13"
					stroke="#fde68a"
					strokeWidth="1"
					strokeLinecap="round"
				/>
				<circle cx="14.5" cy="19" r="1.3" fill="#1e293b" />
				<circle cx="14.9" cy="18.6" r="0.4" fill="#fff" />
				<circle cx="21.5" cy="19" r="1.3" fill="#1e293b" />
				<circle cx="21.9" cy="18.6" r="0.4" fill="#fff" />
				<path
					d="M15 24 Q18 26 21 24"
					fill="none"
					stroke="#64748b"
					strokeWidth="0.8"
					strokeLinecap="round"
				/>
				<ellipse cx="10" cy="23" rx="3" ry="1.5" fill="#bfdbfe" />
				<ellipse cx="26" cy="23" rx="3" ry="1.5" fill="#bfdbfe" />
			</>
		),
	},
	Quokka: {
		bg: "#fbbf24",
		elements: (
			<>
				<circle cx="18" cy="19" r="10" fill="#d4a06a" />
				<circle cx="12" cy="12" r="3" fill="#d4a06a" />
				<circle cx="24" cy="12" r="3" fill="#d4a06a" />
				<circle cx="12" cy="12" r="1.8" fill="#c49058" />
				<circle cx="24" cy="12" r="1.8" fill="#c49058" />
				<circle cx="14.5" cy="17" r="1.3" fill="#1e293b" />
				<circle cx="14.9" cy="16.6" r="0.4" fill="#fff" />
				<circle cx="21.5" cy="17" r="1.3" fill="#1e293b" />
				<circle cx="21.9" cy="16.6" r="0.4" fill="#fff" />
				<ellipse cx="18" cy="20" rx="1.5" ry="1" fill="#8b6040" />
				<path
					d="M13 22 Q18 27 23 22"
					fill="none"
					stroke="#8b6040"
					strokeWidth="1"
					strokeLinecap="round"
				/>
				<ellipse
					cx="12"
					cy="21"
					rx="2.5"
					ry="1.5"
					fill="#f9a8a8"
					opacity="0.4"
				/>
				<ellipse
					cx="24"
					cy="21"
					rx="2.5"
					ry="1.5"
					fill="#f9a8a8"
					opacity="0.4"
				/>
			</>
		),
	},
	Axolotl: {
		bg: "#f9a8d4",
		elements: (
			<>
				<circle cx="18" cy="19" r="9" fill="#fce7f3" />
				<ellipse
					cx="8"
					cy="13"
					rx="2"
					ry="4"
					fill="#fb7185"
					transform="rotate(-20 8 13)"
				/>
				<ellipse
					cx="6"
					cy="11"
					rx="1.5"
					ry="3.5"
					fill="#fb7185"
					transform="rotate(-35 6 11)"
				/>
				<ellipse
					cx="10"
					cy="11"
					rx="1.5"
					ry="3.5"
					fill="#fb7185"
					transform="rotate(-5 10 11)"
				/>
				<ellipse
					cx="28"
					cy="13"
					rx="2"
					ry="4"
					fill="#fb7185"
					transform="rotate(20 28 13)"
				/>
				<ellipse
					cx="30"
					cy="11"
					rx="1.5"
					ry="3.5"
					fill="#fb7185"
					transform="rotate(35 30 11)"
				/>
				<ellipse
					cx="26"
					cy="11"
					rx="1.5"
					ry="3.5"
					fill="#fb7185"
					transform="rotate(5 26 11)"
				/>
				<circle cx="14.5" cy="17.5" r="1.5" fill="#1e293b" />
				<circle cx="15" cy="17" r="0.5" fill="#fff" />
				<circle cx="21.5" cy="17.5" r="1.5" fill="#1e293b" />
				<circle cx="22" cy="17" r="0.5" fill="#fff" />
				<path
					d="M15 23 Q18 25 21 23"
					fill="none"
					stroke="#e879a0"
					strokeWidth="0.8"
					strokeLinecap="round"
				/>
				<ellipse
					cx="12.5"
					cy="21"
					rx="2"
					ry="1.2"
					fill="#fca5b5"
					opacity="0.5"
				/>
				<ellipse
					cx="23.5"
					cy="21"
					rx="2"
					ry="1.2"
					fill="#fca5b5"
					opacity="0.5"
				/>
			</>
		),
	},
	Pangolin: {
		bg: "#a3be8c",
		elements: (
			<>
				<ellipse cx="18" cy="20" rx="9" ry="10" fill="#c4a46c" />
				<path d="M11 14 Q18 10 25 14" fill="#b8964e" />
				<path
					d="M10 18 Q18 14 26 18"
					fill="#c4a46c"
					stroke="#b8964e"
					strokeWidth="0.5"
				/>
				<path
					d="M10 22 Q18 18 26 22"
					fill="#c4a46c"
					stroke="#b8964e"
					strokeWidth="0.5"
				/>
				<path
					d="M12 26 Q18 22 24 26"
					fill="#c4a46c"
					stroke="#b8964e"
					strokeWidth="0.5"
				/>
				<ellipse cx="18" cy="21" rx="5" ry="4" fill="#d4b87c" />
				<circle cx="15" cy="18" r="1.2" fill="#1e293b" />
				<circle cx="15.3" cy="17.7" r="0.35" fill="#fff" />
				<circle cx="21" cy="18" r="1.2" fill="#1e293b" />
				<circle cx="21.3" cy="17.7" r="0.35" fill="#fff" />
				<ellipse cx="18" cy="21.5" rx="1.2" ry="0.8" fill="#8b7040" />
			</>
		),
	},
	Okapi: {
		bg: "#c084fc",
		elements: (
			<>
				<ellipse cx="18" cy="20" rx="8" ry="10" fill="#6b4226" />
				<rect x="15" y="6" width="2" height="5" rx="1" fill="#f59e0b" />
				<rect x="19" y="6" width="2" height="5" rx="1" fill="#f59e0b" />
				<circle cx="16" cy="6" r="1.2" fill="#f59e0b" />
				<circle cx="20" cy="6" r="1.2" fill="#f59e0b" />
				<circle cx="14.5" cy="17" r="1.3" fill="#1e293b" />
				<circle cx="14.9" cy="16.6" r="0.4" fill="#fff" />
				<circle cx="21.5" cy="17" r="1.3" fill="#1e293b" />
				<circle cx="21.9" cy="16.6" r="0.4" fill="#fff" />
				<ellipse cx="18" cy="23" rx="3.5" ry="2.5" fill="#7c5233" />
				<ellipse cx="18" cy="22" rx="1.5" ry="1" fill="#4a2c15" />
				<rect x="8" y="24" width="4" height="1.5" rx="0.75" fill="#f5f5f4" />
				<rect x="8" y="27" width="3.5" height="1.5" rx="0.75" fill="#f5f5f4" />
				<rect x="24" y="24" width="4" height="1.5" rx="0.75" fill="#f5f5f4" />
				<rect
					x="24.5"
					y="27"
					width="3.5"
					height="1.5"
					rx="0.75"
					fill="#f5f5f4"
				/>
			</>
		),
	},
	Platypus: {
		bg: "#2dd4bf",
		elements: (
			<>
				<circle cx="18" cy="19" r="9" fill="#8b6f47" />
				<ellipse cx="18" cy="24" rx="7" ry="3" fill="#f59e0b" />
				<ellipse cx="18" cy="23.5" rx="6" ry="2.5" fill="#fbbf24" />
				<circle cx="14.5" cy="16.5" r="1.3" fill="#1e293b" />
				<circle cx="14.9" cy="16.1" r="0.4" fill="#fff" />
				<circle cx="21.5" cy="16.5" r="1.3" fill="#1e293b" />
				<circle cx="21.9" cy="16.1" r="0.4" fill="#fff" />
				<circle cx="16.5" cy="23" r="0.5" fill="#d97706" />
				<circle cx="19.5" cy="23" r="0.5" fill="#d97706" />
			</>
		),
	},
	Wombat: {
		bg: "#a78bfa",
		elements: (
			<>
				<circle cx="18" cy="19" r="10" fill="#7c6043" />
				<path d="M11 12 L13 8 L15 12" fill="#7c6043" />
				<path d="M21 12 L23 8 L25 12" fill="#7c6043" />
				<circle cx="14.5" cy="17" r="1.3" fill="#1e293b" />
				<circle cx="14.9" cy="16.6" r="0.4" fill="#fff" />
				<circle cx="21.5" cy="17" r="1.3" fill="#1e293b" />
				<circle cx="21.9" cy="16.6" r="0.4" fill="#fff" />
				<rect x="15" y="20" width="6" height="4" rx="2" fill="#5c4433" />
				<ellipse cx="18" cy="20.5" rx="2" ry="1.2" fill="#4a3728" />
			</>
		),
	},
	Chinchilla: {
		bg: "#d1d5db",
		elements: (
			<>
				<ellipse cx="9" cy="14" rx="5" ry="8" fill="#e5e7eb" />
				<ellipse cx="27" cy="14" rx="5" ry="8" fill="#e5e7eb" />
				<ellipse cx="9" cy="14" rx="3.5" ry="6" fill="#fce7f3" />
				<ellipse cx="27" cy="14" rx="3.5" ry="6" fill="#fce7f3" />
				<circle cx="18" cy="20" r="9" fill="#e5e7eb" />
				<circle cx="14.5" cy="18" r="1.5" fill="#1e293b" />
				<circle cx="15" cy="17.5" r="0.45" fill="#fff" />
				<circle cx="21.5" cy="18" r="1.5" fill="#1e293b" />
				<circle cx="22" cy="17.5" r="0.45" fill="#fff" />
				<ellipse cx="18" cy="21.5" rx="1.2" ry="0.8" fill="#9ca3af" />
				<line
					x1="10"
					y1="21"
					x2="14"
					y2="20.5"
					stroke="#9ca3af"
					strokeWidth="0.5"
				/>
				<line
					x1="10"
					y1="22.5"
					x2="14"
					y2="22"
					stroke="#9ca3af"
					strokeWidth="0.5"
				/>
				<line
					x1="26"
					y1="21"
					x2="22"
					y2="20.5"
					stroke="#9ca3af"
					strokeWidth="0.5"
				/>
				<line
					x1="26"
					y1="22.5"
					x2="22"
					y2="22"
					stroke="#9ca3af"
					strokeWidth="0.5"
				/>
			</>
		),
	},
	Manatee: {
		bg: "#67e8f9",
		elements: (
			<>
				<circle cx="18" cy="19" r="10" fill="#9ca3af" />
				<ellipse cx="18" cy="23" rx="6" ry="4" fill="#b0b8c4" />
				<circle cx="16" cy="23" r="1.5" fill="#b8c0cc" />
				<circle cx="20" cy="23" r="1.5" fill="#b8c0cc" />
				<circle cx="14.5" cy="17" r="1.2" fill="#1e293b" />
				<circle cx="14.9" cy="16.6" r="0.35" fill="#fff" />
				<circle cx="21.5" cy="17" r="1.2" fill="#1e293b" />
				<circle cx="21.9" cy="16.6" r="0.35" fill="#fff" />
				<circle cx="16.5" cy="22" r="0.5" fill="#6b7280" />
				<circle cx="19.5" cy="22" r="0.5" fill="#6b7280" />
				<ellipse cx="12" cy="21" rx="2" ry="1.2" fill="#d1d5db" opacity="0.5" />
				<ellipse cx="24" cy="21" rx="2" ry="1.2" fill="#d1d5db" opacity="0.5" />
			</>
		),
	},
	Flamingo: {
		bg: "#fb7185",
		elements: (
			<>
				<path
					d="M18 28 Q16 22 18 16"
					stroke="#fda4af"
					strokeWidth="2.5"
					fill="none"
					strokeLinecap="round"
				/>
				<circle cx="18" cy="14" r="6" fill="#fda4af" />
				<circle cx="18" cy="14" r="5" fill="#fecdd3" />
				<path d="M20 14 L25 12 L24 15 Z" fill="#f59e0b" />
				<path d="M20 14 L25 13 L24 15 Z" fill="#92400e" />
				<circle cx="16.5" cy="12.5" r="1.1" fill="#1e293b" />
				<circle cx="16.8" cy="12.2" r="0.35" fill="#fff" />
			</>
		),
	},
	Hedgehog: {
		bg: "#fcd34d",
		elements: (
			<>
				<polygon points="10,16 12,8 14,16" fill="#92400e" />
				<polygon points="13,16 15,7 17,16" fill="#a1622e" />
				<polygon points="16,16 18,6 20,16" fill="#92400e" />
				<polygon points="19,16 21,7 23,16" fill="#a1622e" />
				<polygon points="22,16 24,8 26,16" fill="#92400e" />
				<ellipse cx="18" cy="22" rx="9" ry="7" fill="#e8c88a" />
				<circle cx="15" cy="20" r="1.3" fill="#1e293b" />
				<circle cx="15.4" cy="19.6" r="0.4" fill="#fff" />
				<circle cx="21" cy="20" r="1.3" fill="#1e293b" />
				<circle cx="21.4" cy="19.6" r="0.4" fill="#fff" />
				<ellipse cx="18" cy="22.5" rx="1.5" ry="1" fill="#92400e" />
				<ellipse cx="13" cy="23" rx="2" ry="1.2" fill="#fca5a5" opacity="0.4" />
				<ellipse cx="23" cy="23" rx="2" ry="1.2" fill="#fca5a5" opacity="0.4" />
			</>
		),
	},
	Otter: {
		bg: "#a3e635",
		elements: (
			<>
				<circle cx="18" cy="19" r="9.5" fill="#8b6f47" />
				<circle cx="12" cy="12" r="2.5" fill="#8b6f47" />
				<circle cx="24" cy="12" r="2.5" fill="#8b6f47" />
				<ellipse cx="18" cy="22" rx="6" ry="4" fill="#d4c4a8" />
				<circle cx="14.5" cy="17.5" r="1.3" fill="#1e293b" />
				<circle cx="14.9" cy="17.1" r="0.4" fill="#fff" />
				<circle cx="21.5" cy="17.5" r="1.3" fill="#1e293b" />
				<circle cx="21.9" cy="17.1" r="0.4" fill="#fff" />
				<ellipse cx="18" cy="21" rx="1.5" ry="1" fill="#5c4033" />
				<line
					x1="10"
					y1="22"
					x2="14"
					y2="21.5"
					stroke="#6b5b43"
					strokeWidth="0.5"
				/>
				<line
					x1="10"
					y1="23.5"
					x2="14"
					y2="23"
					stroke="#6b5b43"
					strokeWidth="0.5"
				/>
				<line
					x1="26"
					y1="22"
					x2="22"
					y2="21.5"
					stroke="#6b5b43"
					strokeWidth="0.5"
				/>
				<line
					x1="26"
					y1="23.5"
					x2="22"
					y2="23"
					stroke="#6b5b43"
					strokeWidth="0.5"
				/>
			</>
		),
	},
	Puffin: {
		bg: "#60a5fa",
		elements: (
			<>
				<circle cx="18" cy="18" r="9" fill="#1e293b" />
				<ellipse cx="18" cy="20" rx="6" ry="7" fill="#f8fafc" />
				<path d="M20 17 L28 15 L26 19 Z" fill="#f97316" />
				<path d="M20 17 L28 16 L26 19 Z" fill="#dc2626" />
				<path d="M21 17.5 L27 16 L26 18" fill="#fbbf24" stroke="none" />
				<circle cx="15" cy="15.5" r="1.3" fill="#f8fafc" />
				<circle cx="15" cy="15.5" r="0.9" fill="#1e293b" />
				<circle cx="15.3" cy="15.2" r="0.3" fill="#fff" />
				<circle cx="21" cy="15.5" r="1.3" fill="#f8fafc" />
				<circle cx="21" cy="15.5" r="0.9" fill="#1e293b" />
				<circle cx="21.3" cy="15.2" r="0.3" fill="#fff" />
			</>
		),
	},
	Raccoon: {
		bg: "#9ca3af",
		elements: (
			<>
				<circle cx="18" cy="19" r="9.5" fill="#9ca3af" />
				<path d="M11 14 L9 7 L14 12" fill="#9ca3af" />
				<path d="M25 14 L27 7 L22 12" fill="#9ca3af" />
				<rect x="10" y="15" width="16" height="5" rx="2.5" fill="#1e293b" />
				<circle cx="14.5" cy="17.5" r="1.5" fill="#fff" />
				<circle cx="14.5" cy="17.5" r="0.9" fill="#1e293b" />
				<circle cx="14.8" cy="17.2" r="0.3" fill="#fff" />
				<circle cx="21.5" cy="17.5" r="1.5" fill="#fff" />
				<circle cx="21.5" cy="17.5" r="0.9" fill="#1e293b" />
				<circle cx="21.8" cy="17.2" r="0.3" fill="#fff" />
				<ellipse cx="18" cy="23" rx="3" ry="2" fill="#d1d5db" />
				<ellipse cx="18" cy="22.5" rx="1.2" ry="0.8" fill="#1e293b" />
			</>
		),
	},
	Sloth: {
		bg: "#bef264",
		elements: (
			<>
				<circle cx="18" cy="19" r="10" fill="#a8876a" />
				<ellipse cx="13" cy="17" rx="3.5" ry="3" fill="#6b4f3a" />
				<ellipse cx="23" cy="17" rx="3.5" ry="3" fill="#6b4f3a" />
				<circle cx="13.5" cy="17" r="1.5" fill="#fff" />
				<circle cx="13.5" cy="17" r="0.8" fill="#1e293b" />
				<circle cx="22.5" cy="17" r="1.5" fill="#fff" />
				<circle cx="22.5" cy="17" r="0.8" fill="#1e293b" />
				<ellipse cx="18" cy="22" rx="1.5" ry="1" fill="#5c3d2a" />
				<path
					d="M15 24 Q18 26 21 24"
					fill="none"
					stroke="#5c3d2a"
					strokeWidth="0.8"
					strokeLinecap="round"
				/>
			</>
		),
	},
	Chameleon: {
		bg: "#34d399",
		elements: (
			<>
				<circle cx="17" cy="18" r="9" fill="#4ade80" />
				<ellipse cx="17" cy="18" rx="8" ry="7.5" fill="#86efac" />
				<circle cx="14" cy="16" r="4" fill="#fff" />
				<circle cx="14" cy="16" r="3" fill="#4ade80" />
				<circle cx="14" cy="16" r="1.5" fill="#1e293b" />
				<circle cx="14.4" cy="15.6" r="0.45" fill="#fff" />
				<path
					d="M22 18 Q28 14 30 18"
					fill="#4ade80"
					stroke="#22c55e"
					strokeWidth="0.8"
				/>
				<path
					d="M6 24 Q4 22 5 20 Q6 18 8 20"
					fill="none"
					stroke="#4ade80"
					strokeWidth="2.5"
					strokeLinecap="round"
				/>
				<path
					d="M20 21 Q23 20 24 22"
					fill="none"
					stroke="#22c55e"
					strokeWidth="0.8"
					strokeLinecap="round"
				/>
			</>
		),
	},
	Penguin: {
		bg: "#93c5fd",
		elements: (
			<>
				<ellipse cx="18" cy="20" rx="9" ry="11" fill="#1e293b" />
				<ellipse cx="18" cy="22" rx="6" ry="8" fill="#f8fafc" />
				<circle cx="14.5" cy="16" r="1.3" fill="#fff" />
				<circle cx="14.5" cy="16" r="0.8" fill="#1e293b" />
				<circle cx="14.8" cy="15.7" r="0.25" fill="#fff" />
				<circle cx="21.5" cy="16" r="1.3" fill="#fff" />
				<circle cx="21.5" cy="16" r="0.8" fill="#1e293b" />
				<circle cx="21.8" cy="15.7" r="0.25" fill="#fff" />
				<path d="M16 19 L18 21 L20 19" fill="#f97316" />
				<ellipse
					cx="7"
					cy="22"
					rx="2.5"
					ry="1"
					fill="#1e293b"
					transform="rotate(-20 7 22)"
				/>
				<ellipse
					cx="29"
					cy="22"
					rx="2.5"
					ry="1"
					fill="#1e293b"
					transform="rotate(20 29 22)"
				/>
			</>
		),
	},
	Koala: {
		bg: "#a1a1aa",
		elements: (
			<>
				<circle cx="8" cy="16" r="6" fill="#a1a1aa" />
				<circle cx="8" cy="16" r="4" fill="#d4d4d8" />
				<circle cx="28" cy="16" r="6" fill="#a1a1aa" />
				<circle cx="28" cy="16" r="4" fill="#d4d4d8" />
				<circle cx="18" cy="20" r="9" fill="#d4d4d8" />
				<circle cx="14.5" cy="18" r="1.3" fill="#1e293b" />
				<circle cx="14.9" cy="17.6" r="0.4" fill="#fff" />
				<circle cx="21.5" cy="18" r="1.3" fill="#1e293b" />
				<circle cx="21.9" cy="17.6" r="0.4" fill="#fff" />
				<ellipse cx="18" cy="22" rx="3" ry="2" fill="#71717a" />
			</>
		),
	},
	"Red Panda": {
		bg: "#f97316",
		elements: (
			<>
				<circle cx="18" cy="19" r="9.5" fill="#dc6830" />
				<path d="M10 14 L8 7 L14 12" fill="#dc6830" />
				<path d="M26 14 L28 7 L22 12" fill="#dc6830" />
				<path d="M10 14 L9 8.5 L13 12" fill="#92400e" />
				<path d="M26 14 L27 8.5 L23 12" fill="#92400e" />
				<ellipse cx="18" cy="21" rx="5" ry="4" fill="#fef3c7" />
				<ellipse cx="13" cy="18" rx="3" ry="2.5" fill="#fef3c7" />
				<ellipse cx="23" cy="18" rx="3" ry="2.5" fill="#fef3c7" />
				<circle cx="14.5" cy="17.5" r="1.3" fill="#1e293b" />
				<circle cx="14.9" cy="17.1" r="0.4" fill="#fff" />
				<circle cx="21.5" cy="17.5" r="1.3" fill="#1e293b" />
				<circle cx="21.9" cy="17.1" r="0.4" fill="#fff" />
				<ellipse cx="18" cy="21" rx="1.5" ry="1" fill="#1e293b" />
			</>
		),
	},
	Seahorse: {
		bg: "#c084fc",
		elements: (
			<>
				<ellipse cx="18" cy="13" rx="5" ry="5.5" fill="#e9b8f0" />
				<path
					d="M15 6 L17 4 L19 6 L21 4 L22 7"
					fill="#d8a0e0"
					stroke="#d8a0e0"
					strokeWidth="0.5"
				/>
				<path
					d="M18 18 Q20 22 18 26 Q16 29 14 28"
					fill="none"
					stroke="#e9b8f0"
					strokeWidth="4"
					strokeLinecap="round"
				/>
				<path
					d="M14 28 Q12 27 13 25"
					fill="none"
					stroke="#e9b8f0"
					strokeWidth="3"
					strokeLinecap="round"
				/>
				<ellipse cx="18" cy="16" rx="4" ry="4.5" fill="#f0d0f4" />
				<circle cx="16" cy="12" r="1.2" fill="#1e293b" />
				<circle cx="16.3" cy="11.7" r="0.35" fill="#fff" />
				<path
					d="M17 15 Q18 16 19 15"
					fill="none"
					stroke="#b07cc0"
					strokeWidth="0.6"
					strokeLinecap="round"
				/>
			</>
		),
	},
	Toucan: {
		bg: "#facc15",
		elements: (
			<>
				<circle cx="15" cy="18" r="8" fill="#1e293b" />
				<circle cx="13" cy="16" r="1.5" fill="#fff" />
				<circle cx="13" cy="16" r="0.9" fill="#1e293b" />
				<circle cx="13.3" cy="15.7" r="0.3" fill="#fff" />
				<ellipse cx="25" cy="18" rx="8" ry="4.5" fill="#f97316" />
				<ellipse cx="25" cy="18" rx="7.5" ry="4" fill="#fbbf24" />
				<path d="M22 16 Q25 15 28 16" fill="#f97316" />
				<ellipse cx="25" cy="19.5" rx="6" ry="2" fill="#fb923c" />
				<circle cx="32" cy="18" r="0.8" fill="#1e293b" />
				<ellipse cx="15" cy="22" rx="4" ry="2" fill="#f8fafc" />
			</>
		),
	},
	Lemur: {
		bg: "#818cf8",
		elements: (
			<>
				<circle cx="18" cy="19" r="9" fill="#d4d4d8" />
				<path d="M11 14 L9 8 L14 13" fill="#d4d4d8" />
				<path d="M25 14 L27 8 L22 13" fill="#d4d4d8" />
				<circle cx="14" cy="17" r="4" fill="#fef9c3" />
				<circle cx="22" cy="17" r="4" fill="#fef9c3" />
				<circle cx="14" cy="17" r="2.2" fill="#1e293b" />
				<circle cx="14.5" cy="16.5" r="0.6" fill="#fff" />
				<circle cx="22" cy="17" r="2.2" fill="#1e293b" />
				<circle cx="22.5" cy="16.5" r="0.6" fill="#fff" />
				<ellipse cx="18" cy="22.5" rx="2" ry="1.5" fill="#a1a1aa" />
				<ellipse cx="18" cy="22" rx="1" ry="0.6" fill="#1e293b" />
			</>
		),
	},
	Armadillo: {
		bg: "#f472b6",
		elements: (
			<>
				<ellipse cx="18" cy="20" rx="10" ry="8" fill="#a8a29e" />
				<line
					x1="11"
					y1="16"
					x2="25"
					y2="16"
					stroke="#78716c"
					strokeWidth="0.7"
				/>
				<line
					x1="10"
					y1="19"
					x2="26"
					y2="19"
					stroke="#78716c"
					strokeWidth="0.7"
				/>
				<line
					x1="10"
					y1="22"
					x2="26"
					y2="22"
					stroke="#78716c"
					strokeWidth="0.7"
				/>
				<line
					x1="11"
					y1="25"
					x2="25"
					y2="25"
					stroke="#78716c"
					strokeWidth="0.7"
				/>
				<ellipse cx="18" cy="14" rx="5" ry="4" fill="#d6d3d1" />
				<circle cx="16" cy="13" r="1" fill="#1e293b" />
				<circle cx="16.3" cy="12.7" r="0.3" fill="#fff" />
				<circle cx="20" cy="13" r="1" fill="#1e293b" />
				<circle cx="20.3" cy="12.7" r="0.3" fill="#fff" />
				<ellipse cx="18" cy="15" rx="1.5" ry="1" fill="#a8a29e" />
				<circle cx="10" cy="13" r="2" fill="#d6d3d1" />
				<circle cx="26" cy="13" r="2" fill="#d6d3d1" />
			</>
		),
	},
	Alpaca: {
		bg: "#fde68a",
		elements: (
			<>
				<circle cx="14" cy="10" r="3.5" fill="#fef3c7" />
				<circle cx="22" cy="10" r="3.5" fill="#fef3c7" />
				<circle cx="18" cy="9" r="4" fill="#fef3c7" />
				<circle cx="15" cy="12" r="3.5" fill="#fef3c7" />
				<circle cx="21" cy="12" r="3.5" fill="#fef3c7" />
				<circle cx="12" cy="13" r="3" fill="#fef3c7" />
				<circle cx="24" cy="13" r="3" fill="#fef3c7" />
				<circle cx="18" cy="14" r="4" fill="#fef3c7" />
				<rect x="9" y="9" width="3" height="2" rx="1" fill="#fde68a" />
				<rect x="24" y="9" width="3" height="2" rx="1" fill="#fde68a" />
				<ellipse cx="18" cy="20" rx="5" ry="4" fill="#fef3c7" />
				<circle cx="15.5" cy="18.5" r="1.1" fill="#1e293b" />
				<circle cx="15.8" cy="18.2" r="0.35" fill="#fff" />
				<circle cx="20.5" cy="18.5" r="1.1" fill="#1e293b" />
				<circle cx="20.8" cy="18.2" r="0.35" fill="#fff" />
				<path
					d="M16 22 Q18 23 20 22"
					fill="none"
					stroke="#b08d5a"
					strokeWidth="0.7"
					strokeLinecap="round"
				/>
				<ellipse cx="14" cy="21" rx="1.5" ry="1" fill="#fca5a5" opacity="0.4" />
				<ellipse cx="22" cy="21" rx="1.5" ry="1" fill="#fca5a5" opacity="0.4" />
			</>
		),
	},
	Meerkat: {
		bg: "#fdba74",
		elements: (
			<>
				<ellipse cx="18" cy="20" rx="7" ry="10" fill="#c4a06a" />
				<circle cx="14" cy="11" r="2.5" fill="#c4a06a" />
				<circle cx="22" cy="11" r="2.5" fill="#c4a06a" />
				<circle cx="14" cy="11" r="1.5" fill="#b08d5a" />
				<circle cx="22" cy="11" r="1.5" fill="#b08d5a" />
				<ellipse cx="18" cy="18" rx="5" ry="3" fill="#d4b88a" />
				<circle cx="15.5" cy="16.5" r="1.5" fill="#1e293b" />
				<circle cx="15.9" cy="16.1" r="0.45" fill="#fff" />
				<circle cx="20.5" cy="16.5" r="1.5" fill="#1e293b" />
				<circle cx="20.9" cy="16.1" r="0.45" fill="#fff" />
				<ellipse cx="18" cy="20" rx="1.3" ry="0.9" fill="#5c4033" />
				<ellipse cx="18" cy="24" rx="4" ry="3" fill="#e8d5b8" />
			</>
		),
	},
	Ibex: {
		bg: "#a3a3a3",
		elements: (
			<>
				<path
					d="M10 14 Q8 8 6 4"
					fill="none"
					stroke="#78716c"
					strokeWidth="2.5"
					strokeLinecap="round"
				/>
				<path
					d="M8 10 Q7 8 8 6"
					fill="none"
					stroke="#78716c"
					strokeWidth="1.5"
					strokeLinecap="round"
				/>
				<path
					d="M26 14 Q28 8 30 4"
					fill="none"
					stroke="#78716c"
					strokeWidth="2.5"
					strokeLinecap="round"
				/>
				<path
					d="M28 10 Q29 8 28 6"
					fill="none"
					stroke="#78716c"
					strokeWidth="1.5"
					strokeLinecap="round"
				/>
				<circle cx="18" cy="20" r="9" fill="#a8927c" />
				<circle cx="14.5" cy="18" r="1.3" fill="#1e293b" />
				<circle cx="14.9" cy="17.6" r="0.4" fill="#fff" />
				<circle cx="21.5" cy="18" r="1.3" fill="#1e293b" />
				<circle cx="21.9" cy="17.6" r="0.4" fill="#fff" />
				<ellipse cx="18" cy="22" rx="2" ry="1.3" fill="#8b7355" />
				<path
					d="M16 27 Q18 30 20 27"
					fill="#a8927c"
					stroke="#8b7355"
					strokeWidth="0.5"
				/>
			</>
		),
	},
	Tapir: {
		bg: "#6ee7b7",
		elements: (
			<>
				<circle cx="18" cy="19" r="9.5" fill="#3f3f46" />
				<ellipse cx="18" cy="15" rx="6" ry="2" fill="#52525b" />
				<ellipse cx="20" cy="23" rx="6" ry="3" fill="#52525b" />
				<path d="M24 21 Q28 19 27 23 Q26 25 24 24" fill="#71717a" />
				<circle cx="27" cy="22" r="0.6" fill="#3f3f46" />
				<circle cx="14.5" cy="17" r="1.3" fill="#e5e7eb" />
				<circle cx="14.5" cy="17" r="0.8" fill="#1e293b" />
				<circle cx="14.8" cy="16.7" r="0.25" fill="#fff" />
				<circle cx="21.5" cy="17" r="1.3" fill="#e5e7eb" />
				<circle cx="21.5" cy="17" r="0.8" fill="#1e293b" />
				<circle cx="21.8" cy="16.7" r="0.25" fill="#fff" />
			</>
		),
	},
	Kiwi: {
		bg: "#84cc16",
		elements: (
			<>
				<ellipse cx="17" cy="20" rx="9" ry="8" fill="#7c5c3c" />
				<circle cx="17" cy="16" r="6" fill="#8b6f47" />
				<path
					d="M22 15 L32 12"
					stroke="#a8927c"
					strokeWidth="2"
					strokeLinecap="round"
				/>
				<path
					d="M22 15 L32 13"
					stroke="#8b7355"
					strokeWidth="1"
					strokeLinecap="round"
				/>
				<circle cx="15" cy="14.5" r="1.2" fill="#1e293b" />
				<circle cx="15.3" cy="14.2" r="0.35" fill="#fff" />
				<ellipse cx="14" cy="27" rx="1.5" ry="1" fill="#a8927c" />
				<ellipse cx="20" cy="27" rx="1.5" ry="1" fill="#a8927c" />
			</>
		),
	},
	Gecko: {
		bg: "#4ade80",
		elements: (
			<>
				<circle cx="18" cy="19" r="8" fill="#86efac" />
				<circle cx="13" cy="13" r="4.5" fill="#86efac" />
				<circle cx="23" cy="13" r="4.5" fill="#86efac" />
				<circle cx="13" cy="13" r="3" fill="#fef9c3" />
				<circle cx="23" cy="13" r="3" fill="#fef9c3" />
				<ellipse cx="13" cy="13" rx="1" ry="2.5" fill="#1e293b" />
				<ellipse cx="23" cy="13" rx="1" ry="2.5" fill="#1e293b" />
				<circle cx="13.4" cy="12.2" r="0.4" fill="#fff" />
				<circle cx="23.4" cy="12.2" r="0.4" fill="#fff" />
				<path
					d="M15 22 Q18 24 21 22"
					fill="none"
					stroke="#22c55e"
					strokeWidth="0.8"
					strokeLinecap="round"
				/>
				<circle cx="14" cy="20" r="1" fill="#4ade80" opacity="0.6" />
				<circle cx="22" cy="20" r="1" fill="#4ade80" opacity="0.6" />
				<circle cx="18" cy="17" r="0.8" fill="#4ade80" opacity="0.6" />
			</>
		),
	},
	Bison: {
		bg: "#92400e",
		elements: (
			<>
				<circle cx="18" cy="14" r="8" fill="#78350f" />
				<circle cx="15" cy="10" r="3" fill="#78350f" />
				<circle cx="21" cy="10" r="3" fill="#78350f" />
				<circle cx="18" cy="12" r="4" fill="#78350f" />
				<circle cx="14" cy="11" r="2.5" fill="#78350f" />
				<circle cx="22" cy="11" r="2.5" fill="#78350f" />
				<path
					d="M9 14 Q7 10 8 8"
					fill="none"
					stroke="#a16207"
					strokeWidth="2"
					strokeLinecap="round"
				/>
				<path
					d="M27 14 Q29 10 28 8"
					fill="none"
					stroke="#a16207"
					strokeWidth="2"
					strokeLinecap="round"
				/>
				<ellipse cx="18" cy="22" rx="7" ry="6" fill="#92400e" />
				<circle cx="15" cy="19.5" r="1.2" fill="#fef3c7" />
				<circle cx="15" cy="19.5" r="0.7" fill="#1e293b" />
				<circle cx="15.2" cy="19.3" r="0.2" fill="#fff" />
				<circle cx="21" cy="19.5" r="1.2" fill="#fef3c7" />
				<circle cx="21" cy="19.5" r="0.7" fill="#1e293b" />
				<circle cx="21.2" cy="19.3" r="0.2" fill="#fff" />
				<ellipse cx="18" cy="24" rx="3.5" ry="2.5" fill="#78350f" />
				<ellipse cx="18" cy="24" rx="1.5" ry="1" fill="#451a03" />
			</>
		),
	},
};

export function extractAnimalName(displayName: string): string {
	return displayName.replace(/^Anonymous\s+/, "");
}

export function AnimalAvatar({ name, className }: AnimalAvatarProps) {
	const animalName = extractAnimalName(name);
	const animal = animals[animalName];

	if (!animal) {
		return (
			<div
				className={clsx(
					"flex justify-center items-center rounded-full bg-gray-3",
					className,
				)}
			>
				<span className="text-xs font-medium text-gray-9">?</span>
			</div>
		);
	}

	return (
		<div
			className={clsx("rounded-full overflow-hidden flex-shrink-0", className)}
			style={{ background: animal.bg }}
		>
			<svg
				viewBox="0 0 36 36"
				xmlns="http://www.w3.org/2000/svg"
				className="w-full h-full"
				role="img"
			>
				<title>{`Anonymous ${animalName}`}</title>
				{animal.elements}
			</svg>
		</div>
	);
}
