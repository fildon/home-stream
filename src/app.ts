// ── Types ────────────────────────────────────────────────────────────────────

type FileEntry = { type: "file"; name: string; path: string; size: number };
type DirEntry = { type: "dir"; name: string; path: string; children: Entry[] };
type Entry = FileEntry | DirEntry;

type SortMode = "watched" | "name" | "year" | "length";

type ArtworkResult = {
  title: string;
  year: string;
  overview: string;
  posterUrl: string;
  mediaType: "movie" | "tv";
};

// ── Language labels ───────────────────────────────────────────────────────────

const LANG: Record<string, string> = {
  en: "English", fr: "French", de: "German", es: "Spanish",
  it: "Italian", pt: "Portuguese", nl: "Dutch", ja: "Japanese",
  ko: "Korean", zh: "Chinese", ru: "Russian", ar: "Arabic",
  sv: "Swedish", no: "Norwegian", da: "Danish", fi: "Finnish",
  pl: "Polish", cs: "Czech", hu: "Hungarian", tr: "Turkish",
};

// ── Browser detection ─────────────────────────────────────────────────────────

const isChromiumBased = /Chrome\/\d/.test(navigator.userAgent);

// ── State ─────────────────────────────────────────────────────────────────────

let libraryData: DirEntry | null = null;
let navStack: DirEntry[] = [];
let watchedData: Record<string, boolean> = {};
let currentPlayingPath: string | null = null;
let sortMode: SortMode = "watched";

function currentDir(): DirEntry | null {
  if (!libraryData) return null;
  return navStack.length > 0 ? navStack[navStack.length - 1] : libraryData;
}

// ── Watched tracking ──────────────────────────────────────────────────────────

function isWatched(path: string): boolean {
  return !!watchedData[path];
}

function collectFilePaths(entry: Entry): string[] {
  if (entry.type === "file") return [entry.path];
  return entry.children.flatMap(collectFilePaths);
}

async function setWatched(path: string, watched: boolean): Promise<void> {
  if (watched) watchedData[path] = true;
  else delete watchedData[path];

  try {
    await fetch("/api/watched", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, watched }),
    });
  } catch {
    // best-effort — local state is already updated
  }
}

// ── Sorting ───────────────────────────────────────────────────────────────────

function extractYear(name: string): number | null {
  const m = name.match(/\((\d{4})\)/);
  return m ? parseInt(m[1], 10) : null;
}

function collectTotalSize(entry: Entry): number {
  if (entry.type === "file") return entry.size;
  return entry.children.reduce((sum, c) => sum + collectTotalSize(c), 0);
}

// 0 = in-progress, 1 = unwatched, 2 = fully watched
function watchStatusRank(entry: Entry): number {
  const paths = collectFilePaths(entry);
  const watchedCount = paths.filter(isWatched).length;
  if (watchedCount === 0) return 1;
  if (watchedCount === paths.length) return 2;
  return 0;
}

function nameCmp(a: Entry, b: Entry): number {
  return displayName(a.name).localeCompare(displayName(b.name), undefined, {
    sensitivity: "base",
    numeric: true,
  });
}

function yearCmp(a: Entry, b: Entry): number {
  const ay = extractYear(a.name);
  const by = extractYear(b.name);
  if (ay === null && by === null) return 0;
  if (ay === null) return 1;
  if (by === null) return -1;
  return ay - by;
}

function lengthCmp(a: Entry, b: Entry): number {
  return collectTotalSize(a) - collectTotalSize(b);
}

function statusCmp(a: Entry, b: Entry): number {
  return watchStatusRank(a) - watchStatusRank(b);
}

