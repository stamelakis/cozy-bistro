Background music tracks live here.

Expected files (drop them in, then `git add public/audio/*.mp3 && git push`):

- `daytime.mp3`   — played while the in-game day is between dawn and dusk (~0.05–0.80 of the day cycle)
- `nighttime.mp3` — played at night (the rest)

Loaded via `<audio>` in `src/ui/SfxPlayer.ts`. Missing files = silence (no error in console).

Loop is set on the audio element, so the tracks should be designed to loop cleanly. MP3 is fine; WAV/OGG also work but MP3 ships the smallest payload for the same perceived quality.
