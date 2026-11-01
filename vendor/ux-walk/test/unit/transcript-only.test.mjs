import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { processChapter } from '../../src/process.mjs';
import { providerKeyPresent } from '../../src/transcribe.mjs';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ux-walk-transcript-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const media = path.join(dir, 'source.m4a');
  const audio = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.5', '-c:a', 'aac', media], { encoding: 'utf8' });
  assert.equal(audio.status, 0, audio.stderr);
  fs.writeFileSync(path.join(dir, 'chapter.json'), JSON.stringify({ n: 1, name: 'Synthetic', startMs: 1000, endMs: 1500 }));
  return { dir, media };
}

test('source audio produces a cached transcript while chapter video does not exist', async (t) => {
  const { dir, media } = fixture(t);
  const old = process.env.ELEVENLABS_API_KEY;
  process.env.ELEVENLABS_API_KEY = 'synthetic-test-key';
  t.after(() => { if (old === undefined) delete process.env.ELEVENLABS_API_KEY; else process.env.ELEVENLABS_API_KEY = old; });
  let uploads = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    uploads++;
    return new Response(JSON.stringify({ words: [{ type: 'word', text: 'Saved.', start: 0.05, end: 0.3, speaker_id: 'speaker_0' }] }));
  });
  const cfg = { transcriber: 'elevenlabs', glossary: '', sections: false, brief: false };
  const options = { transcriptOnly: true, media, log: () => {} };
  const result = await processChapter(dir, cfg, options);
  assert.equal(result.transcript, true);
  assert.match(fs.readFileSync(path.join(dir, 'transcript.srt'), 'utf8'), /Saved\./);
  assert.equal(fs.existsSync(path.join(dir, 'timeline.md')), false);
  assert.equal(fs.existsSync(path.join(dir, 'summary.json')), false);
  assert.equal(fs.existsSync(path.join(dir, 'shots')), false);
  fs.mkdirSync(path.join(dir, 'shots'));
  const evidence = path.join(dir, 'shots', 'evidence.jpg');
  fs.writeFileSync(evidence, 'saved evidence');
  await processChapter(dir, cfg, { ...options, force: ['shots'] });
  assert.equal(fs.readFileSync(evidence, 'utf8'), 'saved evidence');
  await processChapter(dir, cfg, options);
  assert.equal(uploads, 1);
});

test('disabled transcription never consults a provider in transcript-only processing', async (t) => {
  const { dir, media } = fixture(t);
  t.mock.method(globalThis, 'fetch', () => { throw new Error('unexpected network'); });
  const result = await processChapter(dir, { transcriber: 'none', glossary: '' }, { transcriptOnly: true, media, log: () => {} });
  assert.equal(result.transcript, false);
  assert.equal(fs.existsSync(path.join(dir, 'timeline.md')), false);
});

test('a key is reported present from its environment name, absent otherwise, and never fetched', (t) => {
  const saved = process.env.ASSEMBLYAI_API_KEY, cfg = { transcriber: 'assemblyai', assemblyaiKeychainItem: 'uxw-test-absent-item' };
  t.after(() => { if (saved === undefined) delete process.env.ASSEMBLYAI_API_KEY; else process.env.ASSEMBLYAI_API_KEY = saved; });
  delete process.env.ASSEMBLYAI_API_KEY;
  assert.equal(providerKeyPresent(cfg), false);
  assert.equal(providerKeyPresent({ transcriber: 'unknown' }), false);
  process.env.ASSEMBLYAI_API_KEY = 'synthetic';
  assert.equal(providerKeyPresent(cfg), true);
  const source = fs.readFileSync(new URL('../../src/transcribe.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source.slice(source.indexOf('function providerKeyPresent'), source.indexOf('function transcriberProblem')), /'-w'/);
});
