import { fireSimpleAction } from './utils';

export default async function pauseRecording() {
  await fireSimpleAction('pause_recording', 'Recording paused');
}
