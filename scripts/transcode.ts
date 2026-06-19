import { execFileSync, spawnSync } from "child_process";
import fs from "fs";
import path from "path";

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
  tags?: { language?: string };
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
  const aac = !audio || audio.codec_name === "aac";
  const mp4 = ext === ".mp4";

  if (h264 && aac && mp4) return "skip";
  if (h264 && aac) return "remux";
  if (h264 && !aac) return "transcode-audio";
  return "transcode-video";
}

// ── Subtitle helpers ─────────────────────────────────────────────────────────

function extractEmbeddedSubtitles(filePath: string, result: ProbeResult): void {
  const dir = path.dirname(filePath);
  const stem = path.basename(filePath, path.extname(filePath));
  const subs = result.streams.filter((s) => s.codec_type === "subtitle");

  for (let i = 0; i < subs.length; i++) {
    const lang = subs[i].tags?.language;
    const suffix =
      lang && lang !== "und" && lang !== "unk" ? lang : `sub${i}`;
    const outPath = path.join(dir, `${stem}.${suffix}.vtt`);

    if (fs.existsSync(outPath)) {
      console.log(`    subtitle: ${path.basename(outPath)} already exists, skipping`);
      continue;
    }

    console.log(`    subtitle: extracting stream ${i} (${subs[i].codec_name}) → ${path.basename(outPath)}`);
    const r = spawnSync(
      "ffmpeg",
      ["-i", filePath, "-map", `0:s:${i}`, "-c:s", "webvtt", "-y", outPath],
      { stdio: "pipe" },
    );

    if (r.status !== 0) {
      console.log(`    subtitle: extraction failed, skipping`);
      try { fs.unlinkSync(outPath); } catch { /* may not exist */ }
    }
  }
}

function convertExternalSubtitle(filePath: string): void {
  const dir = path.dirname(filePath);
  const stem = path.basename(filePath, path.extname(filePath));
  const outPath = path.join(dir, `${stem}.vtt`);

  if (fs.existsSync(outPath)) {
    console.log(`  ${path.basename(filePath)} → already converted, skipping`);
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
      return [...base, "-c:v", "copy", "-c:a", "aac", "-movflags", "+faststart", output];
    case "transcode-video":
      return [
        ...base,
        "-c:v", "libx264", "-crf", "20", "-preset", "medium",
        "-c:a", "aac",
        "-movflags", "+faststart",
        output,
      ];
    default:
      throw new Error(`unexpected action: ${action}`);
  }
}

function transcodeFile(filePath: string, action: Action, result: ProbeResult): boolean {
  const dir = path.dirname(filePath);
  const stem = path.basename(filePath, path.extname(filePath));
  const outPath = path.join(dir, `${stem}.mp4`);
  const tmpPath = path.join(dir, `.${stem}.tmp.mp4`);

  // Extract subtitles while the original is still available
  extractEmbeddedSubtitles(filePath, result);

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
  const libraryPath = process.argv[2];

  if (!libraryPath) {
    console.error("Usage: npm run transcode -- /path/to/library");
    process.exit(1);
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
      extractEmbeddedSubtitles(filePath, result);
      skipped++;
      continue;
    }

    console.log(`${counter} ${rel} → ${action}`);
    const start = Date.now();
    const ok = transcodeFile(filePath, action, result);
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);

    if (ok) {
      console.log(`    done (${elapsed}s)\n`);
      converted++;
    } else {
      failed++;
    }
  }

  // ── Convert external subtitles ────────────────────────────────────────────

  if (subtitleFiles.length > 0) {
    console.log("\nConverting external subtitle files...\n");
    for (const filePath of subtitleFiles) {
      convertExternalSubtitle(filePath);
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────

  console.log(
    `\nDone. ${skipped} skipped, ${converted} converted, ${failed} failed.\n`,
  );
}

main();
