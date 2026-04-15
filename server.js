"use strict";

const express = require("express");
const multer = require("multer");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const http = require("http");
const https = require("https");
const { pipeline } = require("stream/promises");
const { spawn, exec } = require("child_process");
const os = require("os");

const app = express();
const PORT = process.env.PORT || 3000;

const ROOT_DIR = __dirname;
const DOWNLOADS_DIR = path.join(ROOT_DIR, "downloads");
const DATA_DIR = path.join(ROOT_DIR, "data");
const TMP_DIR = path.join(DATA_DIR, "tmp");
const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const BACKGROUND_DIR = path.join(PUBLIC_DIR, "uploads", "backgrounds");
const IMMERSION_BG_DIR = path.join(PUBLIC_DIR, "uploads", "backgrounds", "immersion_backgrounds");
const PLAYLIST_COVER_DIR = path.join(PUBLIC_DIR, "uploads", "playlist-covers");
const FAVORITES_FILE = path.join(DATA_DIR, "favorites.json");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");

const AUDIO_EXTENSIONS = new Set([
  ".mp3",
  ".wav",
  ".flac",
  ".aac",
  ".ogg",
  ".m4a",
  ".webm",
  ".opus",
]);
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);

const CONTENT_TYPE_TO_EXT = {
  "audio/mpeg": ".mp3",
  "audio/mp3": ".mp3",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "audio/flac": ".flac",
  "audio/x-flac": ".flac",
  "audio/aac": ".aac",
  "audio/ogg": ".ogg",
  "audio/webm": ".webm",
  "audio/mp4": ".m4a",
  "audio/x-m4a": ".m4a",
  "audio/opus": ".opus",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

const BILIBILI_PATTERN = /(bilibili\.com|b23\.tv)/i;
const YOUTUBE_PATTERN = /(youtube\.com|youtu\.be)/i;

// In-memory download jobs: jobId -> { status, message, fileName, progress, startedAt }
const downloadJobs = new Map();

const upload = multer({
  dest: TMP_DIR,
  limits: { fileSize: 1024 * 1024 * 1024 },
});
const imageUpload = multer({
  dest: TMP_DIR,
  limits: { fileSize: 20 * 1024 * 1024 },
});

app.use(express.json({ limit: "4mb" }));
app.use(express.urlencoded({ extended: true }));
app.use("/media", express.static(DOWNLOADS_DIR));
app.use(express.static(PUBLIC_DIR));

// ─── Startup ─────────────────────────────────────────────────────────────────

async function ensureAppFiles() {
  await fsp.mkdir(DOWNLOADS_DIR, { recursive: true });
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.mkdir(TMP_DIR, { recursive: true });
  await fsp.mkdir(BACKGROUND_DIR, { recursive: true });
  await fsp.mkdir(IMMERSION_BG_DIR, { recursive: true });
  await fsp.mkdir(PLAYLIST_COVER_DIR, { recursive: true });

  if (!fs.existsSync(FAVORITES_FILE)) {
    await writeJson(FAVORITES_FILE, { folders: [] });
  }
  if (!fs.existsSync(SETTINGS_FILE)) {
    await writeJson(SETTINGS_FILE, {
      backgroundImage: "",
      backgroundFileName: "",
      theme: { primary: "#7c5cff", secondary: "#20c997", accent: "#ff6b6b" },
    });
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────────

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fsp.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, data) {
  await fsp.writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
}

function sanitizeName(value) {
  return String(value || "")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getBase(fileName) {
  return path.basename(fileName, path.extname(fileName));
}

function prettify(fileName) {
  return (
    getBase(fileName).replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim() ||
    "未命名歌曲"
  );
}

function isAudio(f) {
  return AUDIO_EXTENSIONS.has(path.extname(f).toLowerCase());
}
function isImage(f) {
  return IMAGE_EXTENSIONS.has(path.extname(f).toLowerCase());
}

function uid() {
  return typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : crypto.randomBytes(16).toString("hex");
}

async function fileExists(p) {
  try {
    await fsp.access(p, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function uniqueFileName(dir, desired) {
  const ext = path.extname(desired);
  const base = sanitizeName(getBase(desired)) || "file";
  let candidate = `${base}${ext}`;
  let i = 2;
  while (await fileExists(path.join(dir, candidate))) {
    candidate = `${base}-${i}${ext}`;
    i++;
  }
  return candidate;
}

async function cleanupTemp(files) {
  for (const f of files || []) {
    try {
      if (f?.path) await fsp.unlink(f.path);
    } catch {
      /* ignore */
    }
  }
}

function mediaUrl(fileName) {
  return `/media/${encodeURIComponent(fileName)}`;
}

// ─── Track Listing ────────────────────────────────────────────────────────────

// Recursively get all audio files from downloads directory
async function getAllAudioFiles(dir, basePath = "") {
  const results = [];
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  
  for (const entry of entries) {
    const relativePath = basePath ? path.join(basePath, entry.name) : entry.name;
    const fullPath = path.join(dir, entry.name);
    
    if (entry.isDirectory()) {
      // Recurse into subdirectories
      const subFiles = await getAllAudioFiles(fullPath, relativePath);
      results.push(...subFiles);
    } else if (entry.isFile() && isAudio(entry.name)) {
      results.push({
        name: entry.name,
        relativePath,
        fullPath,
        dir: dir
      });
    }
  }
  
  return results;
}

async function listTracks() {
  // Get all audio files recursively from downloads folder
  const audioFiles = await getAllAudioFiles(DOWNLOADS_DIR);
  
  const tracks = [];
  for (const file of audioFiles.sort((a, b) =>
    a.relativePath.localeCompare(b.relativePath, "zh-Hans-CN"),
  )) {
    const fileName = file.name;
    const relativeDir = path.dirname(file.relativePath);
    const fileDir = path.dirname(file.fullPath);
    
    const stat = await fsp.stat(file.fullPath);
    const lrcName = `${getBase(fileName)}.lrc`;
    const lrcPath = path.join(fileDir, lrcName);
    const lrcExists = await fileExists(lrcPath);
    
    // Find thumbnail file in same directory
    const baseName = getBase(fileName);
    const dirEntries = await fsp.readdir(fileDir, { withFileTypes: true });
    const thumbFile = dirEntries.find(e => 
      e.isFile() &&
      e.name.startsWith(baseName) && 
      (e.name.endsWith('.jpg') || e.name.endsWith('.png') || e.name.endsWith('.webp')) &&
      !isAudio(e.name)
    )?.name;
    
    // For media URL, use relative path from downloads
    const mediaPath = relativeDir === '.' ? fileName : path.join(relativeDir, fileName);
    const thumbPath = thumbFile && relativeDir !== '.' 
      ? path.join(relativeDir, thumbFile).replace(/\\/g, '/') 
      : thumbFile;
    
    // Extract artist from directory structure: artist/song/file.mp3
    const pathParts = file.relativePath.replace(/\\/g, '/').split('/');
    const artist = pathParts.length >= 3 ? pathParts[0] : "";

    tracks.push({
      id: file.relativePath.replace(/\\/g, '/'),
      title: prettify(fileName),
      artist,
      fileName: file.relativePath,
      url: mediaUrl(mediaPath.replace(/\\/g, '/')),
      size: stat.size,
      updatedAt: stat.mtime.toISOString(),
      lyricsAvailable: lrcExists,
      lyricsUrl: lrcExists ? mediaUrl(path.join(relativeDir, lrcName).replace(/\\/g, '/')) : "",
      thumbnailFile: thumbFile || "",
      thumbnailUrl: thumbFile ? mediaUrl(thumbPath) : "",
    });
  }
  return tracks;
}

// ─── Favorites ────────────────────────────────────────────────────────────────

async function getFavorites() {
  const data = await readJson(FAVORITES_FILE, { folders: [] });
  if (!Array.isArray(data.folders)) return { folders: [] };
  return data;
}
async function saveFavorites(data) {
  await writeJson(FAVORITES_FILE, data);
}

// ─── Settings ─────────────────────────────────────────────────────────────────

async function getSettings() {
  return readJson(SETTINGS_FILE, {
    backgroundImage: "",
    backgroundFileName: "",
    theme: { primary: "#7c5cff", secondary: "#20c997", accent: "#ff6b6b" },
  });
}
async function saveSettings(data) {
  await writeJson(SETTINGS_FILE, data);
}

// ─── NetEase Lyrics Auto-Fetch ─────────────────────────────────────────────────

// ─── Simple HTTPS helper (no external deps) ──────────────────────────────────

function httpsJSON(options, postBody) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      // Follow redirects once
      if (
        res.statusCode >= 300 &&
        res.statusCode < 400 &&
        res.headers.location
      ) {
        res.resume();
        try {
          const loc = new URL(
            res.headers.location,
            `https://${options.hostname}`,
          );
          httpsJSON(
            {
              hostname: loc.hostname,
              path: loc.pathname + loc.search,
              method: options.method || "GET",
              headers: options.headers,
            },
            postBody,
          )
            .then(resolve)
            .catch(reject);
        } catch (e) {
          reject(e);
        }
        return;
      }
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (c) => {
        raw += c;
      });
      res.on("end", () => {
        try {
          resolve(JSON.parse(raw));
        } catch {
          resolve({});
        }
      });
    });
    req.setTimeout(10000, () => {
      req.destroy(new Error("timeout"));
    });
    req.on("error", reject);
    if (postBody) req.write(postBody);
    req.end();
  });
}

