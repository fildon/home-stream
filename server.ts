import express from "express";
import http from "http";
import fs from "fs";
import path from "path";
import os from "os";

// ── Env ──────────────────────────────────────────────────────────────────────

try {
  const raw = fs.readFileSync(path.join(__dirname, ".env"), "utf8");
  for (const line of raw.split("\n")) {
    const m = line.match(/^([^#=][^=]*)=(.*)$/);
    if (m) process.env[m[1].trim()] ??= m[2].trim();
  }
} catch {
  // no .env file
}

const PORT = parseInt(process.env.PORT ?? "8080", 10);
const LIBRARY_PATH = process.env.LIBRARY_PATH;
const TMDB_API_KEY = process.env.TMDB_API_KEY;

if (!LIBRARY_PATH) {
  console.error(
    "\nError: LIBRARY_PATH is not set.\n" +
      "  Set it in a .env file:  LIBRARY_PATH=/path/to/your/media\n" +
      "  Or inline:              LIBRARY_PATH=/path/to/media npm start\n",
  );
  process.exit(1);
}

if (!fs.existsSync(LIBRARY_PATH)) {
  console.error(`\nError: LIBRARY_PATH does not exist: ${LIBRARY_PATH}\n`);
  process.exit(1);
}

const LIBRARY_ROOT = path.resolve(LIBRARY_PATH);
const CACHE_DIR = path.join(__dirname, ".cache");
fs.mkdirSync(CACHE_DIR, { recursive: true });

// ── Types ────────────────────────────────────────────────────────────────────

type FileEntry = { type: "file"; name: string; path: string; size: number };
type DirEntry = { type: "dir"; name: string; path: string; children: Entry[] };
type Entry = FileEntry | DirEntry;

type ArtworkResult = {
  title: string;
  year: string;
  overview: string;
  posterUrl: string;
  mediaType: "movie" | "tv";
};

interface TMDBResult {
  id: number;
  title?: string;
  name?: string;
  release_date?: string;
  first_air_date?: string;
  overview?: string;
  poster_path?: string | null;
}

// ── Library helpers ───────────────────────────────────────────────────────────

const VIDEO_EXTS = new Set([".mp4", ".webm"]);
const SUBTITLE_EXTS = new Set([".vtt"]);

function buildLibraryTree(dir: string): DirEntry {
  const name = path.basename(dir);
  const relPath = path.relative(LIBRARY_ROOT, dir);
  const children: Entry[] = [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { type: "dir", name, path: relPath, children };
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      const sub = buildLibraryTree(fullPath);
      if (sub.children.length > 0) children.push(sub);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (VIDEO_EXTS.has(ext)) {
        const stat = fs.statSync(fullPath);
        children.push({
          type: "file",
          name: entry.name,
          path: path.relative(LIBRARY_ROOT, fullPath),
          size: stat.size,
        });
      }
    }
  }

  return { type: "dir", name, path: relPath, children };
}

function getSubtitlesForVideo(videoRelPath: string): string[] {
  const absVideo = path.join(LIBRARY_ROOT, videoRelPath);
  const dir = path.dirname(absVideo);
  const stem = path.basename(absVideo, path.extname(absVideo));
  const results: string[] = [];

  try {
    for (const entry of fs.readdirSync(dir)) {
      const ext = path.extname(entry).toLowerCase();
      if (!SUBTITLE_EXTS.has(ext)) continue;
      const entryStem = path.basename(entry, ext);
      if (entryStem === stem || entryStem.startsWith(stem + ".")) {
        results.push(path.relative(LIBRARY_ROOT, path.join(dir, entry)));
      }
    }
  } catch {
    // unreadable dir
  }

  return results;
}

function safe(relPath: string): string | null {
  const abs = path.resolve(LIBRARY_ROOT, relPath);
  return abs.startsWith(LIBRARY_ROOT + path.sep) || abs === LIBRARY_ROOT
    ? abs
    : null;
}

// ── TMDB / artwork helpers ────────────────────────────────────────────────────

const TV_KEYWORDS = /\b(tv|shows?|series|television|anime)\b/i;
const MOVIE_KEYWORDS = /\b(movies?|films?|cinema)\b/i;

function inferMediaType(firstSegment: string): "movie" | "tv" {
  if (TV_KEYWORDS.test(firstSegment)) return "tv";
  if (MOVIE_KEYWORDS.test(firstSegment)) return "movie";
  return "movie"; // default
}

function cleanTitle(name: string): string {
  return name
    .replace(/\.(mp4|mkv|avi|webm|mov|wmv|m4v|ts|flv)$/i, "")
    .replace(/\bS\d+E\d+\b.*/i, "")
    .replace(/\(\d{4}\)/g, "")
    .replace(/\b(1080p|720p|480p|4K|2160p|UHD|BluRay|BDRip|WEBRip|WEB-DL|HDRip|DVDRip|HDTV|REMASTERED)\b.*/i, "")
    .replace(/[._-]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function extractYear(name: string): string | null {
  const m = name.match(/\b(19|20)\d{2}\b/);
  return m ? m[0] : null;
}

function slugify(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

const TMDB_API_BASE = "https://api.themoviedb.org/3";
const TMDB_IMG_BASE = "https://image.tmdb.org/t/p/w500";

async function searchTMDB(
  title: string,
  year: string | null,
  type: "movie" | "tv",
): Promise<TMDBResult | null> {
  const params = new URLSearchParams({ api_key: TMDB_API_KEY!, query: title });
  if (year && type === "movie") params.set("year", year);
  const endpoint = type === "movie" ? "search/movie" : "search/tv";
  try {
    const res = await fetch(`${TMDB_API_BASE}/${endpoint}?${params}`);
    if (!res.ok) return null;
    const data = (await res.json()) as { results?: TMDBResult[] };
    return data.results?.[0] ?? null;
  } catch {
    return null;
  }
}

async function downloadPoster(posterPath: string, destPath: string): Promise<void> {
  const res = await fetch(`${TMDB_IMG_BASE}${posterPath}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  fs.writeFileSync(destPath, Buffer.from(await res.arrayBuffer()));
}

async function getOrFetchArtwork(relPath: string): Promise<ArtworkResult | null> {
  const segments = relPath.split("/").filter(Boolean);
  if (segments.length < 2) return null;

  const [topDir, entityName] = segments;
  const mediaType = inferMediaType(topDir);
  const title = cleanTitle(entityName);
  const year = extractYear(entityName);

  if (!title) return null;

  const cacheKey = `${slugify(title)}-${year ?? "x"}-${mediaType}`;
  const cacheJson = path.join(CACHE_DIR, `${cacheKey}.json`);
  const cacheJpg = path.join(CACHE_DIR, `${cacheKey}.jpg`);

  if (fs.existsSync(cacheJson)) {
    const cached = JSON.parse(fs.readFileSync(cacheJson, "utf8"));
    return Object.keys(cached).length > 0 ? (cached as ArtworkResult) : null;
  }

  if (!TMDB_API_KEY) return null;

  const result = await searchTMDB(title, year, mediaType);

  if (!result?.poster_path) {
    fs.writeFileSync(cacheJson, "{}"); // sentinel: tried, no result
    return null;
  }

  try {
    await downloadPoster(result.poster_path, cacheJpg);
  } catch {
    fs.writeFileSync(cacheJson, "{}");
    return null;
  }

  const artwork: ArtworkResult = {
    title: result.title ?? result.name ?? title,
    year: String(result.release_date ?? result.first_air_date ?? "").slice(0, 4),
    overview: result.overview ?? "",
    posterUrl: `/artwork/${cacheKey}.jpg`,
    mediaType,
  };

  fs.writeFileSync(cacheJson, JSON.stringify(artwork));
  return artwork;
}

// ── Startup banner ────────────────────────────────────────────────────────────

function getLocalIPs(): string[] {
  const nets = os.networkInterfaces();
  const ips: string[] = [];
  for (const iface of Object.values(nets)) {
    if (!iface) continue;
    for (const cfg of iface) {
      if (cfg.family === "IPv4" && !cfg.internal) ips.push(cfg.address);
    }
  }
  return ips;
}

function printBanner(port: number): void {
  const ips = getLocalIPs();
  const urls: [string, string][] = [["Local  ", `http://localhost:${port}`]];
  for (const ip of ips) urls.push(["Network", `http://${ip}:${port}`]);

  const contentWidth =
    Math.max(
      "home-stream is running!".length,
      ...urls.map(([l, u]) => `${l}  ${u}`.length),
    ) + 4;

  const line = "═".repeat(contentWidth + 2);
  const pad = (s: string) => s + " ".repeat(Math.max(0, contentWidth - s.length));

  console.log("");
  console.log(`  ╔${line}╗`);
  console.log(`  ║ ${pad("  home-stream is running!")} ║`);
  console.log(`  ╠${line}╣`);
  for (const [label, url] of urls) {
    console.log(`  ║ ${pad(` ${label}  ${url}`)} ║`);
  }
  console.log(`  ╚${line}╝`);
  console.log("");
  console.log(`  Library: ${LIBRARY_ROOT}`);
  if (!TMDB_API_KEY) {
    console.log("  Artwork: disabled (add TMDB_API_KEY to .env to enable)");
  }
  console.log("  Open the Network URL on your laptop to browse.\n");
}

// ── Express ───────────────────────────────────────────────────────────────────

const app = express();

app.use(express.static(path.join(__dirname, "public")));
app.use("/artwork", express.static(CACHE_DIR));

app.get("/api/library", (_req, res) => {
  try {
    res.json(buildLibraryTree(LIBRARY_ROOT));
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get("/api/subtitles", (req, res) => {
  const videoPath = req.query["path"] as string | undefined;
  if (!videoPath) {
    res.status(400).json({ error: "path query parameter required" });
    return;
  }
  if (!safe(videoPath)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  res.json(getSubtitlesForVideo(videoPath));
});

app.get("/api/artwork", async (req, res) => {
  const relPath = req.query["path"] as string | undefined;
  if (!relPath) {
    res.status(400).json({ error: "path required" });
    return;
  }
  if (!safe(relPath)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  try {
    const artwork = await getOrFetchArtwork(relPath);
    res.json(artwork);
  } catch (err) {
    console.error("artwork error:", err);
    res.json(null);
  }
});

app.use(
  "/files",
  (req, _res, next) => {
    const abs = safe(decodeURIComponent(req.path.slice(1)));
    if (!abs) {
      _res.status(403).send("Forbidden");
      return;
    }
    next();
  },
  express.static(LIBRARY_ROOT, { dotfiles: "deny" }),
);

// ── Start ─────────────────────────────────────────────────────────────────────

const server = http.createServer(app);

server.listen(PORT, "0.0.0.0", () => printBanner(PORT));

process.on("SIGINT", () => server.close(() => process.exit(0)));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
