import { execFileSync, spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

// ── Env ──────────────────────────────────────────────────────────────────────

try {
  const raw = fs.readFileSync(path.join(__dirname, "..", ".env"), "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const stripped = line.replace(/^﻿/, "");
    if (stripped.startsWith("#") || !stripped.includes("=")) continue;
    const eq = stripped.indexOf("=");
    const key = stripped.slice(0, eq).trim();
    const val = stripped.slice(eq + 1).trim();
    if (key) process.env[key] ??= val;
  }
} catch {
  // no .env file
}

// ── Config ───────────────────────────────────────────────────────────────────

const VIDEO_EXTS = new Set([
  ".mkv", ".avi", ".mov", ".wmv", ".m4v", ".ts", ".flv", ".mp4", ".webm",
]);
const SUBTITLE_EXTS = new Set([".srt", ".ass", ".ssa"]);

// ── Types ────────────────────────────────────────────────────────────────────

interface Stream {
  codec_type: string;
  codec_name: string;
  index: number;
  channels?: number;
  tags?: { language?: string; title?: string };
  disposition?: { forced?: number; hearing_impaired?: number };
}

interface ProbeResult {
  streams: Stream[];
}

type Action = "skip" | "remux" | "transcode-audio" | "transcode-video";

// ── ffprobe ──────────────────────────────────────────────────────────────────

function probe(filePath: string): ProbeResult {
  const out = execFileSync(
    "ffprobe",
    ["-v", "quiet", "-print_format", "json", "-show_streams", filePath],
    { encoding: "utf8" },
  );
  return JSON.parse(out) as ProbeResult;
}

function decideAction(result: ProbeResult, filePath: string): Action {
  const ext = path.extname(filePath).toLowerCase();
  const video = result.streams.find((s) => s.codec_type === "video");
  const audio = result.streams.find((s) => s.codec_type === "audio");

  if (!video) return "skip";

  const h264 = video.codec_name === "h264";
  const aac = !audio || (audio.codec_name === "aac" && (audio.channels ?? 0) <= 2);
  const mp4 = ext === ".mp4";

  if (h264 && aac && (mp4 || ext === ".mkv")) return "skip";
  if (h264 && aac) return "remux";
  if (h264 && !aac) return "transcode-audio";
  return "transcode-video";
}

// ── Subtitle helpers ─────────────────────────────────────────────────────────

// Image-based (Blu-ray/DVD) subtitle formats can't be converted to WebVTT
// text without OCR.
const IMAGE_SUBTITLE_CODECS = new Set(["hdmv_pgs_subtitle", "dvd_subtitle", "dvb_subtitle", "xsub"]);

type SubtitleKind = "plain" | "sdh" | "forced";

interface SubtitleTrack {
  streamIndex: number; // position among the file's subtitle streams (0:s:N)
  codec: string;
  lang: string;
  stream: Stream;
  vtt?: string;
  kind?: SubtitleKind;
}

// Extracted subtitles are named <stem>.<lang>[.sdh|.forced][.N].vtt, built
// only from the language tag and a fixed vocabulary, never from a track's
// title (which tends to carry release-group junk). The client turns these
// suffixes into labels like "English (SDH)".
function extractEmbeddedSubtitles(filePath: string, result: ProbeResult, dryRun: boolean): void {
  const dir = path.dirname(filePath);
  const stem = path.basename(filePath, path.extname(filePath));
  const subStreams = result.streams.filter((s) => s.codec_type === "subtitle");

  const tracks: SubtitleTrack[] = [];
  subStreams.forEach((s, i) => {
    if (IMAGE_SUBTITLE_CODECS.has(s.codec_name)) {
      console.log(`    subtitle: stream ${i} is image-based (${s.codec_name}), can't convert to text, skipping`);
      return;
    }
    const lang = s.tags?.language;
    tracks.push({
      streamIndex: i,
      codec: s.codec_name,
      lang: lang && lang !== "unk" ? lang : "und",
      stream: s,
    });
  });

  // Skip a language entirely once it has at least as many subtitle files
  // beside the video as it has tracks, i.e. it was already extracted.
  const existing = fs.readdirSync(dir).filter((f) => f.startsWith(stem + ".") && f.endsWith(".vtt"));
  const byLang = new Map<string, SubtitleTrack[]>();
  for (const t of tracks) byLang.set(t.lang, [...(byLang.get(t.lang) ?? []), t]);
  const existingFor = (lang: string) =>
    existing.filter((f) => sameLanguage(f.slice(stem.length + 1).split(".")[0], lang));
  const pending: SubtitleTrack[] = [];
  for (const [lang, group] of byLang) {
    if (existingFor(lang).length >= group.length) {
      console.log(`    subtitle: ${lang} already extracted, skipping`);
    } else {
      pending.push(...group);
    }
  }
  if (pending.length === 0) return;

  // Extraction only reads the video, so it runs in dry-run mode too: the
  // track contents are needed to decide the names.
  readSubtitleTracks(filePath, pending);
  const readable = pending.filter((t) => {
    if (t.vtt === undefined) console.log(`    subtitle: stream ${t.streamIndex} (${t.codec}) could not be converted, skipping`);
    return t.vtt !== undefined;
  });

  for (const lang of byLang.keys()) {
    const langTracks = readable.filter((t) => t.lang === lang);
    classifySubtitleTracks(langTracks);
    const used = new Set<string>();
    const outNames = langTracks.map((t) => {
      const base = t.kind === "plain" ? lang : `${lang}.${t.kind}`;
      let suffix = base;
      for (let n = 2; used.has(suffix); n++) suffix = `${base}.${n}`;
      used.add(suffix);
      return `${stem}.${suffix}.vtt`;
    });

    // Older versions of this script wrote only the first track of each
    // language, always as <stem>.<lang>.vtt, so that file may really hold
    // e.g. the SDH track. If an existing file's content matches a track with
    // a different name, rename it rather than writing a duplicate.
    const renamed = new Set<string>(); // old names now free to reuse
    const renamedTo = new Set<string>();
    langTracks.forEach((t, i) => {
      if (fs.existsSync(path.join(dir, outNames[i]))) return;
      const match = existingFor(lang).find(
        (f) => !renamed.has(f) && sameSubtitles(fs.readFileSync(path.join(dir, f), "utf8"), t.vtt!),
      );
      if (!match || match === outNames[i]) return;
      console.log(`    subtitle: ${dryRun ? "would rename" : "renaming"} ${match} → ${outNames[i]} (it holds the ${t.kind} track)`);
      if (!dryRun) fs.renameSync(path.join(dir, match), path.join(dir, outNames[i]));
      renamed.add(match);
      renamedTo.add(outNames[i]);
    });

    for (let i = 0; i < langTracks.length; i++) {
      const t = langTracks[i];
      const outName = outNames[i];
      const outPath = path.join(dir, outName);
      if (renamedTo.has(outName)) continue;
      if (fs.existsSync(outPath) && !(dryRun && renamed.has(outName))) {
        console.log(`    subtitle: ${outName} already exists, skipping`);
        continue;
      }
      if (dryRun) {
        console.log(`    subtitle: would extract stream ${t.streamIndex} (${t.codec}, ${t.kind}) → ${outName}`);
        continue;
      }
      console.log(`    subtitle: extracting stream ${t.streamIndex} (${t.codec}, ${t.kind}) → ${outName}`);
      fs.writeFileSync(outPath, t.vtt!);
    }
  }
}

// Converts the given tracks to WebVTT in memory (t.vtt), in a single ffmpeg
// pass over the video where possible; falls back to one track at a time if
// the combined pass fails, so one bad track doesn't lose the others.
function readSubtitleTracks(filePath: string, tracks: SubtitleTrack[]): void {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "subs-"));
  const tmpPath = (t: SubtitleTrack) => path.join(tmpDir, `${t.streamIndex}.vtt`);
  const run = (ts: SubtitleTrack[]) =>
    spawnSync(
      "ffmpeg",
      ["-v", "error", "-i", filePath, ...ts.flatMap((t) => ["-map", `0:s:${t.streamIndex}`, "-c:s", "webvtt", "-y", tmpPath(t)])],
      { stdio: "pipe" },
    ).status === 0;

  try {
    const ok = run(tracks);
    for (const t of tracks) {
      if (ok || run([t])) t.vtt = fs.readFileSync(tmpPath(t), "utf8");
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// Compares language codes by meaning, so "en" and "eng" match, as do
// the older 3-letter forms like "fre"/"fr".
function sameLanguage(a: string, b: string): boolean {
  const canonical = (code: string) => {
    try {
      return Intl.getCanonicalLocales(code)[0].toLowerCase();
    } catch {
      return code.toLowerCase(); // not a valid language tag
    }
  };
  return canonical(a) === canonical(b);
}

function sameSubtitles(a: string, b: string): boolean {
  const normalize = (s: string) => s.replace(/\r\n/g, "\n").trim();
  return normalize(a) === normalize(b);
}

// The text lines of each cue in a WebVTT file.
function cueLines(vtt: string): string[][] {
  return vtt
    .split(/\r?\n\r?\n/)
    .filter((block) => block.includes("-->"))
    .map((block) => block.split(/\r?\n/).filter((line) => !line.includes("-->")));
}

// SDH subtitles describe non-dialogue sound, e.g. "[door slams]" or
// "(sighs)", at the start of a line. Plain dialogue subtitles don't:
// measured on this library, plain tracks have 0% of cues like this, SDH
// tracks 5-45%. Non-English tracks sometimes put translated on-screen text
// in parentheses, "(Queens, Earth-65)", which reached 3.4%, hence the 4%
// threshold. (Speaker labels like "CAROL:" aren't counted; some plain
// tracks use them too.)
const SOUND_CUE_LINE = /^-?\s*(<[^>]+>)*\s*[[(]/;
const SDH_MIN_SOUND_CUE_RATIO = 0.04;
// Forced subtitles only cover foreign-language lines and on-screen text, so
// they're far shorter than a full track in the same language.
const FORCED_MAX_CUE_RATIO = 0.25;

// Sets t.kind for tracks sharing one language. Explicit metadata (the
// forced / hearing-impaired flags, or those words in the track title) wins;
// otherwise the kind is inferred from the subtitle text.
function classifySubtitleTracks(tracks: SubtitleTrack[]): void {
  const cues = tracks.map((t) => cueLines(t.vtt!));
  const maxCues = Math.max(0, ...cues.map((c) => c.length));

  tracks.forEach((t, i) => {
    const title = t.stream.tags?.title ?? "";
    const flags = t.stream.disposition ?? {};
    const soundCues = cues[i].filter((lines) => lines.some((line) => SOUND_CUE_LINE.test(line))).length;

    if (flags.forced || /forced/i.test(title)) {
      t.kind = "forced";
    } else if (flags.hearing_impaired || /\bsdh\b|\bcc\b|hearing/i.test(title)) {
      t.kind = "sdh";
    } else if (tracks.length > 1 && cues[i].length < maxCues * FORCED_MAX_CUE_RATIO) {
      t.kind = "forced";
    } else if (cues[i].length > 0 && soundCues / cues[i].length >= SDH_MIN_SOUND_CUE_RATIO) {
      t.kind = "sdh";
    } else {
      t.kind = "plain";
    }
  });
}

function convertExternalSubtitle(filePath: string, dryRun: boolean): void {
  const dir = path.dirname(filePath);
  const stem = path.basename(filePath, path.extname(filePath));
  const outPath = path.join(dir, `${stem}.vtt`);

  if (fs.existsSync(outPath)) {
    console.log(`  ${path.basename(filePath)} → already converted, skipping`);
    return;
  }

  if (dryRun) {
    console.log(`  ${path.basename(filePath)} → would convert`);
    return;
  }

  process.stdout.write(`  ${path.basename(filePath)} → converting... `);
  const r = spawnSync("ffmpeg", ["-i", filePath, "-y", outPath], {
    stdio: "pipe",
  });

  if (r.status !== 0) {
    console.log("failed");
    try { fs.unlinkSync(outPath); } catch { /* may not exist */ }
  } else {
    console.log("done");
  }
}

// ── Transcode ────────────────────────────────────────────────────────────────

function ffmpegArgs(input: string, output: string, action: Action): string[] {
  const base = ["-i", input, "-map", "0:v", "-map", "0:a?", "-y"];
  switch (action) {
    case "remux":
      return [...base, "-c", "copy", "-movflags", "+faststart", output];
    case "transcode-audio":
      return [...base, "-c:v", "copy", "-c:a", "aac", "-ac", "2", "-movflags", "+faststart", output];
    case "transcode-video":
      return [
        ...base,
        "-c:v", "libx264", "-crf", "20", "-preset", "medium",
        "-c:a", "aac", "-ac", "2",
        "-movflags", "+faststart",
        output,
      ];
    default:
      throw new Error(`unexpected action: ${action}`);
  }
}

function transcodeFile(filePath: string, action: Action, result: ProbeResult, dryRun: boolean): boolean {
  const dir = path.dirname(filePath);
  const stem = path.basename(filePath, path.extname(filePath));
  const outPath = path.join(dir, `${stem}.mp4`);
  const tmpPath = path.join(dir, `.${stem}.tmp.mp4`);

  // Extract subtitles while the original is still available
  extractEmbeddedSubtitles(filePath, result, dryRun);

  if (dryRun) return true;

  const args = ffmpegArgs(filePath, tmpPath, action);
  console.log(`    running ffmpeg (${action})...`);
  const r = spawnSync("ffmpeg", args, { stdio: "inherit" });

  if (r.status !== 0) {
    console.error(`    ERROR: ffmpeg exited with code ${r.status}`);
    try { fs.unlinkSync(tmpPath); } catch { /* may not exist */ }
    return false;
  }

  fs.renameSync(tmpPath, outPath);

  // Delete the original if it had a different extension
  if (filePath !== outPath) {
    fs.unlinkSync(filePath);
  }

  return true;
}

// ── File walker ──────────────────────────────────────────────────────────────

function collectFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...collectFiles(full));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

// ── Main ─────────────────────────────────────────────────────────────────────

function main(): void {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const libraryPath = args.find((a) => !a.startsWith("--")) ?? process.env.LIBRARY_PATH;

  if (!libraryPath) {
    console.error(
      "\nError: LIBRARY_PATH is not set.\n" +
        "  Set it in a .env file:  LIBRARY_PATH=/path/to/your/media\n" +
        "  Or inline:              LIBRARY_PATH=/path/to/media npm run transcode\n" +
        "  Or as an argument:      npm run transcode -- /path/to/library\n" +
        "  Add --dry-run to preview actions without changing any files.\n",
    );
    process.exit(1);
  }

  if (dryRun) {
    console.log("\n[dry run] No files will be changed.");
  }

  if (!fs.existsSync(libraryPath)) {
    console.error(`Error: directory not found: ${libraryPath}`);
    process.exit(1);
  }

  // Verify ffmpeg/ffprobe are available
  for (const bin of ["ffprobe", "ffmpeg"]) {
    try {
      execFileSync(bin, ["-version"], { stdio: "pipe" });
    } catch {
      console.error(`Error: '${bin}' not found. Install with: brew install ffmpeg`);
      process.exit(1);
    }
  }

  console.log(`\nScanning: ${path.resolve(libraryPath)}\n`);

  const allFiles = collectFiles(libraryPath);
  const videoFiles = allFiles.filter((f) =>
    VIDEO_EXTS.has(path.extname(f).toLowerCase()),
  );
  const subtitleFiles = allFiles.filter((f) =>
    SUBTITLE_EXTS.has(path.extname(f).toLowerCase()),
  );

  console.log(
    `Found ${videoFiles.length} video file(s) and ${subtitleFiles.length} external subtitle file(s)\n`,
  );

  // ── Process videos ────────────────────────────────────────────────────────

  let skipped = 0;
  let converted = 0;
  let failed = 0;

  for (let i = 0; i < videoFiles.length; i++) {
    const filePath = videoFiles[i];
    const rel = path.relative(libraryPath, filePath);
    const counter = `[${i + 1}/${videoFiles.length}]`;

    let result: ProbeResult;
    try {
      result = probe(filePath);
    } catch {
      console.log(`${counter} ${rel} → ERROR: could not probe, skipping`);
      failed++;
      continue;
    }

    const action = decideAction(result, filePath);

    if (action === "skip") {
      console.log(`${counter} ${rel} → skip`);
      // Still check for unextracted embedded subs on already-compatible files
      extractEmbeddedSubtitles(filePath, result, dryRun);
      skipped++;
      continue;
    }

    console.log(`${counter} ${rel} → ${action}${dryRun ? " (dry-run)" : ""}`);
    const start = Date.now();
    const ok = transcodeFile(filePath, action, result, dryRun);
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);

    if (ok) {
      if (!dryRun) console.log(`    done (${elapsed}s)\n`);
      converted++;
    } else {
      failed++;
    }
  }

  // ── Convert external subtitles ────────────────────────────────────────────

  if (subtitleFiles.length > 0) {
    console.log("\nConverting external subtitle files...\n");
    for (const filePath of subtitleFiles) {
      convertExternalSubtitle(filePath, dryRun);
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────

  console.log(
    dryRun
      ? `\nDry run done. ${skipped} would be skipped, ${converted} would be converted, ${failed} failed to probe.\n`
      : `\nDone. ${skipped} skipped, ${converted} converted, ${failed} failed.\n`,
  );
}

main();