// LRCLIB API - Free lyrics library
// https://lrclib.net

async function lrclibApiGet(params) {
  const queryString = params.toString();
  console.log("[LRCLIB] API URL:", `https://lrclib.net/api/get?${queryString}`);

  const data = await httpsJSON({
    hostname: "lrclib.net",
    path: `/api/get?${queryString}`,
    method: "GET",
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      "Accept": "application/json",
    },
  });

  console.log("[LRCLIB] Response:", JSON.stringify(data).substring(0, 200));
  return data;
}

async function fetchLyricsFromLrclib(trackName, artistName = "", albumName = "", duration = 0) {
  if (!trackName) return "";

  // Try to extract artist from trackName if artistName is empty
  // Common patterns: "七里香 周杰伦", "周杰伦 - 七里香", "周杰伦——七里香"
  let cleanTrackName = trackName;
  let extractedArtist = artistName;

  if (!extractedArtist) {
    // Pattern: "七里香 周杰伦" (song artist)
    const spaceParts = trackName.split(/\s+/);
    if (spaceParts.length >= 2) {
      // Last part might be artist
      const lastPart = spaceParts[spaceParts.length - 1];
      if (lastPart.length >= 2 && lastPart.length <= 10) {
        extractedArtist = lastPart;
        cleanTrackName = spaceParts.slice(0, -1).join(" ");
        console.log("[LRCLIB] Extracted from space:", { song: cleanTrackName, artist: extractedArtist });
      }
    }
  }

  try {
    // Attempt 1: Use extracted/clean track name + artist
    const params1 = new URLSearchParams();
    params1.append("track_name", cleanTrackName);
    if (extractedArtist) params1.append("artist_name", extractedArtist);
    if (duration > 0) params1.append("duration", Math.round(duration).toString());

    const data1 = await lrclibApiGet(params1);
    if (data1?.syncedLyrics || data1?.plainLyrics) {
      console.log("[LRCLIB] Found with clean title!");
      return data1.syncedLyrics || data1.plainLyrics;
    }

    // Attempt 2: Try original track name only (without artist)
    if (extractedArtist && extractedArtist !== artistName) {
      const params2 = new URLSearchParams();
      params2.append("track_name", trackName);
      if (duration > 0) params2.append("duration", Math.round(duration).toString());

      const data2 = await lrclibApiGet(params2);
      if (data2?.syncedLyrics || data2?.plainLyrics) {
        console.log("[LRCLIB] Found with original title!");
        return data2.syncedLyrics || data2.plainLyrics;
      }
    }

    // Attempt 3: Try with provided artistName (if different from extracted)
    if (artistName && artistName !== extractedArtist) {
      const params3 = new URLSearchParams();
      params3.append("track_name", cleanTrackName);
      params3.append("artist_name", artistName);
      if (duration > 0) params3.append("duration", Math.round(duration).toString());

      const data3 = await lrclibApiGet(params3);
      if (data3?.syncedLyrics || data3?.plainLyrics) {
        console.log("[LRCLIB] Found with provided artist!");
        return data3.syncedLyrics || data3.plainLyrics;
      }
    }

    console.log("[LRCLIB] No lyrics found after all attempts");
    return "";
  } catch (err) {
    console.error("[LRCLIB] Error:", err.message);
    return "";
  }
}

// Keep old function for compatibility, but use LRCLIB
async function fetchLyricsFromNetease(rawName) {
  return fetchLyricsFromLrclib(rawName, "", "", 0);
}

// ─── yt-dlp Helpers ───────────────────────────────────────────────────────────

// 常见 yt-dlp 安装路径
const YTDLP_PATHS = [
  "yt-dlp", // 尝试从 PATH 中查找
  path.join(os.homedir(), "AppData", "Roaming", "Python", "Python312", "Scripts", "yt-dlp.exe"),
  path.join(os.homedir(), "AppData", "Roaming", "Python", "Python311", "Scripts", "yt-dlp.exe"),
  path.join(os.homedir(), "AppData", "Roaming", "Python", "Python310", "Scripts", "yt-dlp.exe"),
  path.join(os.homedir(), ".local", "bin", "yt-dlp"), // Linux/macOS
  "/usr/local/bin/yt-dlp", // macOS Homebrew
  "/usr/bin/yt-dlp", // Linux
];

let ytdlpPath = null;

async function findYtdlp() {
  if (ytdlpPath) return ytdlpPath;
  
  for (const p of YTDLP_PATHS) {
    try {
      await fsp.access(p, fs.constants.X_OK);
      ytdlpPath = p;
      console.log("[yt-dlp] Found path:", p);
      return p;
    } catch {
      continue;
    }
  }
  
  // 尝试用 where/which 命令查找
  try {
    const result = await new Promise((resolve) => {
      const isWin = process.platform === "win32";
      const cmd = isWin ? "where yt-dlp" : "which yt-dlp";
      exec(cmd, (error, stdout) => {
        if (error || !stdout) {
          resolve(null);
        } else {
          const found = stdout.trim().split("\n")[0].trim();
          resolve(found || null);
        }
      });
    });
    if (result) {
      ytdlpPath = result;
      console.log("[yt-dlp] Found via command:", result);
      return result;
    }
  } catch {
    // ignore
  }
  
  return null;
}

async function checkYtdlp() {
  const path = await findYtdlp();
  return !!path;
}

