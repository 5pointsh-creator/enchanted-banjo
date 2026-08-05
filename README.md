# The Enchanted Banjo

An interactive, playable banjo built on top of a forest photo. Pluck the glowing
strings, strum, or play chords — every note is generated live in the browser with
Karplus–Strong plucked-string synthesis (WebAudio), so strings ring and decay like
real steel rather than playing a canned clip.

## Play

- **Click / tap** a glowing string to pluck it.
- **Drag** across the strings to swipe-strum.
- **Keyboard:** `A` `S` `D` `F` pluck the four strings, `Space` strums,
  `G` `C` `D` play chords.
- **Buttons** under the banjo: Strum and G / C / D / Em chords.

On mobile, tap once to enable sound (browser autoplay policy), then play.

## Run locally

It's a static page — no build step. Just serve the folder:

```bash
# any static server works, e.g.
python3 -m http.server 8000
# then open http://localhost:8000
```

Or open `index.html` directly in a browser.

## Files

- `index.html` — the whole app: markup, styling, string overlay and audio engine.
- `banjo.jpg` — the banjo/forest artwork the instrument is built on.

## How it works

The banjo photo sits under an SVG overlay whose coordinate space matches the image
(`viewBox="0 0 1024 1536"`), so the interactive strings line up with the real strings
at any screen size. Each string has a wide invisible hit-zone for easy tapping and a
thin glowing wire that visibly vibrates when played. Audio is a Karplus–Strong model:
a short noise burst fed through a tuned delay + low-pass feedback loop, one buffer per
pluck, shaped by a decay envelope.
