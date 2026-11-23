# Scripted meeting fixture

`you.opus` (the microphone side), `others.opus` (the call side) and `truth.json`
(who said what, when) make a two minute meeting with three people for
`.github/workflows/meetings-reliability.yml`.

The speech is from the LibriSpeech ASR corpus (test-clean), by Vassil Panayotov,
Guoguo Chen, Daniel Povey and Sanjeev Khudanpur, licensed under CC BY 4.0
(https://www.openslr.org/12). Utterances from three of its speakers were levelled
and arranged into turns; the words in `truth.json` are the corpus transcripts.