async function runYtdlpDownload(url, jobId) {
  // Snapshot existing files before download
  const before = new Set(
    (await fsp.readdir(DOWNLOADS_DIR)).filter((f) => isAudio(f)),
  );

  const outputTemplate = path.join(DOWNLOADS_DIR, "%(title)s.%(ext)s");
  
  // Detect Bilibili URL and use specific options
  const isBilibili = /bilibili\.com|b23\.tv/i.test(url);
  
  const args = [
    "-x",
    "--audio-format", "mp3",
    "--audio-quality", "0",
    "--no-playlist",
    "--no-mtime",
    "--embed-thumbnail",
    "--add-metadata",
    "--no-warnings",
    "--retries", "3",
    "--fragment-retries", "3",
    "--socket-timeout", "30",
    "-o", outputTemplate,
  ];
  
  // Bilibili specific options
  if (isBilibili) {
    // FFmpeg 路径
    const ffmpegPath = "D:\\Astudy\\Music\\ffmpeg-8.1-essentials_build\\bin\\ffmpeg.exe";
    args.push("--ffmpeg-location", ffmpegPath);
    args.push("--extractor-args", "bilibili:formats=html5");
    args.push("--user-agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
    args.push("--referer", "https://www.bilibili.com");
    args.push("--no-check-certificates");
    args.push("--concurrent-fragments", "3");
    // Download thumbnail as separate file
    args.push("--write-thumbnail");
    args.push("--convert-thumbnails", "jpg");
  }
  
  args.push(url);

  return new Promise(async (resolve, reject) => {
    const ytdlpCmd = await findYtdlp();
    if (!ytdlpCmd) {
      reject(new Error("未找到 yt-dlp，请安装：pip install yt-dlp"));
      return;
    }
    
    console.log("[Download] yt-dlp path:", ytdlpCmd);
    console.log("[Download] Target URL:", url);
    console.log("[Download] Args:", args.join(" "));
    
    const child = spawn(ytdlpCmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let logLines = [];

    child.stdout.on("data", (data) => {
      const text = data.toString();
      logLines.push(text.trim());
      // Update job progress message
      const job = downloadJobs.get(jobId);
      if (job) {
        const progressMatch = text.match(/(\d+\.\d+)%/);
        if (progressMatch) {
          job.message = `下载中 ${progressMatch[1]}%`;
        }
      }
    });

    child.stderr.on("data", (data) => {
      const errText = data.toString().trim();
      console.error("[yt-dlp stderr]", errText);
      logLines.push("[ERROR] " + errText);
      
      // 更新任务状态显示错误信息
      const job = downloadJobs.get(jobId);
      if (job && errText.length > 0) {
        // 提取有用的错误信息
        if (errText.includes("ERROR:")) {
          job.message = errText.substring(0, 50) + "...";
        }
      }
    });

    child.on("close", async (code) => {
      if (code !== 0) {
        const errorLog = logLines.slice(-20).join("\n");
        console.error("[Download] yt-dlp exit code:", code);
        console.error("[Download] Error log:\n", errorLog);
        
        let errorMsg = `yt-dlp 退出码 ${code}`;
        if (errorLog.includes("Unable to extract")) {
          errorMsg = "无法解析视频信息，请检查链接是否有效或视频是否被删除";
        } else if (errorLog.includes("Sign in") || errorLog.includes("login")) {
          errorMsg = "该视频需要登录才能访问";
        } else if (errorLog.includes("geo-restricted")) {
          errorMsg = "该视频在您的地区不可用";
        } else if (errorLog.includes("404") || errorLog.includes("Not Found")) {
          errorMsg = "视频不存在或已被删除";
        } else if (errorLog.includes("ffmpeg") || errorLog.includes("FFmpeg")) {
          errorMsg = "需要安装 ffmpeg，请安装 ffmpeg 并添加到环境变量";
        } else if (errorLog.includes("unsupported operand type")) {
          errorMsg = "yt-dlp 版本过旧，请更新：pip install -U yt-dlp";
        } else if (errorLog.includes("JavaScript")) {
          errorMsg = "yt-dlp 需要 JavaScript 运行时，请安装 Node.js 或更新 yt-dlp";
        }
        reject(new Error(errorMsg));
        return;
      }

      try {
        // Find newly added audio files
        const after = (await fsp.readdir(DOWNLOADS_DIR)).filter((f) =>
          isAudio(f),
        );
        const newFiles = after.filter((f) => !before.has(f));

        let audioFile = "";
        if (newFiles.length > 0) {
          audioFile = newFiles[0];
        } else {
          // Fallback: find most recently modified audio file
          const allFiles = await Promise.all(
            after.map(async (f) => ({
              name: f,
              mtime: (await fsp.stat(path.join(DOWNLOADS_DIR, f))).mtimeMs,
            })),
          );
          allFiles.sort((a, b) => b.mtime - a.mtime);
          audioFile = allFiles[0]?.name || "";
        }

        // Find thumbnail file (if downloaded)
        let thumbnailFile = "";
        if (audioFile) {
          const baseName = getBase(audioFile);
          const allFiles = await fsp.readdir(DOWNLOADS_DIR);
          // Look for thumbnail files with same base name
          const thumbFile = allFiles.find(f =>
            f.startsWith(baseName) &&
            (f.endsWith('.jpg') || f.endsWith('.png') || f.endsWith('.webp')) &&
            !isAudio(f)
          );
          if (thumbFile) {
            thumbnailFile = thumbFile;
            console.log("[Download] Found thumbnail:", thumbnailFile);
          }
        }

        // Auto-organize into artist/song folder
        if (audioFile) {
          audioFile = await organizeFileToArtistFolder(audioFile);
        }

        resolve({ audioFile, thumbnailFile });
      } catch (err) {
        reject(err);
      }
    });

    child.on("error", (err) => {
      reject(new Error(`无法启动 yt-dlp: ${err.message}`));
    });
  });
}

// ─── Auto-organize downloaded file into artist/song folder ──────────────────
async function organizeFileToArtistFolder(fileName) {
  if (!fileName) return fileName;

  const srcPath = path.join(DOWNLOADS_DIR, fileName);
  if (!(await fileExists(srcPath))) return fileName;

  // Parse "歌名 歌手名" pattern from filename
  const base = getBase(fileName);
  const parts = base.split(/\s+/);

  if (parts.length < 2) return fileName; // No artist info, keep flat

  const lastPart = parts[parts.length - 1];
  // Last part is likely artist if it's 2-10 chars (Chinese name or English name)
  if (lastPart.length < 2 || lastPart.length > 15) return fileName;

  const artistName = lastPart;
  const songName = parts.slice(0, -1).join(" ");

  const artistDir = path.join(DOWNLOADS_DIR, sanitizeName(artistName));
  const songDir = path.join(artistDir, sanitizeName(songName));

  await fsp.mkdir(songDir, { recursive: true });

  const ext = path.extname(fileName);
  const newAudioPath = path.join(songDir, `${sanitizeName(songName)}${ext}`);

  // Check if file already exists at destination
  if (await fileExists(newAudioPath)) {
    // Remove duplicate source
    await fsp.unlink(srcPath);
    console.log(`[Organize] Removed duplicate: ${fileName}`);
    return path.join(sanitizeName(artistName), sanitizeName(songName), `${sanitizeName(songName)}${ext}`).replace(/\\/g, '/');
  }

  await fsp.rename(srcPath, newAudioPath);
  console.log(`[Organize] Moved: ${fileName} -> ${artistName}/${songName}/`);

  // Also move thumbnail if exists
  const allFiles = await fsp.readdir(DOWNLOADS_DIR);
  const thumbFile = allFiles.find(f =>
    f.startsWith(base) &&
    (f.endsWith('.jpg') || f.endsWith('.png') || f.endsWith('.webp')) &&
    !isAudio(f)
  );
  if (thumbFile) {
    const thumbSrc = path.join(DOWNLOADS_DIR, thumbFile);
    const thumbExt = path.extname(thumbFile);
    const newThumbPath = path.join(songDir, `${sanitizeName(songName)}${thumbExt}`);
    if (await fileExists(thumbSrc)) {
      await fsp.rename(thumbSrc, newThumbPath);
      console.log(`[Organize] Moved thumbnail: ${thumbFile} -> ${artistName}/${songName}/`);
    }
  }

  return path.join(sanitizeName(artistName), sanitizeName(songName), `${sanitizeName(songName)}${ext}`).replace(/\\/g, '/');
}

// ─── Direct HTTP/HTTPS Download ───────────────────────────────────────────────

function requestStream(targetUrl, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) {
      reject(new Error("重定向次数过多"));
      return;
    }
    let parsedUrl;
    try {
      parsedUrl = new URL(targetUrl);
    } catch {
      reject(new Error("无效链接"));
      return;
    }
    const client = parsedUrl.protocol === "https:" ? https : http;
    const req = client.get(parsedUrl, (res) => {
      const code = res.statusCode || 0;
      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume();
        try {
          const next = new URL(res.headers.location, targetUrl).toString();
          resolve(requestStream(next, redirectCount + 1));
        } catch {
          reject(new Error("重定向链接无效"));
        }
        return;
      }
      if (code < 200 || code >= 300) {
        res.resume();
        reject(new Error(`服务器返回 ${code}`));
        return;
      }
      resolve({ response: res, headers: res.headers, finalUrl: targetUrl });
    });
    req.on("error", (err) => reject(new Error(`请求失败: ${err.message}`)));
  });
}

