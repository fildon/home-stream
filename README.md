# home-stream

A local-network media streaming server. Point it at a folder of videos and open the URL on any device on your network to browse and play them in the browser.

## Features

- Poster grid with artwork fetched from TMDB (optional)
- Breadcrumb navigation into subdirectories
- Native browser video player with subtitle support (VTT)
- Single-file folders auto-play without an extra click
- Path-traversal protection on all file routes

## Requirements

- Node.js 22+
- (Optional) ffmpeg + ffprobe — only needed for the transcode script

## Setup

```bash
npm install
```

Create a `.env` file:

```
LIBRARY_PATH=/path/to/your/media
TMDB_API_KEY=your_tmdb_api_key   # optional — enables poster art
PORT=8080                         # optional — defaults to 8080
```

## Usage

```bash
npm run dev     # start server (no build step)
npm start       # build client bundle then start server
```

Open the **Network** URL printed in the terminal on any device on the same network.

## Library structure

The server serves `.mp4` and `.webm` files. Suggested layout:

```
media/
  Movies/
    The Matrix (1999)/
      The.Matrix.1999.mp4
      The.Matrix.1999.en.vtt   # subtitles (WebVTT)
  TV Shows/
    Breaking Bad/
      Season 1/
        S01E01.mp4
```

Top-level folder names containing `movie`/`film` are treated as movies for TMDB lookups; names containing `tv`/`show`/`series`/`anime` are treated as TV shows.

## Adding new content

This library's existing shows and movies follow a stricter convention than the server strictly requires — keep new additions consistent with it:

```
TV/
  Show Name (Year)/
    Season 01/
      Show Name S01E01 Episode Title.ext
Movies/
  Movie Name (Year)/
    Movie Name (Year).ext
```

- **Folder name**: `Show Name (Year)` / `Movie Name (Year)`, year is the original release year.
- **Season folder**: `Season 01`, zero-padded, one per season.
- **Episode filename**: `Show Name S01E01 Episode Title.ext` — always include the episode title, matching the rest of the library.
- **Subtitles**: WebVTT files next to the video (not in a `Subs/` subfolder — those aren't found), named `<video name>.<language>[.sdh|.forced][.N].vtt`, e.g. `Show Name S01E01 Title.eng.vtt`, `….eng.sdh.vtt`. The language is an ISO code (`en`/`eng`, or a regional tag like `es-419`); the player shows these as "English", "English (SDH)", "Latin American Spanish", etc. The transcode script extracts embedded subtitles with these names automatically, telling plain, SDH and forced tracks apart.
- **Filename characters**: avoid characters that aren't valid in Windows filenames (`\ / : * ? " < > |`) — drop them from titles that contain them (e.g. `What's for Dinner?` → `What's for Dinner`).
- **Codec**: video must be H.264; audio must be AAC (stereo or mono). Many downloaded/ripped files use AC3, DTS, or 5.1 audio, which browsers can't play back in `<video>` — check before adding to the library:

  ```bash
  ffprobe -v error -select_streams a:0 -show_entries stream=codec_name,channels -of csv=p=0 "path/to/file.mp4"
  ```

  If it isn't `aac` with ≤2 channels, run the transcode script (see below).

**Before running the transcode script on new content, preview it with `--dry-run` first** — it prints what each file would become without touching anything, so you can sanity-check its plan before committing to a real (slow, in-place) run.

## Transcode script

Converts your library to browser-compatible H.264/AAC MP4 in-place, and extracts or converts embedded/external subtitles to WebVTT.

```bash
npm run transcode -- /path/to/library --dry-run   # preview only, changes nothing
npm run transcode -- /path/to/library              # actually convert
```

Requires `ffmpeg` and `ffprobe` (`brew install ffmpeg` on macOS). Files that are already H.264 + AAC in an MP4 container are skipped; others are remuxed or re-encoded as needed.

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start the server with `tsx` |
| `npm start` | Build the client bundle then start the server |
| `npm run build` | Build `src/app.ts` → `public/app.js` only |
| `npm run transcode -- <path>` | Transcode a library directory to web-compatible MP4 |
