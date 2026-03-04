import { dispatchAction } from './utils';
import { showToast, Toast } from '@raycast/api';

export default async function openSettings() {
  await showToast({ style: Toast.Style.Animated, title: 'Opening Cap settings...' });

  await dispatchAction({
    open_settings: {
      page: null,
    },
  });

  await showToast({ style: Toast.Style.Success, title: 'Settings opened' });
}