function inferExt(contentType) {
  if (!contentType) return "";
  const clean = String(contentType).split(";")[0].trim().toLowerCase();
  return CONTENT_TYPE_TO_EXT[clean] || "";
}

function parseContentDispositionName(header) {
  if (!header) return "";
  const utf8 = header.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8) {
    try {
      return decodeURIComponent(utf8[1]);
    } catch {
      return utf8[1];
    }
  }
  const simple = header.match(/filename="?([^";\n]+)"?/i);
  return simple ? simple[1].trim() : "";
}

async function downloadDirectUrl(url, preferredName) {
  const { response, headers, finalUrl } = await requestStream(url);
  const dispositionName = parseContentDispositionName(
    headers["content-disposition"] || "",
  );
  const urlName = (() => {
    try {
      return path.basename(new URL(finalUrl).pathname);
    } catch {
      return "";
    }
  })();
  const sourceName =
    preferredName || dispositionName || urlName || "downloaded";

  let ext = path.extname(sourceName).toLowerCase();
  if (!ext) ext = inferExt(headers["content-type"] || "");
  if (!ext) ext = ".mp3";

  if (!AUDIO_EXTENSIONS.has(ext)) {
    response.resume();
    throw new Error("该链接不是支持的音频格式");
  }

  const base = sanitizeName(getBase(sourceName)) || "downloaded";
  const finalName = await uniqueFileName(DOWNLOADS_DIR, `${base}${ext}`);
  const targetPath = path.join(DOWNLOADS_DIR, finalName);

  try {
    await pipeline(response, fs.createWriteStream(targetPath));
  } catch (err) {
    try {
      await fsp.unlink(targetPath);
    } catch {
      /* ignore */
    }
    throw err;
  }

  // Auto-organize into artist/song folder
  return await organizeFileToArtistFolder(finalName);
}

// ─── API Routes ───────────────────────────────────────────────────────────────

// GET /api/tracks
app.get("/api/tracks", async (req, res, next) => {
  try {
    res.json({ tracks: await listTracks() });
  } catch (err) {
    next(err);
  }
});

// POST /api/lyrics - Save lyrics for a track
app.post("/api/lyrics", async (req, res, next) => {
  try {
    const trackId = String(req.body.trackId || "").trim();
    const lyrics = String(req.body.lyrics || "").trim();
    if (!trackId || !lyrics) {
      res.status(400).json({ error: "Missing trackId or lyrics" });
      return;
    }

    const audioName = path.basename(trackId);
    const lrcName = `${getBase(audioName)}.lrc`;
    // Support nested paths like artist/song/file.mp3
    const lrcDir = trackId.includes('/')
      ? path.join(DOWNLOADS_DIR, path.dirname(trackId))
      : DOWNLOADS_DIR;
    await fsp.mkdir(lrcDir, { recursive: true });
    const lrcPath = path.join(lrcDir, lrcName);
    await fsp.writeFile(lrcPath, lyrics, "utf8");
    console.log("[Lyrics] Saved:", lrcPath);
    res.json({ message: "歌词保存成功", path: lrcName });
  } catch (err) {
    next(err);
  }
});

// GET /api/lyrics?trackId=
app.get("/api/lyrics", async (req, res, next) => {
  try {
    const trackId = String(req.query.trackId || "").trim();
    if (!trackId) {
      res.status(400).json({ error: "Missing trackId" });
      return;
    }

    const audioName = path.basename(trackId);
    const lrcName = `${getBase(audioName)}.lrc`;
    // Support nested paths: trackId may contain subdirectories
    const lrcPath = trackId.includes('/') 
      ? path.join(DOWNLOADS_DIR, path.dirname(trackId), lrcName)
      : path.join(DOWNLOADS_DIR, lrcName);

    // Return cached local LRC first
    if (await fileExists(lrcPath)) {
      const lyrics = await fsp.readFile(lrcPath, "utf8");
      res.json({ lyrics, exists: true, source: "local" });
      return;
    }

    // Auto-fetch from LRCLIB
    const baseName = getBase(audioName);
    console.log("[LRCLIB] Auto-fetch for:", baseName);
    const lyricsText = await fetchLyricsFromLrclib(baseName, "", "", 0);
    if (lyricsText && lyricsText.trim().length > 10) {
      // Cache locally - save in same directory as audio file
      try {
        const cacheDir = trackId.includes('/') 
          ? path.join(DOWNLOADS_DIR, path.dirname(trackId))
          : DOWNLOADS_DIR;
        await fsp.mkdir(cacheDir, { recursive: true });
        await fsp.writeFile(path.join(cacheDir, lrcName), lyricsText, "utf8");
      } catch {
        /* ignore */
      }
      res.json({ lyrics: lyricsText, exists: true, source: "lrclib" });
    } else {
      res.json({ lyrics: "", exists: false, source: "none" });
    }
  } catch (err) {
    next(err);
  }
});

// GET /api/lyrics/:trackId (path parameter - used by frontend loadLyrics)
app.get("/api/lyrics/:trackId(*)", async (req, res, next) => {
  try {
    // Use (*) to capture full path including slashes
    const trackId = String(req.params.trackId || "").trim();
    if (!trackId) {
      res.status(400).json({ error: "Missing trackId" });
      return;
    }

    const audioName = path.basename(trackId);
    const lrcName = `${getBase(audioName)}.lrc`;
    // Support nested paths
    const lrcPath = trackId.includes('/') 
      ? path.join(DOWNLOADS_DIR, path.dirname(trackId), lrcName)
      : path.join(DOWNLOADS_DIR, lrcName);

    // Return cached local LRC first
    if (await fileExists(lrcPath)) {
      const lyrics = await fsp.readFile(lrcPath, "utf8");
      res.json({ lyrics, exists: true, source: "local" });
      return;
    }

    // Auto-fetch from LRCLIB
    const baseName = getBase(audioName);
    console.log("[LRCLIB] Auto-fetch for:", baseName);
    const lyricsText = await fetchLyricsFromLrclib(baseName, "", "", 0);
    if (lyricsText && lyricsText.trim().length > 10) {
      // Cache locally in same directory as audio
      try {
        const cacheDir = trackId.includes('/') 
          ? path.join(DOWNLOADS_DIR, path.dirname(trackId))
          : DOWNLOADS_DIR;
        await fsp.mkdir(cacheDir, { recursive: true });
        await fsp.writeFile(path.join(cacheDir, lrcName), lyricsText, "utf8");
      } catch {
        /* ignore */
      }
      res.json({ lyrics: lyricsText, exists: true, source: "lrclib" });
    } else {
      res.json({ lyrics: "", exists: false, source: "none" });
    }
  } catch (err) {
    next(err);
  }
});