function sortEntries(entries: Entry[], mode: SortMode): Entry[] {
  const primary =
    mode === "name" ? nameCmp : mode === "year" ? yearCmp : mode === "length" ? lengthCmp : statusCmp;

  return [...entries].sort((a, b) => {
    const p = primary(a, b);
    if (p !== 0) return p;
    if (primary !== nameCmp) {
      const n = nameCmp(a, b);
      if (n !== 0) return n;
    }
    if (primary !== yearCmp) {
      const y = yearCmp(a, b);
      if (y !== 0) return y;
    }
    return 0;
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatSize(bytes: number): string {
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function displayName(name: string): string {
  return name.replace(/\.(mp4|webm|mkv)$/i, "");
}

function stem(filePath: string): string {
  const base = filePath.split("/").pop() ?? filePath;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

function subtitleLabel(videoPath: string, subPath: string, index: number): string {
  const videoStem = stem(videoPath);
  const subStem = stem(subPath);
  const suffix = subStem.startsWith(videoStem + ".")
    ? subStem.slice(videoStem.length + 1)
    : subStem;
  return LANG[suffix] ?? (suffix && suffix !== videoStem ? suffix : `Subtitles ${index + 1}`);
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, string> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) e.setAttribute(k, v);
  for (const c of children) e.append(c);
  return e;
}

// ── Navigation ────────────────────────────────────────────────────────────────

function browseUrl(dir: DirEntry): string {
  return dir.path ? `/browse/${dir.path.split("/").map(encodeURIComponent).join("/")}` : "/";
}

function watchUrl(file: FileEntry): string {
  return `/watch/${file.path.split("/").map(encodeURIComponent).join("/")}`;
}

function findNavStack(root: DirEntry, relPath: string): DirEntry[] | null {
  const segments = relPath.split("/").filter(Boolean);
  const stack: DirEntry[] = [];
  let current = root;
  for (const seg of segments) {
    const next = current.children.find((c): c is DirEntry => c.type === "dir" && c.name === seg);
    if (!next) return null;
    stack.push(next);
    current = next;
  }
  return stack;
}

function findFileByPath(root: DirEntry, relPath: string): FileEntry | null {
  const segments = relPath.split("/").filter(Boolean);
  if (segments.length === 0) return null;
  const dirStack = findNavStack(root, segments.slice(0, -1).join("/"));
  if (!dirStack) return null;
  const parent = dirStack.length > 0 ? dirStack[dirStack.length - 1] : root;
  const fileName = segments[segments.length - 1];
  return parent.children.find((c): c is FileEntry => c.type === "file" && c.name === fileName) ?? null;
}

function navigateInto(dir: DirEntry): void {
  // Auto-play if the folder contains exactly one video file and no subdirectories
  const files = dir.children.filter((c): c is FileEntry => c.type === "file");
  const dirs = dir.children.filter((c) => c.type === "dir");
  if (files.length === 1 && dirs.length === 0) {
    openPlayer(files[0]);
    return;
  }

  navStack.push(dir);
  renderLibrary();
  history.pushState(null, "", browseUrl(dir));
}

function navigateBack(): void {
  navStack.pop();
  renderLibrary();
  history.pushState(null, "", browseUrl(currentDir()!));
}

// Reconstructs app state (navStack / player) from the current URL. Used on
// initial load and whenever the user hits the browser back/forward buttons.
function routeFromLocation(): void {
  if (!libraryData) return;
  const path = decodeURIComponent(location.pathname);

  if (path.startsWith("/watch/")) {
    const file = findFileByPath(libraryData, path.slice("/watch/".length));
    if (file) {
      const parentPath = file.path.split("/").slice(0, -1).join("/");
      navStack = findNavStack(libraryData, parentPath) ?? [];
      openPlayer(file, false);
      return;
    }
  } else if (path.startsWith("/browse/")) {
    const stack = findNavStack(libraryData, path.slice("/browse/".length));
    if (stack) {
      navStack = stack;
      showLibrary(false);
      return;
    }
  } else if (path === "/") {
    navStack = [];
    showLibrary(false);
    return;
  }

  // Unknown or stale URL (e.g. library reorganized since the link was made).
  navStack = [];
  showLibrary(false);
  history.replaceState(null, "", "/");
}

function updateNav(): void {
  const backBtn = document.getElementById("library-back") as HTMLButtonElement;
  const breadcrumb = document.getElementById("breadcrumb")!;
  backBtn.hidden = navStack.length === 0;
  breadcrumb.textContent = navStack.map((d) => d.name).join(" › ");
}

// ── Library rendering ─────────────────────────────────────────────────────────

function renderLibrary(): void {
  const dir = currentDir();
  const view = document.getElementById("library-view")!;
  view.innerHTML = "";
  updateNav();

  if (!dir) return;

  const depth = navStack.length;
  const sortSelect = document.getElementById("sort-select") as HTMLSelectElement;

  if (depth === 1) {
    // Poster grid level — one card per movie/show folder
    sortSelect.hidden = false;
    renderPosterGrid(dir, view);
  } else {
    // Root (category list) or inside a show (season/episode list)
    sortSelect.hidden = true;
    renderItemList(dir, view, depth);
  }
}

function renderPosterGrid(dir: DirEntry, container: HTMLElement): void {
  const grid = el("div", { class: "poster-grid" });
  const children = sortEntries(dir.children, sortMode);

  for (const child of children) {
    const card = el("div", { class: "poster-card" });
    card.dataset["artworkPath"] = child.type === "dir" ? child.path : "";

    const imgWrap = el("div", { class: "poster-img-wrap" });
    const img = el("img", { class: "poster-img", alt: "" });
    const placeholder = el("div", { class: "poster-placeholder" });
    const initial = el("span", { class: "poster-initial" });
    initial.textContent = (child.name[0] ?? "?").toUpperCase();
    placeholder.appendChild(initial);
    imgWrap.append(img, placeholder);

    const badge = el("div", { class: "poster-badge", title: "Toggle watched" }, "✓");
    imgWrap.appendChild(badge);

    const label = el("p", { class: "poster-label" });
    label.textContent = displayName(child.name);

    card.append(imgWrap, label);

    const filePaths = collectFilePaths(child);
    const refreshWatchedClasses = () => {
      const watchedCount = filePaths.filter(isWatched).length;
      card.classList.toggle("watched", filePaths.length > 0 && watchedCount === filePaths.length);
      card.classList.toggle("in-progress", watchedCount > 0 && watchedCount < filePaths.length);
    };
    refreshWatchedClasses();

    badge.addEventListener("click", (e) => {
      e.stopPropagation();
      const allWatched = filePaths.length > 0 && filePaths.every(isWatched);
      for (const p of filePaths) setWatched(p, !allWatched);
      refreshWatchedClasses();
    });

    card.addEventListener("click", () => {
      if (child.type === "dir") navigateInto(child);
      else openPlayer(child);
    });

    grid.appendChild(card);
  }

  container.appendChild(grid);

  // Fetch artwork for each dir card asynchronously
  for (const child of children) {
    if (child.type !== "dir") continue;
    const artworkPath = child.path;
    const card = grid.querySelector(
      `[data-artwork-path="${CSS.escape(artworkPath)}"]`,
    ) as HTMLElement | null;
    if (!card) continue;

    fetch(`/api/artwork?path=${encodeURIComponent(artworkPath)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((artwork: ArtworkResult | null) => {
        if (!artwork) return;
        const img = card.querySelector(".poster-img") as HTMLImageElement;
        const placeholder = card.querySelector(".poster-placeholder") as HTMLElement;
        const label = card.querySelector(".poster-label") as HTMLElement;
        img.onload = () => placeholder.classList.add("loaded");
        img.src = artwork.posterUrl;
        label.textContent = artwork.title + (artwork.year ? ` (${artwork.year})` : "");
      })
      .catch(() => {
        // no artwork — leave placeholder
      });
  }
}

function renderItemList(dir: DirEntry, container: HTMLElement, depth: number): void {
  const list = el("div", { class: "item-list" });

  for (const child of dir.children) {
    const item = el("button", { class: "item-row" });

    if (child.type === "dir") {
      item.innerHTML = `<span class="item-icon">📁</span><span class="item-name">${child.name}</span>`;
      item.addEventListener("click", () => navigateInto(child));

      // Season folders (and deeper) can be bulk marked watched; root-level
      // category folders (depth 0) have no meaningful "watched" concept.
      if (depth >= 2) {
        const watchedToggle = el("span", { class: "watched-toggle", title: "Mark season watched" }, "✓");
        const filePaths = collectFilePaths(child);
        const refreshWatchedClasses = () => {
          const watchedCount = filePaths.filter(isWatched).length;
          item.classList.toggle("watched", filePaths.length > 0 && watchedCount === filePaths.length);
          item.classList.toggle("in-progress", watchedCount > 0 && watchedCount < filePaths.length);
        };
        refreshWatchedClasses();

        watchedToggle.addEventListener("click", (e) => {
          e.stopPropagation();
          const allWatched = filePaths.length > 0 && filePaths.every(isWatched);
          for (const p of filePaths) setWatched(p, !allWatched);
          refreshWatchedClasses();
        });

        item.appendChild(watchedToggle);
      }
    } else {
      const size = el("span", { class: "item-size" }, formatSize(child.size));
      const name = el("span", { class: "item-name" }, displayName(child.name));
      const icon = el("span", { class: "item-icon" }, "▶");
      const watchedToggle = el("span", { class: "watched-toggle", title: "Toggle watched" }, "✓");

      item.classList.toggle("watched", isWatched(child.path));
      watchedToggle.addEventListener("click", (e) => {
        e.stopPropagation();
        const next = !isWatched(child.path);
        item.classList.toggle("watched", next);
        setWatched(child.path, next);
      });

      item.append(icon, name, size, watchedToggle);
      item.addEventListener("click", () => openPlayer(child));
    }

    list.appendChild(item);
  }

  container.appendChild(list);
}

// ── Player ────────────────────────────────────────────────────────────────────

function updateWatchedButton(path: string): void {
  const btn = document.getElementById("watched-toggle-btn") as HTMLButtonElement;
  const watched = isWatched(path);
  btn.textContent = watched ? "✓ Watched" : "Mark watched";
  btn.classList.toggle("watched", watched);
}

function showLibrary(push = true): void {
  const playerView = document.getElementById("player-view")!;
  const librarySection = document.getElementById("library-section")!;
  const player = document.getElementById("player") as HTMLVideoElement;

  player.pause();
  player.src = "";
  while (player.firstChild) player.removeChild(player.firstChild);

  playerView.hidden = true;
  librarySection.hidden = false;
  renderLibrary();
  if (push) history.pushState(null, "", browseUrl(currentDir()!));
}

async function openPlayer(file: FileEntry, push = true): Promise<void> {
  const librarySection = document.getElementById("library-section")!;
  const playerView = document.getElementById("player-view")!;
  const player = document.getElementById("player") as HTMLVideoElement;
  const title = document.getElementById("player-title")!;

  librarySection.hidden = true;
  playerView.hidden = false;

  player.pause();
  player.src = "";
  while (player.firstChild) player.removeChild(player.firstChild);

  title.textContent = displayName(file.name);

  currentPlayingPath = file.path;
  updateWatchedButton(file.path);
  if (push) history.pushState(null, "", watchUrl(file));

  const mkvWarning = document.getElementById("mkv-warning")!;
  mkvWarning.hidden = !(file.name.toLowerCase().endsWith(".mkv") && !isChromiumBased);

  try {
    const res = await fetch(`/api/subtitles?path=${encodeURIComponent(file.path)}`);
    if (res.ok) {
      const subs = (await res.json()) as string[];
      for (let i = 0; i < subs.length; i++) {
        const encodedSrc = subs[i].split("/").map(encodeURIComponent).join("/");
        player.appendChild(
          el("track", {
            kind: "subtitles",
            src: `/files/${encodedSrc}`,
            label: subtitleLabel(file.path, subs[i], i),
          }),
        );
      }
    }
  } catch {
    // subtitles unavailable
  }

  player.src = `/files/${file.path.split("/").map(encodeURIComponent).join("/")}`;
  player.load();
  player.play().catch(() => {
    // autoplay blocked — user presses play
  });
}

// ── Init ──────────────────────────────────────────────────────────────────────

async function loadLibrary(): Promise<void> {
  const view = document.getElementById("library-view")!;
  view.innerHTML = '<p class="loading">Loading library…</p>';

  try {
    const [libRes, watchedRes] = await Promise.all([
      fetch("/api/library"),
      fetch("/api/watched"),
    ]);
    if (!libRes.ok) throw new Error(`HTTP ${libRes.status}`);
    libraryData = (await libRes.json()) as DirEntry;
    watchedData = watchedRes.ok ? ((await watchedRes.json()) as Record<string, boolean>) : {};
    routeFromLocation();
  } catch (err) {
    view.innerHTML = `<p class="error">Failed to load library: ${err}</p>`;
  }
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("back-btn")!.addEventListener("click", () => showLibrary());
  document.getElementById("library-back")!.addEventListener("click", () => navigateBack());
  window.addEventListener("popstate", () => routeFromLocation());

  const sortSelect = document.getElementById("sort-select") as HTMLSelectElement;
  sortSelect.value = sortMode;
  sortSelect.addEventListener("change", () => {
    sortMode = sortSelect.value as SortMode;
    renderLibrary();
  });

  const player = document.getElementById("player") as HTMLVideoElement;
  player.addEventListener("ended", () => {
    if (!currentPlayingPath) return;
    setWatched(currentPlayingPath, true);
    updateWatchedButton(currentPlayingPath);
  });

  document.getElementById("watched-toggle-btn")!.addEventListener("click", () => {
    if (!currentPlayingPath) return;
    const next = !isWatched(currentPlayingPath);
    setWatched(currentPlayingPath, next);
    updateWatchedButton(currentPlayingPath);
  });

  document.addEventListener("keydown", (e) => {
    const playerView = document.getElementById("player-view")!;
    if (playerView.hidden) return;

    // Let typing/interactive elements (and the app's own buttons) keep
    // their normal keyboard behavior instead of hijacking the key.
    const active = document.activeElement;
    if (
      active instanceof HTMLElement &&
      ["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(active.tagName)
    ) {
      return;
    }

    const player = document.getElementById("player") as HTMLVideoElement;

    switch (e.key) {
      case " ":
      case "Spacebar":
        e.preventDefault();
        if (player.paused) player.play().catch(() => {});
        else player.pause();
        break;
      case "ArrowLeft":
        e.preventDefault();
        player.currentTime = Math.max(0, player.currentTime - 5);
        break;
      case "ArrowRight":
        e.preventDefault();
        player.currentTime = Math.min(player.duration || Infinity, player.currentTime + 5);
        break;
    }
  });

  loadLibrary();
});
