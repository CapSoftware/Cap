import { fireSimpleAction } from './utils';

export default async function togglePauseRecording() {
  await fireSimpleAction(
    'toggle_pause_recording',
    'Toggling recording pause…',
    'Recording pause toggled',
  );
}