// GET /api/lyrics-netease?title=&artist=&album=&duration=
// 使用 LRCLIB (lrclib.net) 搜索歌词
app.get("/api/lyrics-netease", async (req, res, next) => {
  try {
    const title = String(req.query.title || "").trim();
    const artist = String(req.query.artist || "").trim();
    const album = String(req.query.album || "").trim();
    const duration = parseInt(req.query.duration || "0", 10);
    
    if (!title) {
      res.status(400).json({ error: "请提供歌曲名称" });
      return;
    }
    
    console.log("[Lyrics] LRCLIB search:", { title, artist, album, duration });
    
    // Use LRCLIB with separate parameters for better matching
    const lyricsText = await fetchLyricsFromLrclib(title, artist, album, duration);
    
    if (lyricsText && lyricsText.trim().length > 10) {
      res.json({ lyrics: lyricsText, found: true, source: "lrclib" });
    } else {
      res.json({ lyrics: "", found: false });
    }
  } catch (err) {
    console.error("[Lyrics] LRCLIB search failed:", err.message);
    res.status(500).json({ error: "搜索歌词失败", message: err.message });
  }
});

// POST /api/upload-tracks
app.post(
  "/api/upload-tracks",
  upload.fields([
    { name: "audioFiles", maxCount: 100 },
    { name: "lyricFiles", maxCount: 100 },
  ]),
  async (req, res, next) => {
    const audioFiles = req.files?.audioFiles || [];
    const lyricFiles = req.files?.lyricFiles || [];
    const allTemp = [...audioFiles, ...lyricFiles];
    try {
      const lyricMap = new Map();
      for (const lf of lyricFiles) {
        if (path.extname(lf.originalname).toLowerCase() !== ".lrc") continue;
        const key = sanitizeName(getBase(lf.originalname)).toLowerCase();
        if (!lyricMap.has(key)) lyricMap.set(key, []);
        lyricMap.get(key).push(lf);
      }

      let imported = 0;
      for (const af of audioFiles) {
        const ext = path.extname(af.originalname).toLowerCase();
        if (!AUDIO_EXTENSIONS.has(ext)) continue;
        const base = sanitizeName(getBase(af.originalname)) || "track";
        const finalName = await uniqueFileName(DOWNLOADS_DIR, `${base}${ext}`);
        await fsp.rename(af.path, path.join(DOWNLOADS_DIR, finalName));
        imported++;

        // Auto-organize into artist/song folder
        const organizedName = await organizeFileToArtistFolder(finalName);

        const matched = lyricMap.get(base.toLowerCase());
        if (matched?.length) {
          const lf = matched.shift();
          // Move lyric to same folder as the organized audio
          const organizedDir = path.dirname(path.join(DOWNLOADS_DIR, organizedName));
          await fsp.mkdir(organizedDir, { recursive: true });
          await fsp.rename(
            lf.path,
            path.join(organizedDir, `${getBase(organizedName)}.lrc`),
          );
        }
      }
      await cleanupTemp(allTemp);
      res.json({
        message: `成功导入 ${imported} 首歌曲`,
        importedCount: imported,
        tracks: await listTracks(),
      });
    } catch (err) {
      await cleanupTemp(allTemp);
      next(err);
    }
  },
);

// POST /api/upload-lyrics
app.post(
  "/api/upload-lyrics",
  upload.single("lyricFile"),
  async (req, res, next) => {
    try {
      const trackId = String(req.body.trackId || "").trim();
      if (!req.file) {
        res.status(400).json({ error: "请上传歌词文件" });
        return;
      }
      if (!trackId) {
        await cleanupTemp([req.file]);
        res.status(400).json({ error: "缺少 trackId" });
        return;
      }
      if (path.extname(req.file.originalname).toLowerCase() !== ".lrc") {
        await cleanupTemp([req.file]);
        res.status(400).json({ error: "只支持 .lrc 格式" });
        return;
      }
      const finalName = `${getBase(path.basename(trackId))}.lrc`;
      await fsp.rename(req.file.path, path.join(DOWNLOADS_DIR, finalName));
      res.json({ message: "歌词上传成功", lyricsUrl: mediaUrl(finalName) });
    } catch (err) {
      if (req.file) await cleanupTemp([req.file]);
      next(err);
    }
  },
);

// POST /api/download-url
app.post("/api/download-url", async (req, res, next) => {
  try {
    const url = String(req.body.url || "").trim();
    const fileName = sanitizeName(req.body.fileName || "");
    if (!/^https?:\/\//i.test(url)) {
      res.status(400).json({ error: "请提供有效的 http 或 https 链接" });
      return;
    }

    const isBiliOrYT = BILIBILI_PATTERN.test(url) || YOUTUBE_PATTERN.test(url);

    if (isBiliOrYT) {
      // Async yt-dlp download
      const hasYtdlp = await checkYtdlp();
      if (!hasYtdlp) {
        res.status(400).json({
          error: "未检测到 yt-dlp，请先安装：pip install yt-dlp",
        });
        return;
      }

      const jobId = uid();
      downloadJobs.set(jobId, {
        status: "running",
        message: "正在连接，准备下载...",
        fileName: "",
        startedAt: Date.now(),
        url,
      });

      // Fire-and-forget
      runYtdlpDownload(url, jobId)
        .then(async (result) => {
          const { audioFile, thumbnailFile } = result || {};
          downloadJobs.set(jobId, {
            status: "done",
            message: "Download complete",
            fileName: audioFile,
            thumbnailFile: thumbnailFile,
            startedAt: downloadJobs.get(jobId)?.startedAt || Date.now(),
            url,
          });
        })
        .catch((err) => {
          downloadJobs.set(jobId, {
            status: "error",
            message: err.message || "下载失败",
            fileName: "",
            startedAt: downloadJobs.get(jobId)?.startedAt || Date.now(),
            url,
          });
        });

      res.json({
        jobId,
        isAsync: true,
        message: "开始下载，请在下载页面查看进度",
      });
    } else {
      // Direct audio URL download (sync)
      const savedFileName = await downloadDirectUrl(url, fileName);
      const tracks = await listTracks();
      res.json({ message: "下载成功", savedFileName, tracks });
    }
  } catch (err) {
    next(err);
  }
});

