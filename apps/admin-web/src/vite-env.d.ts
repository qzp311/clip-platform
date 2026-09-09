/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_AUTH_TENANT_ENABLE?: string;
  readonly VITE_AUTH_DEFAULT_LOGIN_TENANT?: string;
  readonly VITE_AUTH_DEFAULT_TENANT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
