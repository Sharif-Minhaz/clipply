import type { DesktopApi } from '../../electron/shared/api';

declare global {
  interface Window {
    clipply: DesktopApi;
  }
}