// GET /api/download-status/:jobId
app.get("/api/download-status/:jobId", async (req, res, next) => {
  try {
    const job = downloadJobs.get(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: "任务不存在" });
      return;
    }
    const result = { ...job };
    if (job.status === "done") {
      result.tracks = await listTracks();
    }
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/download-jobs/:jobId  (clear finished job)
app.delete("/api/download-jobs/:jobId", (req, res) => {
  downloadJobs.delete(req.params.jobId);
  res.json({ ok: true });
});

// ─── Bilibili Search ───────────────────────────────────────────────────────────

// B站搜索API（使用B站官方搜索接口）
async function searchBilibiliVideos(keyword, page = 1, retries = 3) {
  const searchUrl = `https://api.bilibili.com/x/web-interface/search/type?keyword=${encodeURIComponent(keyword)}&search_type=video&page=${page}&pagesize=10`;
  
  return new Promise((resolve, reject) => {
    const doRequest = (attempt) => {
      https.get(searchUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Referer": "https://search.bilibili.com",
          "Accept": "application/json"
        },
        timeout: 10000 // 10秒超时
      }, (res) => {
        let data = "";
        res.on("data", chunk => data += chunk);
        res.on("end", () => {
          try {
            const json = JSON.parse(data);
            if (json.code !== 0) {
              if (attempt < retries) {
                console.log(`[Search] Attempt ${attempt} failed, retrying...`);
                setTimeout(() => doRequest(attempt + 1), 1000 * attempt);
                return;
              }
              reject(new Error(json.message || "Search failed"));
              return;
            }
            
            const results = (json.data?.result || []).map(item => ({
              id: item.bvid,
              title: item.title?.replace(/<[^>]+>/g, "") || "Unknown",
              url: `https://www.bilibili.com/video/${item.bvid}`,
              thumbnail: item.pic || "",
              duration: item.duration ? parseDuration(item.duration) : 0,
              uploader: item.author || "Unknown",
              description: (item.description || "").substring(0, 100)
            }));
            
            console.log("[Search] First result thumbnail:", results[0]?.thumbnail);
            resolve(results);
          } catch (e) {
            if (attempt < retries) {
              console.log(`[Search] Attempt ${attempt} parse error, retrying...`);
              setTimeout(() => doRequest(attempt + 1), 1000 * attempt);
              return;
            }
            reject(e);
          }
        });
      }).on("error", (err) => {
        if (attempt < retries) {
          console.log(`[Search] Attempt ${attempt} error: ${err.message}, retrying...`);
          setTimeout(() => doRequest(attempt + 1), 1000 * attempt);
          return;
        }
        reject(err);
      }).on("timeout", () => {
        if (attempt < retries) {
          console.log(`[Search] Attempt ${attempt} timeout, retrying...`);
          setTimeout(() => doRequest(attempt + 1), 1000 * attempt);
          return;
        }
        reject(new Error("Search timeout"));
      });
    };
    
    doRequest(1);
  });
}

// 解析B站时长格式 (MM:SS 或 HH:MM:SS)
function parseDuration(durationStr) {
  if (!durationStr) return 0;
  const parts = String(durationStr).split(":").map(Number);
  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  } else if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  return 0;
}

// GET /api/search-bilibili?q=关键词
app.get("/api/search-bilibili", async (req, res, next) => {
  try {
    const query = String(req.query.q || "").trim();
    if (!query) {
      res.status(400).json({ error: "请输入搜索关键词" });
      return;
    }

    console.log("[Search] Bilibili search:", query);
    const results = await searchBilibiliVideos(query);
    console.log("[Search] Found", results.length, "results");
    
    res.json({ results, query });
  } catch (err) {
    console.error("[Search] Bilibili search failed:", err.message);
    res.status(500).json({ error: "搜索失败: " + err.message });
  }
});

// ─── Folders / Favorites ──────────────────────────────────────────────────────

app.get("/api/folders", async (req, res, next) => {
  try {
    res.json(await getFavorites());
  } catch (err) {
    next(err);
  }
});

app.post("/api/folders", async (req, res, next) => {
  try {
    const name = sanitizeName(req.body.name);
    if (!name) {
      res.status(400).json({ error: "名称不能为空" });
      return;
    }
    const fav = await getFavorites();
    fav.folders.push({ id: uid(), name, trackIds: [] });
    await saveFavorites(fav);
    res.json(fav);
  } catch (err) {
    next(err);
  }
});

app.patch("/api/folders/:folderId", async (req, res, next) => {
  try {
    const name = sanitizeName(req.body.name);
    if (!name) {
      res.status(400).json({ error: "名称不能为空" });
      return;
    }
    const fav = await getFavorites();
    const folder = fav.folders.find((f) => f.id === req.params.folderId);
    if (!folder) {
      res.status(404).json({ error: "歌单不存在" });
      return;
    }
    folder.name = name;
    await saveFavorites(fav);
    res.json(fav);
  } catch (err) {
    next(err);
  }
});

app.delete("/api/folders/:folderId", async (req, res, next) => {
  try {
    const fav = await getFavorites();
    const next2 = fav.folders.filter((f) => f.id !== req.params.folderId);
    if (next2.length === fav.folders.length) {
      res.status(404).json({ error: "歌单不存在" });
      return;
    }
    fav.folders = next2;
    await saveFavorites(fav);
    res.json(fav);
  } catch (err) {
    next(err);
  }
});

app.post("/api/folders/:folderId/tracks", async (req, res, next) => {
  try {
    const trackId = String(req.body.trackId || "").trim();
    if (!trackId) {
      res.status(400).json({ error: "缺少歌曲 ID" });
      return;
    }
    const fav = await getFavorites();
    const folder = fav.folders.find((f) => f.id === req.params.folderId);
    if (!folder) {
      res.status(404).json({ error: "歌单不存在" });
      return;
    }
    if (!Array.isArray(folder.trackIds)) folder.trackIds = [];
    if (!folder.trackIds.includes(trackId)) folder.trackIds.push(trackId);
    await saveFavorites(fav);
    res.json(fav);
  } catch (err) {
    next(err);
  }
});

app.delete("/api/folders/:folderId/tracks/:trackId", async (req, res, next) => {
  try {
    const fav = await getFavorites();
    const folder = fav.folders.find((f) => f.id === req.params.folderId);
    if (!folder) {
      res.status(404).json({ error: "歌单不存在" });
      return;
    }
    folder.trackIds = (folder.trackIds || []).filter(
      (id) => id !== req.params.trackId,
    );
    await saveFavorites(fav);
    res.json(fav);
  } catch (err) {
    next(err);
  }
});

// ─── Settings & Background ────────────────────────────────────────────────────

// GET /api/immersion-backgrounds - List immersion background images
app.get("/api/immersion-backgrounds", async (req, res, next) => {
  try {
    await fsp.mkdir(IMMERSION_BG_DIR, { recursive: true });
    const files = await fsp.readdir(IMMERSION_BG_DIR);
    const images = files
      .filter(f => /\.(jpg|jpeg|png|webp|gif|bmp)$/i.test(f))
      .sort()
      .map(f => `/uploads/backgrounds/immersion_backgrounds/${encodeURIComponent(f)}`);
    res.json({ images });
  } catch (err) {
    next(err);
  }
});

app.get("/api/settings", async (req, res, next) => {
  try {
    res.json(await getSettings());
  } catch (err) {
    next(err);
  }
});

app.post(
  "/api/upload-background",
  imageUpload.single("background"),
  async (req, res, next) => {
    try {
      console.log("[Background] Upload request received");
      if (!req.file) {
        res.status(400).json({ error: "请上传图片" });
        return;
      }
      console.log("[Background] Temp file:", req.file.path, "original:", req.file.originalname);
      
      let ext = path.extname(req.file.originalname).toLowerCase();
      if (!ext) ext = inferExt(req.file.mimetype);
      if (!IMAGE_EXTENSIONS.has(ext)) {
        await cleanupTemp([req.file]);
        res.status(400).json({ error: "仅支持 jpg/png/webp/gif" });
        return;
      }
      
      const settings = await getSettings();
      if (settings.backgroundFileName) {
        const old = path.join(
          BACKGROUND_DIR,
          path.basename(settings.backgroundFileName),
        );
        if (await fileExists(old)) await fsp.unlink(old);
      }
      
      const finalName = await uniqueFileName(
        BACKGROUND_DIR,
        `background${ext}`,
      );
      const destPath = path.join(BACKGROUND_DIR, finalName);
      console.log("[Background] Dest path:", destPath);
      
      await fsp.rename(req.file.path, destPath);
      console.log("[Background] File moved");
      
      settings.backgroundFileName = finalName;
      settings.backgroundImage = `/uploads/backgrounds/${encodeURIComponent(finalName)}`;
      await saveSettings(settings);
      console.log("[Background] Settings saved:", settings.backgroundImage);
      
      res.json(settings);
    } catch (err) {
      console.error("[Background] Error:", err.message);
      if (req.file) await cleanupTemp([req.file]);
      next(err);
    }
  },
);

