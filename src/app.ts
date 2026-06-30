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

// ── Language labels ───────────────────────────────────────────────────────────

const LANG: Record<string, string> = {
  en: "English", fr: "French", de: "German", es: "Spanish",
  it: "Italian", pt: "Portuguese", nl: "Dutch", ja: "Japanese",
  ko: "Korean", zh: "Chinese", ru: "Russian", ar: "Arabic",
  sv: "Swedish", no: "Norwegian", da: "Danish", fi: "Finnish",
  pl: "Polish", cs: "Czech", hu: "Hungarian", tr: "Turkish",
};

// ── State ─────────────────────────────────────────────────────────────────────

let libraryData: DirEntry | null = null;
let navStack: DirEntry[] = [];
let sortBy: "name" | "year" = "name";
let sortDir: "asc" | "desc" = "asc";

function currentDir(): DirEntry | null {
  if (!libraryData) return null;
  return navStack.length > 0 ? navStack[navStack.length - 1] : libraryData;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatSize(bytes: number): string {
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function displayName(name: string): string {
  return name.replace(/\.(mp4|webm)$/i, "");
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

function extractYearFromName(name: string): number | null {
  const m = name.match(/\((\d{4})\)/);
  return m ? parseInt(m[1], 10) : null;
}

function sortEntries(entries: Entry[]): Entry[] {
  return [...entries].sort((a, b) => {
    if (sortBy === "year") {
      const ya = extractYearFromName(a.name) ?? Infinity;
      const yb = extractYearFromName(b.name) ?? Infinity;
      if (ya !== yb) return sortDir === "asc" ? ya - yb : yb - ya;
      return displayName(a.name).localeCompare(displayName(b.name));
    }
    const cmp = displayName(a.name).localeCompare(displayName(b.name));
    return sortDir === "asc" ? cmp : -cmp;
  });
}

// ── Navigation ────────────────────────────────────────────────────────────────

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
}

function navigateBack(): void {
  navStack.pop();
  renderLibrary();
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

  if (depth === 1) {
    // Poster grid level — one card per movie/show folder
    renderPosterGrid(dir, view);
  } else {
    // Root (category list) or inside a show (episode list)
    renderItemList(dir, view);
  }
}

function renderPosterGrid(dir: DirEntry, container: HTMLElement): void {
  const controls = el("div", { class: "sort-controls" });
  const buttons: Array<["name" | "year", "asc" | "desc", string]> = [
    ["name", "asc", "Name ▲"],
    ["name", "desc", "Name ▼"],
    ["year", "asc", "Year ▲"],
    ["year", "desc", "Year ▼"],
  ];
  for (const [by, order, label] of buttons) {
    const btn = el("button", {
      class: "sort-btn" + (sortBy === by && sortDir === order ? " sort-active" : ""),
    });
    btn.textContent = label;
    btn.addEventListener("click", () => { sortBy = by; sortDir = order; renderLibrary(); });
    controls.appendChild(btn);
  }
  container.appendChild(controls);

  const grid = el("div", { class: "poster-grid" });
  const sorted = sortEntries(dir.children);

  for (const child of sorted) {
    const card = el("div", { class: "poster-card" });
    card.dataset["artworkPath"] = child.type === "dir" ? child.path : "";

    const imgWrap = el("div", { class: "poster-img-wrap" });
    const img = el("img", { class: "poster-img", alt: "" });
    const placeholder = el("div", { class: "poster-placeholder" });
    const initial = el("span", { class: "poster-initial" });
    initial.textContent = (child.name[0] ?? "?").toUpperCase();
    placeholder.appendChild(initial);
    imgWrap.append(img, placeholder);

    const label = el("p", { class: "poster-label" });
    label.textContent = displayName(child.name);

    card.append(imgWrap, label);
    card.addEventListener("click", () => {
      if (child.type === "dir") navigateInto(child);
      else openPlayer(child);
    });

    grid.appendChild(card);
  }

  container.appendChild(grid);

  // Fetch artwork for each dir card asynchronously
  for (const child of sorted) {
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

function renderItemList(dir: DirEntry, container: HTMLElement): void {
  const list = el("div", { class: "item-list" });

  for (const child of dir.children) {
    const item = el("button", { class: "item-row" });

    if (child.type === "dir") {
      item.innerHTML = `<span class="item-icon">📁</span><span class="item-name">${child.name}</span>`;
      item.addEventListener("click", () => navigateInto(child));
    } else {
      const size = el("span", { class: "item-size" }, formatSize(child.size));
      const name = el("span", { class: "item-name" }, displayName(child.name));
      const icon = el("span", { class: "item-icon" }, "▶");
      item.append(icon, name, size);
      item.addEventListener("click", () => openPlayer(child));
    }

    list.appendChild(item);
  }

  container.appendChild(list);
}

// ── Player ────────────────────────────────────────────────────────────────────

function showLibrary(): void {
  const playerView = document.getElementById("player-view")!;
  const librarySection = document.getElementById("library-section")!;
  const player = document.getElementById("player") as HTMLVideoElement;

  player.pause();
  player.src = "";
  while (player.firstChild) player.removeChild(player.firstChild);

  playerView.hidden = true;
  librarySection.hidden = false;
}

async function openPlayer(file: FileEntry): Promise<void> {
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
    const res = await fetch("/api/library");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    libraryData = (await res.json()) as DirEntry;
    renderLibrary();
  } catch (err) {
    view.innerHTML = `<p class="error">Failed to load library: ${err}</p>`;
  }
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("back-btn")!.addEventListener("click", showLibrary);
  document.getElementById("library-back")!.addEventListener("click", navigateBack);
  loadLibrary();
});
