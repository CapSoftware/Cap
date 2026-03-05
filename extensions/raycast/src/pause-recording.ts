import { runDeepLinkAction } from './lib/deeplink';

export default async function pauseRecording() {
  await runDeepLinkAction('pause_recording', 'Pause recording dispatched');
}
}