// ─── Upload Cover ─────────────────────────────────────────────────────────────

app.post(
  "/api/upload-cover",
  imageUpload.single("cover"),
  async (req, res, next) => {
    try {
      if (!req.file) {
        res.status(400).json({ error: "No file uploaded" });
        return;
      }
      
      const trackId = req.body.trackId;
      if (!trackId) {
        res.status(400).json({ error: "Track ID is required" });
        return;
      }
      
      console.log("[Cover Upload] Track:", trackId, "File:", req.file.originalname);
      
      // Get track info to determine the directory
      const trackPath = path.join(DOWNLOADS_DIR, trackId);
      const trackDir = path.dirname(trackPath);
      const trackBaseName = path.basename(trackId, path.extname(trackId));
      
      // Generate cover filename based on track name
      const coverExt = path.extname(req.file.originalname) || ".jpg";
      const coverFileName = `${trackBaseName}${coverExt}`;
      const coverPath = path.join(trackDir, coverFileName);
      
      // Remove existing cover files
      const existingFiles = await fsp.readdir(trackDir).catch(() => []);
      for (const file of existingFiles) {
        if (isImage(file) && file !== coverFileName) {
          await fsp.unlink(path.join(trackDir, file)).catch(() => {});
          console.log("[Cover Upload] Removed old cover:", file);
        }
      }
      
      // Move uploaded file to track directory
      await fsp.rename(req.file.path, coverPath);
      console.log("[Cover Upload] Saved to:", coverPath);
      
      // Generate thumbnail URL
      const relativeDir = path.relative(DOWNLOADS_DIR, trackDir);
      const thumbPath = relativeDir !== '.'
        ? path.join(relativeDir, coverFileName).replace(/\\/g, '/')
        : coverFileName;
      const thumbnailUrl = mediaUrl(thumbPath);
      
      res.json({
        success: true,
        thumbnailUrl: thumbnailUrl,
        thumbnailFile: coverFileName,
      });
    } catch (err) {
      console.error("[Cover Upload] Error:", err.message);
      if (req.file) await cleanupTemp([req.file]);
      next(err);
    }
  },
);

// ─── Upload Playlist Cover ─────────────────────────────────────────────────────

app.post(
  "/api/upload-playlist-cover",
  imageUpload.single("cover"),
  async (req, res, next) => {
    try {
      if (!req.file) {
        res.status(400).json({ error: "No file uploaded" });
        return;
      }

      const playlistId = req.body.playlistId;
      if (!playlistId) {
        res.status(400).json({ error: "Playlist ID is required" });
        return;
      }

      console.log("[Playlist Cover Upload] Playlist:", playlistId, "File:", req.file.originalname);

      // Get favorites to verify playlist exists
      const fav = await getFavorites();
      const folder = fav.folders.find((f) => f.id === playlistId);
      if (!folder) {
        res.status(404).json({ error: "Playlist not found" });
        return;
      }

      // Remove existing cover files for this playlist
      const existingFiles = await fsp.readdir(PLAYLIST_COVER_DIR).catch(() => []);
      for (const file of existingFiles) {
        if (file.startsWith(playlistId)) {
          await fsp.unlink(path.join(PLAYLIST_COVER_DIR, file)).catch(() => {});
          console.log("[Playlist Cover Upload] Removed old cover:", file);
        }
      }

      // Generate cover filename based on playlist ID
      const coverExt = path.extname(req.file.originalname) || ".jpg";
      const coverFileName = `${playlistId}${coverExt}`;
      const coverPath = path.join(PLAYLIST_COVER_DIR, coverFileName);

      // Move uploaded file to playlist cover directory
      await fsp.rename(req.file.path, coverPath);
      console.log("[Playlist Cover Upload] Saved to:", coverPath);

      // Generate cover URL
      const coverUrl = `/uploads/playlist-covers/${coverFileName}`;

      // Update playlist data with cover info
      folder.coverUrl = coverUrl;
      folder.coverFile = coverFileName;
      await saveFavorites(fav);

      res.json({
        success: true,
        coverUrl: coverUrl,
        coverFile: coverFileName,
      });
    } catch (err) {
      console.error("[Playlist Cover Upload] Error:", err.message);
      if (req.file) await cleanupTemp([req.file]);
      next(err);
    }
  },
);

// ─── Rename Track ─────────────────────────────────────────────────────────────

app.post("/api/tracks/:trackId(*)/rename", async (req, res, next) => {
  try {
    // Support nested paths with (*)
    const trackId = req.params.trackId || "";
    const newName = String(req.body.newName || "").trim();
    const artist = String(req.body.artist || "").trim();

    if (!trackId || !newName) {
      res.status(400).json({ error: "请提供歌曲ID和新名称" });
      return;
    }

    // trackId may contain subdirectories like "artist/song/file.mp3"
    const oldPath = path.join(DOWNLOADS_DIR, trackId);
    if (!(await fileExists(oldPath))) {
      res.status(404).json({ error: "歌曲不存在" });
      return;
    }

    const ext = path.extname(trackId);
    const oldBase = getBase(path.basename(trackId));
    const oldAudioDir = path.dirname(oldPath);

    // Collect associated files (lyrics, thumbnails) to move along
    const filesToMove = [];

    // Find lyrics file
    const oldLrcPath = path.join(oldAudioDir, `${oldBase}.lrc`);
    if (await fileExists(oldLrcPath)) {
      filesToMove.push({ oldPath: oldLrcPath, suffix: '.lrc' });
    }

    // Find thumbnail file
    const dirEntries = await fsp.readdir(oldAudioDir, { withFileTypes: true });
    const thumbFile = dirEntries.find(e =>
      e.isFile() &&
      e.name.startsWith(oldBase) &&
      (e.name.endsWith('.jpg') || e.name.endsWith('.png') || e.name.endsWith('.webp')) &&
      !isAudio(e.name)
    )?.name;
    if (thumbFile) {
      filesToMove.push({ oldPath: path.join(oldAudioDir, thumbFile), suffix: path.extname(thumbFile) });
    }

    // Parse song name from newName (remove artist part if combined as "歌名 歌手")
    const songNameOnly = artist ? newName.replace(new RegExp(`\\s+${escapeRegex(artist)}$`), '') : newName;
    const sanitizedSongName = sanitizeName(songNameOnly || newName);

    let newAudioPath;
    let newTrackId;

    if (artist) {
      // Organize into artist/song folder
      const artistDir = path.join(DOWNLOADS_DIR, sanitizeName(artist));
      const songDir = path.join(artistDir, sanitizedSongName);
      await fsp.mkdir(songDir, { recursive: true });
      const fileBaseName = `${sanitizedSongName} ${sanitizeName(artist)}`;
      newAudioPath = path.join(songDir, `${fileBaseName}${ext}`);
      newTrackId = path.join(sanitizeName(artist), sanitizedSongName, `${fileBaseName}${ext}`).replace(/\\/g, '/');

      // Move associated files to new directory
      for (const f of filesToMove) {
        const newFilePath = path.join(songDir, `${fileBaseName}${f.suffix}`);
        if (!(await fileExists(newFilePath))) {
          await fsp.rename(f.oldPath, newFilePath);
        }
      }
    } else {
      // No artist - keep in same directory, just rename
      const fileDir = path.dirname(trackId);
      const sanitizedNewName = sanitizeName(newName);
      newTrackId = fileDir !== '.'
        ? path.posix.join(fileDir, `${sanitizedNewName}${ext}`)
        : `${sanitizedNewName}${ext}`;
      newAudioPath = path.join(DOWNLOADS_DIR, newTrackId);

      // Rename associated files in same directory
      for (const f of filesToMove) {
        const newFilePath = path.join(oldAudioDir, `${sanitizedNewName}${f.suffix}`);
        if (!(await fileExists(newFilePath))) {
          await fsp.rename(f.oldPath, newFilePath);
        }
      }
    }

    // Check if target exists
    if (await fileExists(newAudioPath) && newAudioPath !== oldPath) {
      res.status(400).json({ error: "目标文件已存在" });
      return;
    }

    // Move/rename audio file
    await fsp.rename(oldPath, newAudioPath);

    // Clean up empty old directories
    if (artist && oldAudioDir !== path.join(DOWNLOADS_DIR)) {
      try {
        const parentDir = path.dirname(oldAudioDir);
        const remaining = await fsp.readdir(oldAudioDir);
        if (remaining.length === 0) {
          await fsp.rmdir(oldAudioDir);
          // Also clean parent artist dir if empty
          const parentRemaining = await fsp.readdir(parentDir);
          if (parentRemaining.length === 0 && parentDir !== DOWNLOADS_DIR) {
            await fsp.rmdir(parentDir);
          }
        }
      } catch {}
    }
    
    // Update playlists - use full path as trackId
    const fav = await getFavorites();
    fav.folders = fav.folders.map((folder) => ({
      ...folder,
      trackIds: (folder.trackIds || []).map((id) =>
        id === trackId ? newTrackId : id
      ),
    }));
    await saveFavorites(fav);
    
    console.log("[Rename] Renamed:", trackId, "→", newTrackId);
    res.json({ 
      message: "Renamed successfully", 
      oldTrackId: trackId,
      newTrackId: newTrackId,
      tracks: await listTracks(),
      favorites: fav 
    });
  } catch (err) {
    next(err)
  }
});

