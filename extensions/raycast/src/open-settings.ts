import { runDeepLinkAction } from './lib/deeplink';

export default async function openSettings() {
  await runDeepLinkAction({ open_settings: { page: null } }, 'Open settings dispatched');
}
