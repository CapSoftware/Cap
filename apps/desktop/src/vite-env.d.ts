/// <reference types="vinxi/client" />

interface ImportMetaEnv {
	readonly VITE_SERVER_URL: string;
	// more env variables...
}

interface ImportMeta {
	readonly env: ImportMetaEnv;
}