// ─── Delete Track ─────────────────────────────────────────────────────────────

app.delete("/api/tracks/:trackId(*)", async (req, res, next) => {
  try {
    // Support nested paths with (*)
    const trackId = req.params.trackId || "";
    if (!trackId) {
      res.status(400).json({ error: "Missing trackId" });
      return;
    }
    
    // trackId may contain subdirectories like "artist/song/file.mp3"
    const audioPath = path.join(DOWNLOADS_DIR, trackId);
    if (!(await fileExists(audioPath))) {
      res.status(404).json({ error: "歌曲不存在" });
      return;
    }
    
    // Delete audio file
    await fsp.unlink(audioPath);
    
    // Delete lyrics file in same directory
    const audioDir = path.dirname(audioPath);
    const lrcName = `${getBase(path.basename(trackId))}.lrc`;
    const lrcPath = path.join(audioDir, lrcName);
    if (await fileExists(lrcPath)) await fsp.unlink(lrcPath);
    
    // Delete thumbnail if exists
    const dirEntries = await fsp.readdir(audioDir, { withFileTypes: true });
    const thumbFile = dirEntries.find(e => 
      e.isFile() &&
      e.name.startsWith(getBase(path.basename(trackId))) && 
      (e.name.endsWith('.jpg') || e.name.endsWith('.png') || e.name.endsWith('.webp')) &&
      !isAudio(e.name)
    )?.name;
    if (thumbFile) {
      await fsp.unlink(path.join(audioDir, thumbFile));
    }
    
    // Update playlists - use full path as trackId
    const fav = await getFavorites();
    fav.folders = fav.folders.map((folder) => ({
      ...folder,
      trackIds: (folder.trackIds || []).filter((id) => id !== trackId),
    }));
    await saveFavorites(fav);
    res.json({ message: "已删除", tracks: await listTracks(), favorites: fav });
  } catch (err) {
    next(err);
  }
});

// ─── Organize Files ───────────────────────────────────────────────────────────

app.post("/api/organize-files", async (req, res, next) => {
  try {
    console.log("[Organize] Starting file organization...");
    
    const entries = await fsp.readdir(DOWNLOADS_DIR, { withFileTypes: true });
    const files = entries.filter((e) => e.isFile()).map((e) => e.name);
    
    let organized = 0;
    let skipped = 0;
    const errors = [];
    
    // Group files by base name (song name + artist)
    const fileGroups = new Map();
    
    for (const fileName of files) {
      const baseName = getBase(fileName);
      const ext = path.extname(fileName).toLowerCase();
      
      if (!fileGroups.has(baseName)) {
        fileGroups.set(baseName, { baseName, files: [] });
      }
      fileGroups.get(baseName).files.push({ name: fileName, ext });
    }
    
    // Process each song group
    for (const [baseName, group] of fileGroups) {
      try {
        // Parse "歌曲名 歌手名" pattern
        // Split by space to get artist name (last part)
        const parts = baseName.split(' ');
        if (parts.length < 2) {
          skipped++;
          continue; // Skip files without proper naming
        }
        
        const artistName = parts[parts.length - 1];
        const songName = parts.slice(0, -1).join(' ');
        
        if (!artistName || !songName) {
          skipped++;
          continue;
        }
        
        // Create folder structure: downloads/歌手名/歌曲名/
        const artistDir = path.join(DOWNLOADS_DIR, sanitizeName(artistName));
        const songDir = path.join(artistDir, sanitizeName(songName));
        
        // Create directories
        await fsp.mkdir(artistDir, { recursive: true });
        await fsp.mkdir(songDir, { recursive: true });
        
        // Move files
        for (const file of group.files) {
          const oldPath = path.join(DOWNLOADS_DIR, file.name);
          const newPath = path.join(songDir, file.name);
          
          // Check if target exists
          if (await fileExists(newPath)) {
            // Generate unique name
            const newBase = `${getBase(file.name)}_1`;
            const uniqueName = `${newBase}${file.ext}`;
            const uniquePath = path.join(songDir, uniqueName);
            await fsp.rename(oldPath, uniquePath);
          } else {
            await fsp.rename(oldPath, newPath);
          }
        }
        
        console.log(`[Organize] Moved "${baseName}" to ${artistName}/${songName}/`);
        organized++;
        
      } catch (err) {
        console.error(`[Organize] Error organizing "${baseName}":`, err.message);
        errors.push({ file: baseName, error: err.message });
      }
    }
    
    console.log(`[Organize] Complete: ${organized} songs organized, ${skipped} skipped, ${errors.length} errors`);
    
    res.json({ 
      message: `整理完成：${organized} 首歌曲已整理，${skipped} 个跳过，${errors.length} 个错误`,
      organized,
      skipped,
      errors,
      tracks: await listTracks()
    });
    
  } catch (err) {
    next(err);
  }
});

// ─── Fallback ─────────────────────────────────────────────────────────────────

app.use((req, res) => {
  if (req.path.startsWith("/api/")) {
    res.status(404).json({ error: "接口不存在" });
    return;
  }
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

app.use((err, req, res, _next) => {
  const message = err?.message || "服务器内部错误";
  console.error("[Error]", message);
  res.status(500).json({ error: message });
});

// ─── Start ────────────────────────────────────────────────────────────────────

ensureAppFiles()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Local Music Player running at http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error("Startup failed:", err);
    process.exit(1);
  });
