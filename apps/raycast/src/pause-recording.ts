import { fireSimpleAction } from './utils';

export default async function pauseRecording() {
  await fireSimpleAction('pause_recording', 'Pausing recording…', 'Recording paused');
}
