/// <reference types="electron-vite/node" />

/** Build-time configuration (apps/desktop/.env, see .env.example). Unset = sync disabled. */
interface ImportMetaEnv {
  readonly MAIN_VITE_API_URL?: string;
  readonly MAIN_VITE_GOOGLE_CLIENT_ID?: string;
  readonly MAIN_VITE_GOOGLE_CLIENT_SECRET?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
