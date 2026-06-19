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

## Transcode script

Converts your library to browser-compatible H.264/AAC MP4 in-place, and extracts or converts embedded/external subtitles to WebVTT.

```bash
npm run transcode -- /path/to/library
```

Requires `ffmpeg` and `ffprobe` (`brew install ffmpeg` on macOS). Files that are already H.264 + AAC in an MP4 container are skipped; others are remuxed or re-encoded as needed.

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start the server with `tsx` |
| `npm start` | Build the client bundle then start the server |
| `npm run build` | Build `src/app.ts` → `public/app.js` only |
| `npm run transcode -- <path>` | Transcode a library directory to web-compatible MP4 |
