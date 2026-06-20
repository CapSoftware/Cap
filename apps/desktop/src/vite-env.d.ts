/// <reference types="vinxi/client" />

interface ImportMetaEnv {
	readonly VITE_SERVER_URL: string;
	readonly VITE_SOLID_DEVTOOLS?: string;
	// more env variables...
}

interface ImportMeta {
	readonly env: ImportMetaEnv;
}
