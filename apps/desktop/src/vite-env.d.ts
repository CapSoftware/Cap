/// <reference types="vinxi/types/client" />

interface ImportMetaEnv {
	readonly VITE_SERVER_URL: string;
	readonly VITE_SOLID_DEVTOOLS?: string;
	readonly VITE_OPENPANEL_CLIENT_ID?: string;
	readonly VITE_OPENPANEL_API_URL?: string;
	// more env variables...
}

interface ImportMeta {
	readonly env: ImportMetaEnv;
}
