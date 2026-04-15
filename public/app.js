"use strict";

// ─── State ────────────────────────────────────────────────────────────────────
const state = {
  view: "playing",
  playlistViewId: null,
  tracks: [],
  folders: [],
  settings: { backgroundImage: "", theme: {} },
  currentTrack: null,
  isPlaying: false,
  lyricLines: [],
  activeLyricIndex: -1,
  playMode: "loop", // "loop" | "loop-one" | "shuffle"
  isMuted: false,
  prevVolume: 0.8,
  downloadJobs: new Map(), // jobId -> { status, message, url, intervalId }
  // Listening stats
  listeningStats: loadListeningStats(),
  currentSessionTime: 0, // Accumulated time in current session (seconds)
  // Play counts for each track
  playCounts: loadPlayCounts(),
};

// ─── DOM ──────────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

const audio = $("audioPlayer");
const audioFileInput = $("audioFileInput");
const bgFileInput = $("bgFileInput");
const coverFileInput = $("coverFileInput");
const playlistCoverFileInput = $("playlistCoverFileInput");

let pendingCoverTrackId = null; // Track ID waiting for cover upload
let pendingCoverPlaylistId = null; // Playlist ID waiting for cover upload

const els = {
  // Playing view
  playingBg: $("playingBg"),
  mainDisc: $("mainDisc"),
  barDisc: $("barDisc"),
  playingTitle: $("playingTitle"),
  playingSubtitle: $("playingSubtitle"),
  playingFavoriteBtn: $("playingFavoriteBtn"),
  lyricsStatus: $("lyricsStatus"),
  lyricsScroll: $("lyricsScroll"),
  lyricsPlaceholder: $("lyricsPlaceholder"),
  // Library view
  libraryCount: $("libraryCount"),
  librarySearch: $("librarySearch"),
  uploadTracksBtn: $("uploadTracksBtn"),
  libraryTable: $("libraryTable"),
  libraryBg: $("libraryBg"),
  // Playlist view
  playlistViewTitle: $("playlistViewTitle"),
  playlistViewMeta: $("playlistViewMeta"),
  playlistPlayAllBtn: $("playlistPlayAllBtn"),
  renamePlaylistBtn: $("renamePlaylistBtn"),
  deletePlaylistBtn: $("deletePlaylistBtn"),
  uploadPlaylistCoverBtn: $("uploadPlaylistCoverBtn"),
  playlistTable: $("playlistTable"),
  playlistBg: $("playlistBg"),
  contextMenu: $("contextMenu"),
  // Download view
  downloadUrlInput: $("downloadUrlInput"),
  downloadNameInput: $("downloadNameInput"),
  startDownloadBtn: $("startDownloadBtn"),
  downloadJobList: $("downloadJobList"),
  downloadJobsTitle: $("downloadJobsTitle"),
  // Bilibili search
  bilibiliSearchInput: $("bilibiliSearchInput"),
  searchBilibiliBtn: $("searchBilibiliBtn"),
  searchResults: $("searchResults"),
  searchResultsList: $("searchResultsList"),
  clearSearchBtn: $("clearSearchBtn"),
  // Settings
  uploadBgBtn: $("uploadBgBtn"),
  // Player bar
  barTitle: $("barTitle"),
  barSubtitle: $("barSubtitle"),
  barFavoriteBtn: $("barFavoriteBtn"),
  shuffleBtn: $("shuffleBtn"),
  prevBtn: $("prevBtn"),
  playBtn: $("playBtn"),
  nextBtn: $("nextBtn"),
  loopBtn: $("loopBtn"),
  progressBar: $("progressBar"),
  currentTimeEl: $("currentTimeEl"),
  totalTimeEl: $("totalTimeEl"),
  muteBtn: $("muteBtn"),
  volumeBar: $("volumeBar"),
  gotoPlayingBtn: $("gotoPlayingBtn"),
  // Sidebar
  playlistNav: $("playlistNav"),
  createPlaylistBtn: $("createPlaylistBtn"),
  // Modal
  modalOverlay: $("modalOverlay"),
  modalTitle: $("modalTitle"),
  modalBody: $("modalBody"),
  modalFooter: $("modalFooter"),
  modalCancelBtn: $("modalCancelBtn"),
  modalConfirmBtn: $("modalConfirmBtn"),
  modalCloseBtn: $("modalCloseBtn"),
  // Toast
  toastContainer: $("toastContainer"),
};

// ─── Utilities ────────────────────────────────────────────────────────────────
function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function escapeHtml(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "请求失败");
  return data;
}

// ─── Listening Stats ──────────────────────────────────────────────────────────
function loadListeningStats() {
  try {
    const stored = localStorage.getItem('listeningStats');
    return stored ? JSON.parse(stored) : {};
  } catch {
    return {};
  }
}

function saveListeningStats(stats) {
  localStorage.setItem('listeningStats', JSON.stringify(stats));
}

// ─── Play Counts ──────────────────────────────────────────────────────────────
function loadPlayCounts() {
  try {
    const stored = localStorage.getItem('playCounts');
    return stored ? JSON.parse(stored) : {};
  } catch {
    return {};
  }
}

function savePlayCounts(counts) {
  localStorage.setItem('playCounts', JSON.stringify(counts));
}

function recordPlay(trackId) {
  if (!trackId) return;
  state.playCounts[trackId] = (state.playCounts[trackId] || 0) + 1;
  savePlayCounts(state.playCounts);
}

function getTodayKey() {
  return new Date().toISOString().split('T')[0]; // YYYY-MM-DD
}

function recordListeningTime(seconds) {
  if (seconds <= 0) return;
  
  const today = getTodayKey();
  state.listeningStats[today] = (state.listeningStats[today] || 0) + seconds;
  saveListeningStats(state.listeningStats);
  
  // Update stats display if visible
  updateStatsDisplay();
}

function formatListeningTime(totalSeconds) {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);
  
  if (hours > 0) {
    return `${hours}小时${minutes}分钟`;
  } else if (minutes > 0) {
    return `${minutes}分${seconds}秒`;
  } else {
    return `${seconds}秒`;
  }
}

function getStatsSummary() {
  const today = getTodayKey();
  const stats = state.listeningStats;
  
  // Today
  const todaySeconds = stats[today] || 0;
  
  // This week (last 7 days)
  let weekSeconds = 0;
  for (let i = 0; i < 7; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toISOString().split('T')[0];
    weekSeconds += stats[key] || 0;
  }
  
  // This month (last 30 days)
  let monthSeconds = 0;
  for (let i = 0; i < 30; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toISOString().split('T')[0];
    monthSeconds += stats[key] || 0;
  }
  
  // Total all time
  const totalSeconds = Object.values(stats).reduce((sum, s) => sum + s, 0);
  
  return { today: todaySeconds, week: weekSeconds, month: monthSeconds, total: totalSeconds };
}

function saveCurrentSessionTime() {
  // Save any remaining accumulated time
  if (typeof accumulatedTime !== 'undefined' && accumulatedTime > 0) {
    const remainingSeconds = Math.floor(accumulatedTime);
    if (remainingSeconds > 0) {
      recordListeningTime(remainingSeconds);
    }
    accumulatedTime = 0;
    lastSaveSecond = 0;
  }
  
  // Also update library stats if visible
  if (state.view === "library") {
    renderLibraryStats();
  }
}

function updateStatsDisplay() {
  const statsEl = document.getElementById('statsDisplay');
  if (!statsEl) return;
  
  const summary = getStatsSummary();
  statsEl.innerHTML = `
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-value">${formatListeningTime(summary.today)}</div>
        <div class="stat-label">今日听歌</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${formatListeningTime(summary.week)}</div>
        <div class="stat-label">近7天</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${formatListeningTime(summary.month)}</div>
        <div class="stat-label">近30天</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${formatListeningTime(summary.total)}</div>
        <div class="stat-label">累计总时长</div>
      </div>
    </div>
  `;
}

// ─── Library Stats Display (Charts & Circle Progress) ──────────────────────────
function renderLibraryStats() {
  // Support both library page and stats page elements
  const todayCircleFill = document.getElementById('todayCircleFill');
  const todayTimeText = document.getElementById('todayTimeText');
  const weeklyChart = document.getElementById('weeklyChart');
  // Stats page elements
  const statsCircleFill = document.querySelector('#view-stats .circle-fill');
  const todayListeningTime = document.getElementById('todayListeningTime');
  
  const hasLibraryElements = todayCircleFill && todayTimeText;
  const hasStatsElements = statsCircleFill && todayListeningTime;
  
  if (!weeklyChart && !hasLibraryElements && !hasStatsElements) return;
  
  const stats = state.listeningStats;
  const today = getTodayKey();
  
  // Today's listening time
  const todaySeconds = stats[today] || 0;
  const todayMinutes = Math.floor(todaySeconds / 60);
  
  // Update circle progress (max 2 hours = 120 minutes for 100%)
  const maxMinutes = 120;
  const percentage = Math.min(todayMinutes / maxMinutes, 1);
  const circumference = 2 * Math.PI * 45; // r=45
  const offset = circumference - (percentage * circumference);
  
  // Format time text
  let timeText;
  if (todayMinutes >= 60) {
    const hours = Math.floor(todayMinutes / 60);
    const mins = todayMinutes % 60;
    timeText = mins > 0 ? `${hours}小时${mins}分` : `${hours}小时`;
  } else if (todayMinutes > 0) {
    timeText = `${todayMinutes}分钟`;
  } else {
    const seconds = todaySeconds % 60;
    timeText = seconds > 0 ? `${seconds}秒` : '0分钟';
  }
  
  // Update library page circle
  if (todayCircleFill) {
    todayCircleFill.style.strokeDasharray = `${circumference}`;
    todayCircleFill.style.strokeDashoffset = `${offset}`;
    
    // Color based on listening time
    let strokeColor = 'url(#circleGradient)';
    if (todayMinutes === 0) strokeColor = 'rgba(255,255,255,0.2)';
    else if (todayMinutes < 30) strokeColor = '#ff6b9d'; // Pink
    else if (todayMinutes < 60) strokeColor = '#feca57'; // Yellow
    else strokeColor = '#20c997'; // Green
    todayCircleFill.setAttribute('stroke', strokeColor);
  }
  if (todayTimeText) todayTimeText.textContent = timeText;
  
  // Update stats page circle (r=54, viewBox 0 0 120 120)
  if (statsCircleFill) {
    const statsCircumference = 2 * Math.PI * 54; // r=54 for stats page
    const statsOffset = statsCircumference - (percentage * statsCircumference);
    
    statsCircleFill.style.strokeDasharray = `${statsCircumference}`;
    statsCircleFill.style.strokeDashoffset = `${statsOffset}`;
    
    // Color based on listening time (stats page has its own gradient)
    // Update gradient stops based on listening time
    const stops = statsCircleFill.parentElement?.querySelectorAll('stop');
    if (stops && stops.length >= 2) {
      if (todayMinutes === 0) {
        stops[0].setAttribute('stop-color', '#6c757d'); // Gray
        stops[1].setAttribute('stop-color', '#adb5bd');
      } else if (todayMinutes < 30) {
        stops[0].setAttribute('stop-color', '#ff6b9d'); // Pink
        stops[1].setAttribute('stop-color', '#feca57');
      } else if (todayMinutes < 60) {
        stops[0].setAttribute('stop-color', '#feca57'); // Yellow
        stops[1].setAttribute('stop-color', '#20c997');
      } else {
        stops[0].setAttribute('stop-color', '#20c997'); // Green
        stops[1].setAttribute('stop-color', '#00d2ff');
      }
    }
  }
  if (todayListeningTime) todayListeningTime.textContent = timeText;
  
  // Render weekly chart (last 7 days)
  if (!weeklyChart) return;
  
  const days = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const chartData = [];
  let maxValue = 0;
  
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toISOString().split('T')[0];
    const dayName = i === 0 ? '今天' : days[d.getDay()];
    const value = stats[key] || 0;
    const minutes = Math.floor(value / 60);
    
    chartData.push({ day: dayName, minutes, seconds: value });
    maxValue = Math.max(maxValue, minutes);
  }
  
  // Generate chart bars HTML
  weeklyChart.innerHTML = chartData.map((item, index) => {
    // Calculate height: if has data, scale relative to max; otherwise show minimal bar
    let heightPercent;
    if (maxValue === 0) {
      heightPercent = 4; // All empty, show minimal bars
    } else if (item.minutes === 0) {
      heightPercent = 4; // No data for this day, minimal bar
    } else {
      heightPercent = Math.max((item.minutes / maxValue) * 100, 4);
    }
    
    const isToday = index === 6;
    const formattedTime = item.minutes >= 60 
      ? `${Math.floor(item.minutes / 60)}h${item.minutes % 60}m`
      : `${item.minutes}m`;
    
    return `
      <div class="chart-bar-wrapper" title="${item.day}: ${formatListeningTime(item.seconds)}">
        <div class="chart-bar ${isToday ? 'is-today' : ''}" style="height: ${heightPercent}%"></div>
        <div class="chart-bar-label">${item.day}</div>
        <div class="chart-bar-value">${formattedTime}</div>
      </div>
    `;
  }).join('');
}

// ─── Toast ────────────────────────────────────────────────────────────────────
function showToast(message, type = "info") {
  const el = document.createElement("div");
  el.className = `toast toast--${type}`;
  el.textContent = message;
  els.toastContainer.appendChild(el);
  requestAnimationFrame(() => el.classList.add("is-visible"));
  setTimeout(() => {
    el.classList.remove("is-visible");
    setTimeout(() => el.remove(), 280);
  }, 2800);
}

// ─── Top Songs ────────────────────────────────────────────────────────────────
function renderTopSongs() {
  const container = document.getElementById('topSongsList');
  if (!container) return;
  
  // Get play counts and sort
  const playCounts = state.playCounts;
  const sortedTracks = Object.entries(playCounts)
    .map(([trackId, count]) => {
      const track = state.tracks.find(t => t.id === trackId);
      return { track, count, trackId };
    })
    .filter(item => item.track) // Only include tracks that exist
    .sort((a, b) => b.count - a.count)
    .slice(0, 8); // Top 8
  
  if (sortedTracks.length === 0) {
    container.innerHTML = `
      <div class="top-songs-empty">
        <p>还没有听歌记录</p>
        <p class="top-songs-hint">播放歌曲后会在这里显示排行</p>
      </div>
    `;
    return;
  }
  
  container.innerHTML = sortedTracks.map((item, index) => {
    const { track, count } = item;
    const rank = index + 1;
    const thumbnail = track.thumbnailUrl || '';
    const rankClass = rank <= 3 ? `rank-${rank}` : '';
    
    // Parse artist from title (format: "歌曲名 歌手名")
    const parts = track.title.split(/\s+/);
    let songName = track.title;
    let artistName = '';
    
    if (parts.length >= 2) {
      const lastPart = parts[parts.length - 1];
      if (lastPart.length >= 2 && lastPart.length <= 10) {
        artistName = lastPart;
        songName = parts.slice(0, -1).join(' ');
      }
    }
    
    return `
      <div class="top-song-card" data-track-id="${track.id}" onclick="playTrack('${track.id}', true)">
        <div class="top-song-card-cover">
          ${thumbnail ? `<img src="${thumbnail}" alt="" loading="lazy">` : '<div class="cover-placeholder"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg></div>'}
          <div class="top-song-card-rank ${rankClass}">${rank}</div>
          <div class="top-song-card-play"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></div>
        </div>
        <div class="top-song-card-info">
          <div class="top-song-card-title" title="${escapeHtml(songName)}">${escapeHtml(songName)}</div>
          <div class="top-song-card-artist" title="${escapeHtml(artistName || '未知歌手')}">${escapeHtml(artistName || '未知歌手')}</div>
          <div class="top-song-card-count">${count} 次播放</div>
        </div>
      </div>
    `;
  }).join('');
}

function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ─── Listening Calendar ─────────────────────────────────────────────────────
let calendarCurrentDate = new Date();
let calendarSelectedDate = getTodayKey();

function renderListeningCalendar() {
  const year = calendarCurrentDate.getFullYear();
  const month = calendarCurrentDate.getMonth();
  
  // Update title
  const titleEl = document.getElementById('calendarTitle');
  if (titleEl) {
    titleEl.textContent = `${year}年${month + 1}月`;
  }
  
  const daysContainer = document.getElementById('calendarDays');
  if (!daysContainer) return;
  
  // Get first day of month and last day
  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  const daysInMonth = lastDay.getDate();
  const startDayOfWeek = firstDay.getDay(); // 0 = Sunday
  
  // Get days from previous month
  const prevMonthLastDay = new Date(year, month, 0).getDate();
  
  // Get stats data
  const stats = state.listeningStats;
  const today = getTodayKey();
  
  let html = '';
  
  // Previous month days
  for (let i = startDayOfWeek - 1; i >= 0; i--) {
    const day = prevMonthLastDay - i;
    html += `<div class="calendar-day other-month">${day}</div>`;
  }
  
  // Current month days
  for (let day = 1; day <= daysInMonth; day++) {
    const dateKey = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const seconds = stats[dateKey] || 0;
    const minutes = Math.floor(seconds / 60);
    
    // Determine color level
    let levelClass = 'no-data';
    if (minutes > 0) {
      if (minutes < 30) levelClass = 'level-1';
      else if (minutes < 60) levelClass = 'level-2';
      else if (minutes < 120) levelClass = 'level-3';
      else levelClass = 'level-4';
    }
    
    // Check if today
    const isToday = dateKey === today;
    const todayClass = isToday ? 'is-today' : '';
    
    // Check if selected
    const isSelected = calendarSelectedDate === dateKey;
    const selectedClass = isSelected ? 'is-selected' : '';
    
    html += `<div class="calendar-day ${levelClass} ${todayClass} ${selectedClass}" data-date="${dateKey}" onclick="selectCalendarDate('${dateKey}')">${day}</div>`;
  }
  
  // Next month days to fill the grid
  const totalCells = startDayOfWeek + daysInMonth;
  const remainingCells = 42 - totalCells; // 6 rows * 7 days = 42
  for (let day = 1; day <= remainingCells; day++) {
    html += `<div class="calendar-day other-month">${day}</div>`;
  }
  
  daysContainer.innerHTML = html;

  // Auto-update selected date info
  if (calendarSelectedDate) {
    const stats = state.listeningStats;
    const seconds = stats[calendarSelectedDate] || 0;
    const infoEl = document.getElementById('calendarSelectedInfo');
    if (infoEl) {
      const [y, m, d] = calendarSelectedDate.split('-');
      infoEl.innerHTML = `
        <span class="selected-date">${y}年${m}月${d}日</span>
        <span class="selected-time">${seconds > 0 ? formatListeningTime(seconds) : '无记录'}</span>
      `;
    }
  }
}

function selectCalendarDate(dateKey) {
  calendarSelectedDate = dateKey;
  renderListeningCalendar(); // Re-render to update selection
  
  const stats = state.listeningStats;
  const seconds = stats[dateKey] || 0;
  
  // Update info display
  const infoEl = document.getElementById('calendarSelectedInfo');
  if (infoEl) {
    const [year, month, day] = dateKey.split('-');
    infoEl.innerHTML = `
      <span class="selected-date">${year}年${month}月${day}日</span>
      <span class="selected-time">${seconds > 0 ? formatListeningTime(seconds) : '无记录'}</span>
    `;
  }
}

function changeCalendarMonth(delta) {
  calendarCurrentDate.setMonth(calendarCurrentDate.getMonth() + delta);
  renderListeningCalendar();
}

let calendarEventsInitialized = false;
function initCalendarEvents() {
  if (calendarEventsInitialized) return;
  calendarEventsInitialized = true;
  document.getElementById('prevMonth')?.addEventListener('click', () => changeCalendarMonth(-1));
  document.getElementById('nextMonth')?.addEventListener('click', () => changeCalendarMonth(1));
}

// ─── Modal ────────────────────────────────────────────────────────────────────
let _modalConfirmCb = null;
let _modalCancelCb = null;

function openModal({
  title,
  body,
  confirmText = "确定",
  cancelText = "取消",
  showCancel = true,
  onConfirm,
  onCancel,
}) {
  els.modalTitle.textContent = title;
  els.modalBody.innerHTML = body;
  els.modalConfirmBtn.textContent = confirmText;
  els.modalCancelBtn.textContent = cancelText;
  els.modalCancelBtn.style.display = showCancel ? "" : "none";
  _modalConfirmCb = onConfirm || null;
  _modalCancelCb = onCancel || null;
  els.modalOverlay.classList.remove("hidden");
  const firstInput = els.modalBody.querySelector("input, select, textarea");
  if (firstInput) setTimeout(() => firstInput.focus(), 60);
}

function closeModal() {
  els.modalOverlay.classList.add("hidden");
  _modalConfirmCb = null;
  _modalCancelCb = null;
}

function confirmModal({
  title,
  message,
  confirmText = "确定",
  danger = false,
  onConfirm,
}) {
  openModal({
    title,
    body: `<p class="modal-confirm-text">${escapeHtml(message)}</p>`,
    confirmText,
    showCancel: true,
    onConfirm,
  });
  if (danger) els.modalConfirmBtn.classList.add("btn-danger");
  else els.modalConfirmBtn.classList.remove("btn-danger");
}

function inputModal({
  title,
  label,
  placeholder = "",
  value = "",
  confirmText = "确定",
  cancelText = "取消",
  onConfirm,
  onCancel,
}) {
  openModal({
    title,
    body: `
      <label class="modal-label">${escapeHtml(label)}
        <input class="modal-input" id="modalInput" type="text"
               placeholder="${escapeHtml(placeholder)}"
               value="${escapeHtml(value)}" maxlength="60">
      </label>`,
    confirmText,
    cancelText,
    showCancel: true,
    onConfirm: () => {
      const val = ($("modalInput")?.value || "").trim();
      if (onConfirm) onConfirm(val);
    },
    onCancel: () => {
      if (onCancel) onCancel();
    },
  });
}

// ─── View Switching ───────────────────────────────────────────────────────────
const VIEW_IDS = ["playing", "library", "playlist", "stats", "settings"];
let previousView = "library"; // Track view before settings

function switchView(viewName, params = {}) {
  // Save previous view before switching to settings
  if (viewName === "settings" && state.view && state.view !== "settings") {
    previousView = state.view;
  }
  // Pre-apply playlist background before showing view to prevent flash
  if (viewName === "playlist" && params.folderId) {
    state.playlistViewId = params.folderId;
    const folder = state.folders.find((f) => f.id === params.folderId);
    if (folder) {
      // Set background before view becomes visible
      if (els.playlistBg) {
        els.playlistBg.style.backgroundImage = folder.coverUrl
          ? `url("${folder.coverUrl}")`
          : "";
      }
      // Set cover art before view becomes visible
      const coverArtEl = document.querySelector(".playlist-cover-art");
      if (coverArtEl) {
        if (folder.coverUrl) {
          coverArtEl.style.backgroundImage = `url("${folder.coverUrl}")`;
          coverArtEl.style.backgroundSize = "cover";
          coverArtEl.style.backgroundPosition = "center";
          coverArtEl.innerHTML = "";
        } else {
          coverArtEl.style.backgroundImage = "";
          coverArtEl.innerHTML = `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`;
        }
      }
    }
  }

  VIEW_IDS.forEach((id) => {
    const el = $(`view-${id}`);
    if (el) el.classList.toggle("hidden", id !== viewName);
  });

  // Update sidebar nav active state
  document.querySelectorAll(".nav-item[data-view]").forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.view === viewName);
  });
  document.querySelectorAll(".playlist-nav-item").forEach((btn) => {
    btn.classList.remove("is-active");
  });

  state.view = viewName;

  if (viewName === "playlist" && params.folderId) {
    renderPlaylistView();
    // Highlight in sidebar
    const navItem = document.querySelector(
      `.playlist-nav-item[data-folder-id="${CSS.escape(params.folderId)}"]`,
    );
    if (navItem) navItem.classList.add("is-active");
  }

  // Leaving playing view - restore original background if in immersive mode
  if (state.view === "playing" && viewName !== "playing" && isImmersiveMode) {
    applyBackground();
  }

  if (viewName === "library") {
    renderLibrary();
    renderLibraryStats();
  }
  if (viewName === "playing") {
    scrollToActiveLyric();
    // If immersive mode is active, apply the current immersion background
    if (isImmersiveMode && immersionImages.length > 0) {
      applyImmersionBackground(immersionImages[immersionIndex]);
    }
  }
  if (viewName === "settings") {
    updateStatsDisplay();
  }
  if (viewName === "stats") {
    initCalendarEvents();
    renderTopSongs();
    renderListeningCalendar();
  }
}

// ─── Theme & Background ───────────────────────────────────────────────────────
function applyBackground(forceRefresh = false) {
  const img = state.settings?.backgroundImage;

  // 只应用到播放页和音乐列表页，不应用到歌单页（歌单使用自己的封面）
  const bgElements = [els.playingBg, els.libraryBg].filter(Boolean);

  if (bgElements.length === 0) return;

  // 如果有自定义背景图，使用图片
  if (img) {
    // 只在强制刷新时加时间戳（如上传新背景后），平时不加避免重新加载
    const imgUrl = forceRefresh
      ? (img.includes('?') ? `${img}&t=${Date.now()}` : `${img}?t=${Date.now()}`)
      : img;

    bgElements.forEach(bg => {
      bg.style.backgroundImage = `linear-gradient(rgba(15, 12, 23, 0.3), rgba(15, 12, 23, 0.5)), url("${imgUrl}")`;
      bg.style.backgroundSize = 'cover';
      bg.style.backgroundPosition = 'center';
      bg.style.backgroundRepeat = 'no-repeat';
      bg.style.backgroundAttachment = 'fixed';
    });
  } else {
    // 清除自定义背景，恢复默认
    bgElements.forEach(bg => {
      bg.style.backgroundImage = '';
      bg.style.backgroundSize = '';
      bg.style.backgroundPosition = '';
      bg.style.backgroundRepeat = '';
      bg.style.backgroundAttachment = '';
    });
    console.log("[Client] Using CSS default background");
  }
}

// ─── Sidebar Playlist Nav ─────────────────────────────────────────────────────
function renderSidebarPlaylists() {
  if (!els.playlistNav) return;
  if (!state.folders.length) {
    els.playlistNav.innerHTML = `<div style="padding:6px 18px;font-size:0.8rem;color:var(--text-soft)">暂无歌单</div>`;
    return;
  }
  els.playlistNav.innerHTML = state.folders
    .map((f) => {
      const count = (f.trackIds || []).length;
      const active =
        state.view === "playlist" && state.playlistViewId === f.id
          ? " is-active"
          : "";
      return `
      <button class="playlist-nav-item${active}" data-folder-id="${escapeHtml(f.id)}">
        <span class="playlist-nav-icon">💿</span>
        <span class="playlist-nav-name">${escapeHtml(f.name)}</span>
        <span class="playlist-nav-count">${count}</span>
      </button>`;
    })
    .join("");
}

// ─── Library Rendering ────────────────────────────────────────────────────────
function renderLibrary() {
  const keyword = (els.librarySearch?.value || "").trim().toLowerCase();
  const tracks = keyword
    ? state.tracks.filter(
        (t) =>
          (t.title || "").toLowerCase().includes(keyword) ||
          (t.fileName || "").toLowerCase().includes(keyword),
      )
    : state.tracks;

  if (els.libraryCount) {
    els.libraryCount.textContent = `${state.tracks.length} 首歌曲`;
  }

  if (!tracks.length) {
    els.libraryTable.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg></div>
        <div class="empty-state-title">${keyword ? "没有匹配的歌曲" : "音乐库是空的"}</div>
        <div class="empty-state-desc">${keyword ? "试试其他关键词" : "点击右上角「导入音乐」添加本地歌曲"}</div>
      </div>`;
    return;
  }

  els.libraryTable.innerHTML = tracks
    .map((t, i) => buildTrackRow(t, i + 1, "library"))
    .join("");
}

function getSongName(track) {
  if (track.artist) {
    // Remove artist from title if it's at the end
    const idx = track.title.lastIndexOf(track.artist);
    if (idx > 0) {
      return track.title.substring(0, idx).trim();
    }
    return track.title;
  }
  // No artist field - try to extract from title pattern "歌名 歌手名"
  const parts = track.title.split(/\s+/);
  if (parts.length >= 2) {
    const lastPart = parts[parts.length - 1];
    if (lastPart.length >= 2 && lastPart.length <= 10) {
      return parts.slice(0, -1).join(" ");
    }
  }
  return track.title;
}

function getArtistName(track) {
  if (track.artist) return track.artist;
  // Try to extract from title pattern "歌名 歌手名"
  const parts = track.title.split(/\s+/);
  if (parts.length >= 2) {
    const lastPart = parts[parts.length - 1];
    if (lastPart.length >= 2 && lastPart.length <= 10) {
      return lastPart;
    }
  }
  return "";
}

function buildTrackRow(track, index, context) {
  const isActive = state.currentTrack?.id === track.id;
  const isPlaying = isActive && state.isPlaying;
  const isInst = isInstrumentalTrack(track.id);
  const playBtn = isInst 
    ? `<button class="row-btn row-btn--play" data-action="play-and-view" data-track-id="${escapeHtml(track.id)}" title="纯音乐"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg></button>`
    : isPlaying
    ? `<button class="row-btn row-btn--play is-playing" data-action="play-and-view" data-track-id="${escapeHtml(track.id)}" title="暂停"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg></button>`
    : `<button class="row-btn row-btn--play" data-action="play-and-view" data-track-id="${escapeHtml(track.id)}" title="播放"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></button>`;
  const removeBtn =
    context === "playlist"
      ? `<button class="row-btn row-btn--danger" data-action="remove-from-playlist" data-track-id="${escapeHtml(track.id)}" title="从歌单移除">✕</button>`
      : `<button class="row-btn row-btn--danger" data-action="delete-track" data-track-id="${escapeHtml(track.id)}" title="删除">✕</button>`;

  return `
    <div class="track-row${isActive ? " is-active" : ""}" data-track-id="${escapeHtml(track.id)}">
      <div class="track-index">
        <span class="track-num">${index}</span>
        <span class="track-playing-icon"><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg></span>
      </div>
      <div class="track-info">
        <div class="track-title">${escapeHtml(getSongName(track))}</div>
        <div class="track-artist">${escapeHtml(getArtistName(track))}</div>
      </div>
      <div class="col-badge">${playBtn}</div>
      <div class="track-row-actions">
        <button class="row-btn" data-action="upload-cover" data-track-id="${escapeHtml(track.id)}" title="上传封面"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg></button>
        <button class="row-btn" data-action="add-to-playlist" data-track-id="${escapeHtml(track.id)}" title="加入歌单"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg></button>
        ${removeBtn}
      </div>
    </div>`;
}

// ─── Playlist View Rendering ──────────────────────────────────────────────────
function renderPlaylistView() {
  const folder = state.folders.find((f) => f.id === state.playlistViewId);
  if (!folder) return;

  if (els.playlistViewTitle) els.playlistViewTitle.textContent = folder.name;

  // Set playlist background using cover image
  if (els.playlistBg) {
    if (folder.coverUrl) {
      els.playlistBg.style.backgroundImage = `url("${folder.coverUrl}")`;
    } else {
      els.playlistBg.style.backgroundImage = "";
    }
  }

  // Set playlist cover art (top-left floating element)
  const coverArtEl = document.querySelector(".playlist-cover-art");
  if (coverArtEl) {
    if (folder.coverUrl) {
      coverArtEl.style.backgroundImage = `url("${folder.coverUrl}")`;
      coverArtEl.style.backgroundSize = "cover";
      coverArtEl.style.backgroundPosition = "center";
      coverArtEl.innerHTML = ""; // Remove the SVG icon
    } else {
      coverArtEl.style.backgroundImage = "";
      // Restore the SVG icon if no cover
      coverArtEl.innerHTML = `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`;
    }
  }

  const tracks = state.tracks.filter((t) =>
    (folder.trackIds || []).includes(t.id),
  );
  if (els.playlistViewMeta) {
    els.playlistViewMeta.textContent = `${tracks.length} 首歌曲`;
  }

  if (!tracks.length) {
    els.playlistTable.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/></svg></div>
        <div class="empty-state-title">歌单是空的</div>
        <div class="empty-state-desc">在本地音乐中点击收藏按钮添加歌曲到此歌单</div>
      </div>`;
    return;
  }

  els.playlistTable.innerHTML = tracks
    .map((t, i) => buildTrackRow(t, i + 1, "playlist"))
    .join("");
}

// ─── Playing View ─────────────────────────────────────────────────────────────
function renderPlayingView() {
  const track = state.currentTrack;

  if (!track) {
    els.playingTitle.textContent = "Not Playing";
    els.playingSubtitle.textContent = "Select a song from library";
    els.barTitle.textContent = "Not Playing";
    els.barSubtitle.textContent = "";
    // Reset disc thumbnail
    if (els.mainDisc) {
      els.mainDisc.classList.remove("has-thumbnail");
      els.mainDisc.style.backgroundImage = "";
    }
    return;
  }

  // 从标题提取歌名和歌手（格式：歌名 歌手）
  const parts = track.title.split(/\s+/);
  let songName = track.title;
  let artistName = "";
  
  if (parts.length >= 2) {
    // 最后一部分通常是歌手名
    const lastPart = parts[parts.length - 1];
    if (lastPart.length >= 2 && lastPart.length <= 10) {
      artistName = lastPart;
      songName = parts.slice(0, -1).join(" ");
    }
  }
  
  els.playingTitle.textContent = songName;
  els.playingSubtitle.textContent = artistName || "本地音乐";
  els.barTitle.textContent = songName;
  els.barSubtitle.textContent = artistName || "";
  
  // Update document title
  document.title = artistName ? `${songName} - ${artistName}` : songName;
  
  // Set disc thumbnail if available
  if (els.mainDisc) {
    console.log("[Player] Track thumbnailUrl:", track.thumbnailUrl, "thumbnailFile:", track.thumbnailFile);
    if (track.thumbnailUrl) {
      els.mainDisc.classList.add("has-thumbnail");
      // Preload image before applying
      const img = new Image();
      img.onload = () => {
        els.mainDisc.style.setProperty("--thumbnail-url", `url("${track.thumbnailUrl}")`);
        els.mainDisc.style.backgroundImage = `url("${track.thumbnailUrl}")`;
        console.log("[Player] Set disc thumbnail:", track.thumbnailUrl);
      };
      img.src = track.thumbnailUrl;
    } else {
      els.mainDisc.classList.remove("has-thumbnail");
      els.mainDisc.style.removeProperty("--thumbnail-url");
      els.mainDisc.style.backgroundImage = "";
      console.log("[Player] No thumbnail, using default disc");
    }
  }
}

function setDiscSpinning(spinning) {
  if (els.mainDisc) els.mainDisc.classList.toggle("spinning", spinning);
  if (els.barDisc) els.barDisc.classList.toggle("spinning", spinning);
}

// ─── LRC Parser ───────────────────────────────────────────────────────────────
function parseLrc(text) {
  const lines = [];
  for (const row of String(text || "").split(/\r?\n/)) {
    const tags = [
      ...row.matchAll(/\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g),
    ];
    if (!tags.length) continue;
    const content = row.replace(/\[[^\]]+\]/g, "").trim() || "♪";
    for (const m of tags) {
      const t =
        Number(m[1]) * 60 +
        Number(m[2]) +
        Number((m[3] || "0").padEnd(3, "0").slice(0, 3)) / 1000;
      lines.push({ time: t, text: content });
    }
  }
  return lines.sort((a, b) => a.time - b.time);
}

// ─── Lyrics Rendering ─────────────────────────────────────────────────────────
function renderLyrics() {
  if (!els.lyricsScroll) return;

  if (!state.currentTrack) {
    els.lyricsStatus.textContent = "歌词";
    els.lyricsScroll.innerHTML = `
      <div class="lyrics-placeholder">
        <p>暂无歌词</p>
        <span>Will auto-fetch lyrics from LRCLIB when playing</span>
      </div>`;
    return;
  }

  // If instrumental track, show "纯音乐~"
  if (isInstrumentalTrack(state.currentTrack.id)) {
    els.lyricsStatus.textContent = "纯音乐";
    els.lyricsScroll.innerHTML = `
      <div class="lyrics-list">
        <span class="lyric-line is-active" style="font-size:1.2rem;opacity:0.8">纯音乐~</span>
      </div>`;
    return;
  }

  if (!state.lyricLines.length) {
    els.lyricsStatus.textContent = "歌词匹配中…";
    els.lyricsScroll.innerHTML = `
      <div class="lyrics-placeholder">
        <p>暂无歌词</p>
        <span>正在尝试自动匹配歌词，或歌曲暂无匹配结果</span>
        <button class="btn btn-primary" onclick="markCurrentAsInstrumental()" style="margin-top: 20px;">
          🎵 标记为纯音乐
        </button>
      </div>`;
    return;
  }

  els.lyricsStatus.textContent = "歌词";

  const html = state.lyricLines
    .map((line, i) => {
      const diff = Math.abs(i - state.activeLyricIndex);
      let cls = "lyric-line";
      if (i === state.activeLyricIndex) cls += " is-active";
      else if (diff === 1) cls += " is-near";
      return `<span class="${cls}" data-lyric-index="${i}">${escapeHtml(line.text)}</span>`;
    })
    .join("");

  els.lyricsScroll.innerHTML = `<div class="lyrics-list">${html}</div>`;
  scrollToActiveLyric();
}

function scrollToActiveLyric() {
  if (state.activeLyricIndex < 0 || !els.lyricsScroll) return;
  const el = els.lyricsScroll.querySelector(
    `[data-lyric-index="${state.activeLyricIndex}"]`,
  );
  if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
}

function syncLyrics() {
  if (!state.lyricLines.length) return;
  const cur = audio.currentTime || 0;
  let idx = -1;
  for (let i = 0; i < state.lyricLines.length; i++) {
    const next = state.lyricLines[i + 1];
    if (cur >= state.lyricLines[i].time && (!next || cur < next.time)) {
      idx = i;
      break;
    }
  }
  if (idx !== state.activeLyricIndex) {
    state.activeLyricIndex = idx;
    // Only re-render active line classes without full rebuild
    if (els.lyricsScroll) {
      els.lyricsScroll.querySelectorAll(".lyric-line").forEach((el, i) => {
        const diff = Math.abs(i - idx);
        el.classList.toggle("is-active", i === idx);
        el.classList.toggle("is-near", diff === 1 && i !== idx);
      });
      scrollToActiveLyric();
    }
  }
}

async function loadLyrics(trackId) {
  state.lyricLines = [];
  state.activeLyricIndex = -1;
  
  // 检查是否为纯音乐
  if (isInstrumentalTrack(trackId)) {
    state.lyricLines = [{ time: 0, text: "纯音乐~" }];
    state.activeLyricIndex = 0;
    renderLyrics();
    return;
  }
  
  // 显示加载中状态，而不是"暂无歌词"
  if (els.lyricsScroll && trackId) {
    els.lyricsStatus.textContent = "歌词加载中…";
    els.lyricsScroll.innerHTML = `
      <div class="lyrics-placeholder">
        <p><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg> 歌词加载中...</p>
      </div>`;
  }
  
  if (!trackId) return;

  try {
    const data = await fetchJson(`/api/lyrics/${encodeURIComponent(trackId)}`);
    
    if (data.exists && data.lyrics) {
      state.lyricLines = parseLrc(data.lyrics);
      state.activeLyricIndex = -1;
      renderLyrics();
      if (data.source === "lrclib") {
        showToast("LRCLIB lyrics matched", "success");
        // Refresh track list to reflect lyricsAvailable update
        setTimeout(refreshTracks, 800);
      }
    } else {
      // 只有在确认没有歌词后才显示"重新获取"按钮
      renderLyrics();
    }
  } catch {
    renderLyrics();
  }
}

// ─── Player Time / Progress ───────────────────────────────────────────────────
function updateTimeUI() {
  const cur = audio.currentTime || 0;
  const dur = audio.duration || 0;
  if (els.currentTimeEl) els.currentTimeEl.textContent = formatTime(cur);
  if (els.totalTimeEl) els.totalTimeEl.textContent = formatTime(dur);
  if (els.progressBar) {
    els.progressBar.max = dur > 0 ? String(dur) : "100";
    els.progressBar.value = dur > 0 ? String(cur) : "0";
  }
}

function updatePlayBtn() {
  if (els.playBtn) els.playBtn.innerHTML = state.isPlaying ? '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>' : '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';

  // Sync play/pause icons in track rows
  const pauseSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>';
  const playSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
  document.querySelectorAll('.row-btn--play').forEach(btn => {
    const trackId = btn.dataset.trackId;
    const isActive = state.currentTrack?.id === trackId;
    if (isActive) {
      btn.classList.toggle('is-playing', state.isPlaying);
      btn.title = state.isPlaying ? '暂停' : '播放';
      btn.innerHTML = state.isPlaying ? pauseSvg : playSvg;
    } else {
      btn.classList.remove('is-playing');
      btn.title = '播放';
      btn.innerHTML = playSvg;
    }
  });
}

// ─── Track Playback ───────────────────────────────────────────────────────────
async function playTrack(trackId, autoPlay = true) {
  const track = state.tracks.find((t) => t.id === trackId);
  if (!track) {
    showToast("找不到该歌曲", "error");
    return;
  }

  // Record play count when starting to play a new track
  const isNewTrack = state.currentTrack?.id !== trackId;
  if (isNewTrack) {
    recordPlay(trackId);
  }

  const newSrc = new URL(track.url, location.origin).href;
  if (audio.src !== newSrc) audio.src = track.url;

  state.currentTrack = track;
  // Save last played track to localStorage
  try {
    localStorage.setItem('lastPlayedTrackId', track.id);
  } catch {}
  renderPlayingView();
  // Highlight in all tables
  document.querySelectorAll(".track-row").forEach((r) => {
    r.classList.toggle("is-active", r.dataset.trackId === trackId);
  });
  applyBackground();
  // Re-apply playlist background if we're on the playlist view
  if (state.view === "playlist" && state.playlistViewId) {
    const folder = state.folders.find((f) => f.id === state.playlistViewId);
    if (folder && folder.coverUrl && els.playlistBg) {
      els.playlistBg.style.backgroundImage = `url("${folder.coverUrl}")`;
    }
  }
  loadLyrics(track.id);

  if (autoPlay) {
    try {
      await audio.play();
      state.isPlaying = true;
    } catch {
      state.isPlaying = false;
      showToast("浏览器阻止了自动播放，请手动点击播放", "warn");
    }
    setDiscSpinning(state.isPlaying);
    updatePlayBtn();
  }
}

async function togglePlayPause() {
  if (!state.currentTrack) {
    if (!state.tracks.length) {
      showToast("请先导入歌曲", "warn");
      return;
    }
    await playTrack(state.tracks[0].id, true);
    return;
  }
  if (audio.paused) {
    try {
      await audio.play();
      state.isPlaying = true;
    } catch {
      state.isPlaying = false;
      showToast("播放失败", "error");
    }
  } else {
    audio.pause();
    state.isPlaying = false;
  }
  setDiscSpinning(state.isPlaying);
  updatePlayBtn();
}

function getNextTrackId(step) {
  if (!state.tracks.length) return null;
  if (state.playMode === "loop-one")
    return state.currentTrack?.id ?? state.tracks[0].id;

  let pool = state.tracks;
  // If in playlist view, maybe restrict to playlist? Optional: always play from full library.
  const idx = pool.findIndex((t) => t.id === state.currentTrack?.id);

  if (state.playMode === "shuffle") {
    const others = pool.filter((t) => t.id !== state.currentTrack?.id);
    if (!others.length) return pool[0].id;
    return others[Math.floor(Math.random() * others.length)].id;
  }

  const next = (idx + step + pool.length) % pool.length;
  return pool[next].id;
}

async function playAdjacent(step) {
  const id = getNextTrackId(step);
  if (id) await playTrack(id, true);
}

// ─── Play Mode ────────────────────────────────────────────────────────────────
const PLAY_MODES = ["loop", "loop-one", "shuffle"];
const PLAY_MODE_LABEL = {
  loop: "↻ 列表循环",
  "loop-one": "↻¹ 单曲循环",
  shuffle: "⇄ 随机播放",
};

function cyclePlayMode() {
  const idx = PLAY_MODES.indexOf(state.playMode);
  state.playMode = PLAY_MODES[(idx + 1) % PLAY_MODES.length];
  if (els.loopBtn) {
    const map = { loop: "↻", "loop-one": "①", shuffle: "⇄" };
    els.loopBtn.textContent = map[state.playMode];
    els.loopBtn.classList.toggle("is-active", state.playMode !== "loop");
  }
  if (els.shuffleBtn) {
    els.shuffleBtn.classList.toggle("is-active", state.playMode === "shuffle");
  }
  showToast(PLAY_MODE_LABEL[state.playMode], "info");
}

// ─── Volume & Mute ────────────────────────────────────────────────────────────
function applyVolume(vol) {
  audio.volume = Math.max(0, Math.min(1, vol));
  if (els.volumeBar) els.volumeBar.value = String(audio.volume);
  if (els.muteBtn) els.muteBtn.textContent = audio.volume === 0 ? "🔇" : "🔊";
}

function toggleMute() {
  if (audio.volume > 0) {
    state.prevVolume = audio.volume;
    applyVolume(0);
  } else {
    applyVolume(state.prevVolume || 0.8);
  }
}

// ─── API Helpers ──────────────────────────────────────────────────────────────
async function refreshTracks(keepCurrent = true) {
  const prev = keepCurrent ? state.currentTrack?.id : null;
  const data = await fetchJson("/api/tracks");
  state.tracks = data.tracks || [];
  if (prev) {
    const found = state.tracks.find((t) => t.id === prev);
    if (found) state.currentTrack = found;
  }
  // Preload all thumbnails in background
  state.tracks.forEach(track => {
    if (track.thumbnailUrl) {
      const img = new Image();
      img.src = track.thumbnailUrl;
    }
  });
  if (state.view === "library") renderLibrary();
  if (state.view === "playlist") renderPlaylistView();
  renderPlayingView();
  document.querySelectorAll(".track-row").forEach((r) => {
    r.classList.toggle(
      "is-active",
      r.dataset.trackId === state.currentTrack?.id,
    );
  });
}

async function refreshFolders() {
  const data = await fetchJson("/api/folders");
  state.folders = data.folders || [];
  renderSidebarPlaylists();
  if (state.view === "playlist") renderPlaylistView();
}

async function refreshSettings() {
  const data = await fetchJson("/api/settings");
  state.settings = data || state.settings;
  applyBackground();
}

// ─── Upload Tracks ────────────────────────────────────────────────────────────
function openUploadDialog() {
  audioFileInput.value = "";
  audioFileInput.click();
}

async function handleAudioFileSelect() {
  const files = Array.from(audioFileInput.files || []);
  if (!files.length) return;

  const formData = new FormData();
  files.forEach((f) => formData.append("audioFiles", f));

  try {
    showToast(`正在导入 ${files.length} 首歌曲…`, "info");
    const data = await fetchJson("/api/upload-tracks", {
      method: "POST",
      body: formData,
    });
    state.tracks = data.tracks || [];
    renderLibrary();
    renderSidebarPlaylists();
    showToast(data.message || "导入成功", "success");
    switchView("library");
  } catch (err) {
    showToast(err.message || "导入失败", "error");
  }
}

// ─── Context Menu ───────────────────────────────────────────────────────────────
let contextMenuPlaylistId = null;

function showContextMenu(x, y, folderId) {
  contextMenuPlaylistId = folderId;
  const menu = els.contextMenu;
  if (!menu) return;
  
  menu.style.display = 'block';
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
}

function hideContextMenu() {
  const menu = els.contextMenu;
  if (!menu) return;
  menu.style.display = 'none';
  contextMenuPlaylistId = null;
}

function handleContextMenuAction(action) {
  if (!contextMenuPlaylistId) return;
  
  switch (action) {
    case 'rename':
      openRenamePlaylistModal(contextMenuPlaylistId);
      break;
    case 'upload-cover':
      pendingCoverPlaylistId = contextMenuPlaylistId;
      playlistCoverFileInput.click();
      break;
    case 'delete':
      openDeletePlaylistModal(contextMenuPlaylistId);
      break;
  }
  
  hideContextMenu();
}

// ─── Upload Playlist Cover ───────────────────────────────────────────────────────
async function handlePlaylistCoverFileSelect() {
  const file = playlistCoverFileInput.files?.[0];
  if (!file || !pendingCoverPlaylistId) return;
  
  console.log("[Client] Playlist cover file selected:", file.name, file.type, file.size, "for playlist:", pendingCoverPlaylistId);
  
  const formData = new FormData();
  formData.append("cover", file);
  formData.append("playlistId", pendingCoverPlaylistId);
  
  try {
    showToast("正在上传封面…", "info");
    const data = await fetchJson("/api/upload-playlist-cover", {
      method: "POST",
      body: formData,
    });
    console.log("[Client] Playlist cover upload success:", data);
    
    // Update the playlist with new cover
    const folder = state.folders.find(f => f.id === pendingCoverPlaylistId);
    if (folder && data.coverUrl) {
      folder.coverUrl = data.coverUrl;
      folder.coverFile = data.coverFile;
    }
    
    // Refresh playlist view and sidebar
    renderPlaylistView();
    renderSidebarPlaylists();
    
    // If this is the current playing playlist, update the disc
    if (state.currentTrack) {
      renderPlayingView();
    }
    
    showToast("封面已更新", "success");
  } catch (err) {
    console.error("[Client] Playlist cover upload failed:", err);
    showToast(err.message || "封面上传失败", "error");
  } finally {
    pendingCoverPlaylistId = null;
    playlistCoverFileInput.value = ''; // Reset input
  }
}

// ─── Upload Background ────────────────────────────────────────────────────────
function openBgDialog() {
  bgFileInput.value = "";
  bgFileInput.click();
}

async function handleBgFileSelect() {
  const file = bgFileInput.files?.[0];
  if (!file) return;
  console.log("[Client] File selected:", file.name, file.type, file.size);
  const formData = new FormData();
  formData.append("background", file);
  try {
    showToast("正在上传背景图…", "info");
    const data = await fetchJson("/api/upload-background", {
      method: "POST",
      body: formData,
    });
    console.log("[Client] Upload success:", data);
    state.settings = data;
    applyBackground(true);
    showToast("背景图已更新", "success");
  } catch (err) {
    console.error("[Client] Upload failed:", err);
    showToast(err.message || "上传失败", "error");
  }
}

async function handleCoverFileSelect() {
  const file = coverFileInput.files?.[0];
  if (!file || !pendingCoverTrackId) return;
  
  console.log("[Client] Cover file selected:", file.name, file.type, file.size, "for track:", pendingCoverTrackId);
  
  const formData = new FormData();
  formData.append("cover", file);
  formData.append("trackId", pendingCoverTrackId);
  
  try {
    showToast("正在上传封面…", "info");
    const data = await fetchJson("/api/upload-cover", {
      method: "POST",
      body: formData,
    });
    console.log("[Client] Cover upload success:", data);
    
    // Update the track with new thumbnail
    const track = state.tracks.find(t => t.id === pendingCoverTrackId);
    if (track && data.thumbnailUrl) {
      track.thumbnailUrl = data.thumbnailUrl;
      track.thumbnailFile = data.thumbnailFile;
    }
    
    // Refresh library view to show new cover
    renderLibrary();
    
    // If this is the current playing track, update the disc
    if (state.currentTrack?.id === pendingCoverTrackId) {
      renderPlayingView();
    }
    
    showToast("封面已更新", "success");
  } catch (err) {
    console.error("[Client] Cover upload failed:", err);
    showToast(err.message || "封面上传失败", "error");
  } finally {
    pendingCoverTrackId = null;
    coverFileInput.value = ''; // Reset input
  }
}

// ─── Download Jobs ────────────────────────────────────────────────────────────
function renderDownloadJobs() {
  if (!els.downloadJobList) return;
  const jobs = [...state.downloadJobs.entries()];

  if (els.downloadJobsTitle) {
    els.downloadJobsTitle.style.display = jobs.length ? "" : "none";
  }

  if (!jobs.length) {
    els.downloadJobList.innerHTML = "";
    return;
  }

  els.downloadJobList.innerHTML = jobs
    .map(([jobId, job]) => {
      const statusClass =
        job.status === "done"
          ? "job-msg--done"
          : job.status === "error"
            ? "job-msg--error"
            : "job-msg--running";

      const icon =
        job.status === "done" ? "✓" : job.status === "error" ? "✕" : "…";

      return `
      <div class="download-job-card" data-job-id="${escapeHtml(jobId)}">
        <div class="job-info">
          <div class="job-url">${escapeHtml(job.url || "")}</div>
          <div class="job-msg ${statusClass}">${icon} ${escapeHtml(job.message || "")}</div>
        </div>
        <button class="job-dismiss" data-dismiss-job="${escapeHtml(jobId)}" title="关闭">✕</button>
      </div>`;
    })
    .join("");
}

function pollJobStatus(jobId) {
  const interval = setInterval(async () => {
    try {
      const data = await fetchJson(
        `/api/download-status/${encodeURIComponent(jobId)}`,
      );
      const job = state.downloadJobs.get(jobId);
      if (!job) {
        clearInterval(interval);
        return;
      }

      job.status = data.status;
      job.message = data.message || job.message;

      if (data.status === "done") {
        clearInterval(interval);
        await refreshTracks(true);
        renderDownloadJobs();
        showToast("下载完成！", "success");
      } else if (data.status === "error") {
        clearInterval(interval);
        renderDownloadJobs();
        showToast(`下载失败：${data.message}`, "error");
      } else {
        renderDownloadJobs();
      }
    } catch {
      clearInterval(interval);
    }
  }, 2000);

  const job = state.downloadJobs.get(jobId);
  if (job) job.intervalId = interval;
}

async function startDownload() {
  const url = (els.downloadUrlInput?.value || "").trim();
  const fileName = (els.downloadNameInput?.value || "").trim();

  if (!url) {
    showToast("请输入下载链接", "warn");
    return;
  }

  await downloadFromUrl(url, fileName);
}

async function downloadFromUrl(url, customFileName = "") {
  if (!url) {
    showToast("请输入下载链接", "warn");
    return;
  }

  if (els.startDownloadBtn) els.startDownloadBtn.disabled = true;

  try {
    const data = await fetchJson("/api/download-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, fileName: customFileName }),
    });

    if (data.isAsync && data.jobId) {
      // yt-dlp async download
      const intervalId = setInterval(async () => {
        try {
          const job = await fetchJson(`/api/download-status/${encodeURIComponent(data.jobId)}`);
          if (job.status === "done" || job.status === "error") {
            clearInterval(intervalId);
            if (job.status === "done") {
              // Refresh tracks to get full data including thumbnailUrl
              await refreshTracks(true);
              // 显示重命名对话框
              const normalizedFileName = (job.fileName || "").replace(/\\/g, '/');
              console.log("[Download] Looking for track with fileName:", normalizedFileName);
              const savedTrack = state.tracks.find(t =>
                t.fileName.replace(/\\/g, '/') === normalizedFileName ||
                t.id === normalizedFileName
              );
              console.log("[Download] Found savedTrack:", savedTrack?.id, savedTrack?.title);
              if (savedTrack) {
                showRenameDialog(savedTrack);
              } else {
                // Fallback: find most recently added track
                const recentTrack = state.tracks[state.tracks.length - 1];
                if (recentTrack) showRenameDialog(recentTrack);
              }
            }
          }
          state.downloadJobs.set(data.jobId, { ...job, intervalId });
          renderDownloadJobs();
        } catch {}
      }, 1000);

      pollJobStatus(data.jobId);
      renderDownloadJobs();
      showToast("下载任务已开始", "info");
      if (els.downloadUrlInput) els.downloadUrlInput.value = "";
      if (els.downloadNameInput) els.downloadNameInput.value = "";
    } else {
      // Direct download - sync
      await refreshTracks(true);
      showToast(data.message || "下载成功", "success");
      if (els.downloadUrlInput) els.downloadUrlInput.value = "";
      if (els.downloadNameInput) els.downloadNameInput.value = "";
      // Show rename dialog for direct downloads too
      if (data.savedFileName) {
        const normalized = data.savedFileName.replace(/\\/g, '/');
        const savedTrack = state.tracks.find(t =>
          t.fileName.replace(/\\/g, '/') === normalized ||
          t.id === normalized
        );
        if (savedTrack) showRenameDialog(savedTrack);
      }
    }
  } finally {
    if (els.startDownloadBtn) els.startDownloadBtn.disabled = false;
  }
}

// ─── Bilibili Search ─────────────────────────────────────────────────────────

async function searchBilibili() {
  const query = (els.bilibiliSearchInput?.value || "").trim();
  if (!query) {
    showToast("请输入搜索关键词", "warn");
    return;
  }

  if (els.searchBilibiliBtn) els.searchBilibiliBtn.disabled = true;
  els.searchBilibiliBtn.textContent = "搜索中...";

  try {
    els.searchResultsList.innerHTML = '<div class="search-loading">正在搜索 B站视频...</div>';
    els.searchResults.style.display = "block";

    const data = await fetchJson(`/api/search-bilibili?q=${encodeURIComponent(query)}`);
    
    if (!data.results || data.results.length === 0) {
      els.searchResultsList.innerHTML = '<div class="search-empty">未找到相关视频，换个关键词试试</div>';
      return;
    }

    renderSearchResults(data.results);
  } catch (err) {
    console.error("[Search] Search failed:", err);
    els.searchResultsList.innerHTML = `<div class="search-empty">搜索失败: ${err.message || '请检查 yt-dlp 是否安装'}</div>`;
  } finally {
    if (els.searchBilibiliBtn) {
      els.searchBilibiliBtn.disabled = false;
      els.searchBilibiliBtn.textContent = "搜索";
    }
  }
}

function renderSearchResults(results) {
  if (!els.searchResultsList) return;

  els.searchResultsList.innerHTML = results.map(item => {
    const duration = item.duration ? formatTime(item.duration) : "未知时长";
    let thumb = item.thumbnail || '';
    // Fix protocol-relative URLs (//example.com -> https://example.com)
    if (thumb.startsWith('//')) {
      thumb = 'https:' + thumb;
    }
    console.log("[Search] Render item:", item.title.substring(0, 20), "thumb:", thumb.substring(0, 50));
    
    return `
      <div class="search-result-item" data-url="${escapeHtml(item.url)}" data-title="${escapeHtml(item.title)}">
        <div class="search-result-thumb">
          ${thumb ? `<img src="${escapeHtml(thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.display='none'; this.parentElement.innerHTML='<div style=\\'width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:var(--bg-soft);color:var(--text-soft);font-size:2rem;\\'>🎵</div>'">` : '<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:var(--bg-soft);color:var(--text-soft);font-size:2rem;">🎵</div>'}
        </div>
        <div class="search-result-info">
          <div class="search-result-title">${escapeHtml(item.title)}</div>
          <div class="search-result-meta">${escapeHtml(item.uploader)} · ${duration}</div>
          <div class="search-result-desc">${escapeHtml(item.description || '')}</div>
        </div>
        <div class="search-result-actions">
          <button class="btn btn-primary btn-small">下载</button>
        </div>
      </div>
    `;
  }).join('');
}

function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function clearSearch() {
  if (els.bilibiliSearchInput) els.bilibiliSearchInput.value = "";
  if (els.searchResults) els.searchResults.style.display = "none";
  if (els.searchResultsList) els.searchResultsList.innerHTML = "";
}

// 下载视频并自动获取歌词
async function downloadVideoFromSearch(url, title) {
  console.log("[Search] Starting download:", title, url);
  
  // 填充到链接输入框并下载
  if (els.downloadUrlInput) els.downloadUrlInput.value = url;
  if (els.downloadNameInput) els.downloadNameInput.value = title;
  
  await downloadFromUrl(url, title);
  
  // 清空搜索
  clearSearch();
}

// 显示重命名对话框（包含歌手输入和纯音乐选项）
function showRenameDialog(track) {
  console.log("[RenameDialog] Opening for track:", track.id, track.title, track.fileName);

  // 提取歌曲名和歌手
  const defaultSongName = getSongName(track);
  const defaultArtist = getArtistName(track);
  const isCurrentlyInst = isInstrumentalTrack(track.id);

  openModal({
    title: "重命名歌曲",
    body: `
      <div class="modal-form">
        <label class="modal-label">歌曲名
          <input class="modal-input" id="modalSongName" type="text"
                 placeholder="例如：晴天"
                 value="${escapeHtml(defaultSongName)}" maxlength="60">
        </label>
        <label class="modal-label" style="margin-top: 12px;">歌手
          <input class="modal-input" id="modalArtist" type="text"
                 placeholder="例如：周杰伦"
                 value="${escapeHtml(defaultArtist)}" maxlength="30">
        </label>
        <label class="modal-checkbox-label" style="display: flex; align-items: center; gap: 10px; margin-top: 16px; cursor: pointer;">
          <input type="checkbox" id="isInstrumental" ${isCurrentlyInst ? 'checked' : ''} style="width: 18px; height: 18px; accent-color: var(--primary);">
          <span style="color: var(--text-soft); font-size: 0.9rem;">纯音乐（无需歌词）</span>
        </label>
      </div>`
    ,
    confirmText: "保存",
    cancelText: "保持原名",
    showCancel: true,
    onConfirm: async () => {
      const songName = ($("modalSongName")?.value || "").trim();
      const artist = ($("modalArtist")?.value || "").trim();
      const isInstrumental = $("isInstrumental")?.checked || false;
      closeModal();

      // 组合新名称：歌曲名 歌手名
      const newName = artist ? `${songName} ${artist}` : songName;

      // 如果用户取消纯音乐标记，清除标记
      if (!isInstrumental && isCurrentlyInst) {
        clearInstrumentalMark(track.id);
        showToast("已清除纯音乐标记，将搜索歌词", "success");
        await fetchLyricsForTrack(track);
        return;
      }

      // 如果用户没有修改名称且不是纯音乐，直接获取歌词
      if ((!newName || newName === track.title) && !isInstrumental) {
        await fetchLyricsForTrack(track);
        return;
      }

      // 如果是纯音乐，保存标记
      if (isInstrumental) {
        if (newName && newName !== track.title) {
          try {
            const result = await fetchJson(`/api/tracks/${encodeURIComponent(track.id)}/rename`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ newName: newName.trim(), artist }),
            });

            if (result.newTrackId) {
              showToast(`已重命名：${newName}（纯音乐）`, "success");
              state.tracks = result.tracks || state.tracks;
              renderLibrary();
              const renamedTrack = state.tracks.find(t => t.id === result.newTrackId);
              if (renamedTrack) {
                saveInstrumentalMark(renamedTrack.id);
                // Update current track if this was the playing one
                if (state.currentTrack?.id === track.id || state.currentTrack?.id === renamedTrack.id) {
                  state.currentTrack = renamedTrack;
                  state.lyricLines = [{ time: 0, text: "纯音乐~" }];
                  state.activeLyricIndex = 0;
                  renderPlayingView();
                  renderLyrics();
                }
              }
            }
          } catch (err) {
            console.error("[Rename] Failed:", err);
            showToast("重命名失败", "error");
          }
        } else {
          saveInstrumentalMark(track.id);
          showToast("已标记为纯音乐", "success");
          // Update lyrics display immediately
          if (state.currentTrack?.id === track.id) {
            state.lyricLines = [{ time: 0, text: "纯音乐~" }];
            state.activeLyricIndex = 0;
            renderLyrics();
          }
        }
        return;
      }

      // 正常重命名并获取歌词
      if (newName && newName !== track.title) {
        try {
          const result = await fetchJson(`/api/tracks/${encodeURIComponent(track.id)}/rename`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ newName: newName.trim(), artist }),
          });

          if (result.newTrackId) {
            showToast(`已重命名：${newName}`, "success");
            state.tracks = result.tracks || state.tracks;
            renderLibrary();
            const renamedTrack = state.tracks.find(t => t.id === result.newTrackId);
            if (renamedTrack) await fetchLyricsForTrack(renamedTrack);
          }
        } catch (err) {
          console.error("[Rename] Failed:", err);
          showToast("重命名失败，尝试用原名获取歌词", "error");
          await fetchLyricsForTrack(track);
        }
      }
    },
    onCancel: async () => {
      closeModal();
      // 用户取消，用原名获取歌词
      await fetchLyricsForTrack(track);
    }
  });
}


// 标记当前播放歌曲为纯音乐（用户点击按钮）
function markCurrentAsInstrumental() {
  if (!state.currentTrack) {
    showToast("请先播放一首歌曲", "warn");
    return;
  }
  saveInstrumentalMark(state.currentTrack.id);
  state.lyricLines = [{ time: 0, text: "纯音乐~" }];
  state.activeLyricIndex = 0;
  renderLyrics();
  showToast("已标记为纯音乐", "success");
}

// 保存/获取/清除纯音乐标记
function saveInstrumentalMark(trackId) {
  const instrumentalMarks = JSON.parse(localStorage.getItem('instrumentalMarks') || '{}');
  instrumentalMarks[trackId] = true;
  localStorage.setItem('instrumentalMarks', JSON.stringify(instrumentalMarks));
}

function clearInstrumentalMark(trackId) {
  const instrumentalMarks = JSON.parse(localStorage.getItem('instrumentalMarks') || '{}');
  delete instrumentalMarks[trackId];
  localStorage.setItem('instrumentalMarks', JSON.stringify(instrumentalMarks));
}

function isInstrumentalTrack(trackId) {
  const instrumentalMarks = JSON.parse(localStorage.getItem('instrumentalMarks') || '{}');
  return instrumentalMarks[trackId] || false;
}

// 清理B站视频标题，提取纯歌曲名
function cleanSongTitle(rawTitle) {
  if (!rawTitle) return "";
  
  let title = rawTitle;
  
  // Step 1: 提取《》或「」中的内容（通常是歌曲名）
  const bookMatch = title.match(/《(.*?)》/);
  if (bookMatch && bookMatch[1]) {
    title = bookMatch[1];
    console.log("[Lyrics] Extracted from 《》:", title);
    return title.trim();
  }
  
  // Step 2: 移除各种标记和标签
  const patterns = [
    /\[.*?\]/g,                    // [无损音质]、[官方MV]
    /【.*?】/g,                    // 【二次元】
    /［.*?］/g,                    // ［无损音质］
    /\(.*?\)/g,                   // (Live)、(Remix)
    /（.*?）/g,                   // 全角括号
    /\{.*?\}/g,                   // 花括号
    /「.*?」/g,                   // 日语引号
    /『.*?』/g,                   // 特殊引号
    /《.*?》/g,                   // 书名号（已经处理过，这里是清理剩余的）
    /\|.*$/g,                     // | 后面的内容
    /\/.*$/g,                     // / 后面的内容
    /\\.*$/g,                     // \ 后面的内容
  ];
  
  patterns.forEach(p => {
    title = title.replace(p, "");
  });
  
  // Step 3: 移除常见歌手名（只移除独立的词，不是子串）
  const commonArtists = ["周杰伦", "林俊杰", "薛之谦", "陈奕迅", "邓紫棋", "华晨宇", "毛不易", "周深", "张杰", "李荣浩", "许嵩", "汪苏泷", "徐佳莹", "五月天", "Beyond", "张学友", "刘德华", "郭富城", "黎明", "TFBOYS", "蔡徐坤", "肖战", "王一博", "张艺兴", "黄子韬", "鹿晗", "吴亦凡", "林宥嘉", "梁静茹", "孙燕姿", "蔡依林", "王力宏", "陶喆", "张韶涵", "杨丞琳"];
  commonArtists.forEach(artist => {
    // 使用单词边界匹配，避免删除子串
    const regex = new RegExp(`\\b${artist}\\b`, "g");
    title = title.replace(regex, "");
  });
  
  // Step 4: 清理特殊字符和多余空格
  title = title.replace(/[【】\[\]［］「」『』""''{}()（）|/\\\-～~]/g, " ");
  title = title.replace(/\s+/g, " ").trim();
  
  // Step 5: 移除常见后缀（如 "车子缓缓的开 你慢慢走来..." 这种长描述）
  // 如果标题太长，只保留前20个字符
  if (title.length > 30) {
    // 尝试在空格处截断
    const shortTitle = title.substring(0, 30);
    const lastSpace = shortTitle.lastIndexOf(" ");
    if (lastSpace > 10) {
      title = shortTitle.substring(0, lastSpace);
    }
  }
  
  console.log("[Lyrics] Cleaned title:", `"${rawTitle}"`, "→", `"${title}"`);
  
  // 如果清理后为空或太短，返回原标题的前30字符
  if (!title || title.length < 2) {
    return rawTitle.replace(/[《》]/g, "").substring(0, 30).trim();
  }
  
  return title;
}

// 为已下载的歌曲获取歌词
async function fetchLyricsForTrack(track) {
  // 如果是纯音乐，跳过歌词搜索
  if (isInstrumentalTrack(track.id)) {
    console.log("[Lyrics] Skipping lyrics search for instrumental track:", track.title);
    // 如果是当前播放的歌曲，更新歌词显示为"纯音乐~"
    if (state.currentTrack?.id === track.id) {
      state.lyricLines = [{ time: 0, text: "纯音乐~" }];
      state.activeLyricIndex = 0;
      renderLyrics();
    }
    return;
  }
  
  try {
    // 清理标题，提取纯歌曲名
    const cleanTitle = cleanSongTitle(track.title);
    const artist = track.artist || "";
    
    console.log("[Lyrics] LRCLIB search:", cleanTitle, "Artist:", artist, "Duration:", track.duration);
    
    // Use LRCLIB API for better matching
    const result = await fetchJson(`/api/lyrics-netease?title=${encodeURIComponent(cleanTitle)}&artist=${encodeURIComponent(artist)}&album=${encodeURIComponent(track.album || '')}&duration=${track.duration || 0}`);
    
    console.log("[Lyrics] API result:", result);
    
    // API returns { lyrics: "...", found: true }
    const lyricsText = result?.lyrics || result;
    
    console.log("[Lyrics] Extracted text length:", lyricsText?.length, "found:", result?.found);
    
    if (lyricsText && lyricsText.trim && lyricsText.trim().length > 10) {
      // Save lyrics to server
      await fetchJson("/api/lyrics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trackId: track.id, lyrics: lyricsText }),
      });
      console.log("[Lyrics] LRCLIB lyrics saved for:", cleanTitle);
      showToast(`LRCLIB matched: ${cleanTitle}`, "success");
      
      // 如果是当前播放的歌曲，更新歌词显示
      if (state.currentTrack?.id === track.id) {
        await loadLyrics(track.id);
        renderLyrics();
      }
    } else {
      console.log("[Lyrics] LRCLIB no match for:", cleanTitle);
    }
  } catch (err) {
    console.log("[Lyrics] Failed to fetch lyrics:", err.message);
  }
}

// ─── Playlists / Favorites ────────────────────────────────────────────────────
function openCreatePlaylistModal() {
  inputModal({
    title: "新建歌单",
    label: "歌单名称",
    placeholder: "例如：我喜欢的歌曲",
    confirmText: "创建",
    onConfirm: async (name) => {
      if (!name) {
        showToast("名称不能为空", "warn");
        return;
      }
      closeModal();
      try {
        const data = await fetchJson("/api/folders", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
        });
        state.folders = data.folders || [];
        renderSidebarPlaylists();
        showToast(`歌单「${name}」已创建`, "success");
        // Auto open new playlist
        const newest = state.folders[state.folders.length - 1];
        if (newest) switchView("playlist", { folderId: newest.id });
      } catch (err) {
        showToast(err.message || "创建失败", "error");
      }
    },
  });
}

function openRenamePlaylistModal(folderId) {
  const folder = state.folders.find((f) => f.id === folderId);
  if (!folder) return;
  inputModal({
    title: "重命名歌单",
    label: "新名称",
    value: folder.name,
    confirmText: "保存",
    onConfirm: async (name) => {
      if (!name) {
        showToast("名称不能为空", "warn");
        return;
      }
      closeModal();
      try {
        const data = await fetchJson(
          `/api/folders/${encodeURIComponent(folderId)}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name }),
          },
        );
        state.folders = data.folders || [];
        renderSidebarPlaylists();
        renderPlaylistView();
        showToast("已重命名", "success");
      } catch (err) {
        showToast(err.message || "重命名失败", "error");
      }
    },
  });
}

function openDeletePlaylistModal(folderId) {
  const folder = state.folders.find((f) => f.id === folderId);
  if (!folder) return;
  confirmModal({
    title: "删除歌单",
    message: `确定删除歌单「${folder.name}」吗？歌曲本身不会被删除。`,
    confirmText: "删除",
    danger: true,
    onConfirm: async () => {
      closeModal();
      try {
        const data = await fetchJson(
          `/api/folders/${encodeURIComponent(folderId)}`,
          { method: "DELETE" },
        );
        state.folders = data.folders || [];
        renderSidebarPlaylists();
        switchView("library");
        showToast("歌单已删除", "success");
      } catch (err) {
        showToast(err.message || "删除失败", "error");
      }
    },
  });
}

function openAddToPlaylistModal(trackId) {
  if (!state.folders.length) {
    showToast("请先创建歌单", "warn");
    return;
  }

  const items = state.folders
    .map(
      (f) => `
    <button class="playlist-picker-item" data-folder-id="${escapeHtml(f.id)}">
      <span class="playlist-picker-name">${escapeHtml(f.name)}</span>
      <span class="playlist-picker-count">${(f.trackIds || []).length} 首</span>
    </button>`,
    )
    .join("");

  openModal({
    title: "加入歌单",
    body: `<div class="playlist-picker">${items}</div>`,
    showCancel: true,
    confirmText: "确定",
    onConfirm: null,
  });
  els.modalConfirmBtn.style.display = "none";

  setTimeout(() => {
    document.querySelectorAll(".playlist-picker-item").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const folderId = btn.dataset.folderId;
        closeModal();
        await addTrackToPlaylist(trackId, folderId);
      });
    });
  }, 50);
}

async function addTrackToPlaylist(trackId, folderId) {
  try {
    const data = await fetchJson(
      `/api/folders/${encodeURIComponent(folderId)}/tracks`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trackId }),
      },
    );
    state.folders = data.folders || [];
    renderSidebarPlaylists();
    if (state.view === "playlist") renderPlaylistView();
    const f = state.folders.find((x) => x.id === folderId);
    showToast(`已加入「${f?.name || "歌单"}」`, "success");
  } catch (err) {
    showToast(err.message || "添加失败", "error");
  }
}

async function removeTrackFromPlaylist(trackId, folderId) {
  try {
    const data = await fetchJson(
      `/api/folders/${encodeURIComponent(folderId)}/tracks/${encodeURIComponent(trackId)}`,
      { method: "DELETE" },
    );
    state.folders = data.folders || [];
    renderSidebarPlaylists();
    renderPlaylistView();
    showToast("已从歌单移除", "success");
  } catch (err) {
    showToast(err.message || "移除失败", "error");
  }
}

function openDeleteTrackModal(trackId) {
  const track = state.tracks.find((t) => t.id === trackId);
  if (!track) return;
  confirmModal({
    title: "删除歌曲",
    message: `确定从音乐库删除「${track.title}」吗？此操作不可撤销。`,
    confirmText: "删除",
    danger: true,
    onConfirm: async () => {
      closeModal();
      try {
        const data = await fetchJson(
          `/api/tracks/${encodeURIComponent(trackId)}`,
          { method: "DELETE" },
        );
        state.tracks = data.tracks || [];
        state.folders = data.favorites?.folders || state.folders;
        if (state.currentTrack?.id === trackId) {
          audio.pause();
          audio.removeAttribute("src");
          state.currentTrack = null;
          state.isPlaying = false;
          state.lyricLines = [];
          state.activeLyricIndex = -1;
          setDiscSpinning(false);
          updatePlayBtn();
          renderPlayingView();
          renderLyrics();
        }
        renderLibrary();
        renderSidebarPlaylists();
        showToast("已删除", "success");
      } catch (err) {
        showToast(err.message || "删除失败", "error");
      }
    },
  });
}

// ─── Favorite from player bar ─────────────────────────────────────────────────
function handleBarFavorite() {
  if (!state.currentTrack) {
    showToast("请先播放一首歌曲", "warn");
    return;
  }
  openAddToPlaylistModal(state.currentTrack.id);
}

function handlePlayingFavorite() {
  if (!state.currentTrack) {
    showToast("请先播放一首歌曲", "warn");
    return;
  }
  openAddToPlaylistModal(state.currentTrack.id);
}

// ─── Immersive Mode ────────────────────────────────────────────────────────────
let isImmersiveMode = false;
let immersionImages = [];
let immersionIndex = 0;
let immersionInterval = null;

async function loadImmersionImages() {
  try {
    const data = await fetchJson("/api/immersion-backgrounds");
    immersionImages = data.images || [];
  } catch {
    immersionImages = [];
  }
}

function startImmersionSlideshow() {
  if (immersionInterval) clearInterval(immersionInterval);
  if (!immersionImages.length) return;

  // Only apply to playing view if currently on it
  if (state.view === "playing") {
    applyImmersionBackground(immersionImages[immersionIndex]);
  }

  immersionInterval = setInterval(() => {
    immersionIndex = (immersionIndex + 1) % immersionImages.length;
    // Only apply if currently on playing view
    if (state.view === "playing") {
      applyImmersionBackground(immersionImages[immersionIndex]);
    }
  }, 8000); // 8 seconds per image
}

function stopImmersionSlideshow() {
  if (immersionInterval) {
    clearInterval(immersionInterval);
    immersionInterval = null;
  }
  // Restore original background (user's custom background or default)
  applyBackground();
}

function applyImmersionBackground(url) {
  // Only apply to playing view's background
  const bg = document.querySelector('.playing-bg');
  if (!bg || state.view !== "playing") return;
  // Preload image then apply
  const img = new Image();
  img.onload = () => {
    bg.style.backgroundImage = `url(${url})`;
  };
  img.src = url;
}

async function toggleImmersiveMode() {
  isImmersiveMode = !isImmersiveMode;
  const app = document.querySelector('.app');
  const btn = document.getElementById('winImmersiveBtn');
  if (isImmersiveMode) {
    app?.classList.add('is-immersive');
    document.body.classList.add('is-immersive');
    btn?.classList.add('is-immersive');
    // Load and start slideshow
    if (!immersionImages.length) await loadImmersionImages();
    immersionIndex = 0;
    startImmersionSlideshow();
  } else {
    app?.classList.remove('is-immersive');
    document.body.classList.remove('is-immersive');
    btn?.classList.remove('is-immersive');
    stopImmersionSlideshow();
  }
}

// ─── Event Binding ────────────────────────────────────────────────────────────
function bindEvents() {
  // Window control buttons (Electron frameless)
  if (window.electronAPI) {
    document.getElementById("winMinBtn")?.addEventListener("click", () => window.electronAPI.minimize());
    document.getElementById("winMaxBtn")?.addEventListener("click", () => window.electronAPI.maximize());
    document.getElementById("winCloseBtn")?.addEventListener("click", () => window.electronAPI.close());
  }
  document.getElementById("winSettingsBtn")?.addEventListener("click", () => {
    if (state.view === "settings") {
      // Go back to previous view
      switchView(previousView);
    } else {
      switchView("settings");
    }
  });
  document.getElementById("winImmersiveBtn")?.addEventListener("click", toggleImmersiveMode);

  // Audio element events
  audio.addEventListener("play", () => {
    state.isPlaying = true;
    setDiscSpinning(true);
    updatePlayBtn();
  });
  audio.addEventListener("pause", () => {
    state.isPlaying = false;
    setDiscSpinning(false);
    updatePlayBtn();
    // Save accumulated listening time
    saveCurrentSessionTime();
  });
  audio.addEventListener("ended", () => {
    // Save accumulated listening time before switching
    saveCurrentSessionTime();
    playAdjacent(1);
  });
  
  let lastTimeUpdate = Date.now();
  let accumulatedTime = 0;
  let lastSaveSecond = 0;
  
  audio.addEventListener("timeupdate", () => {
    updateTimeUI();
    syncLyrics();
    
    // Record listening time precisely while playing
    if (state.isPlaying && !audio.paused) {
      const now = Date.now();
      const delta = (now - lastTimeUpdate) / 1000; // seconds
      if (delta > 0 && delta < 2) { // More precise: max 2 seconds between updates
        accumulatedTime += delta;
        
        // Save every second (more precise)
        const currentSecond = Math.floor(accumulatedTime);
        if (currentSecond > lastSaveSecond) {
          const secondsToSave = currentSecond - lastSaveSecond;
          recordListeningTime(secondsToSave);
          lastSaveSecond = currentSecond;
          
          // Update library stats display if visible
          if (state.view === "library") {
            renderLibraryStats();
          }
        }
      }
      lastTimeUpdate = now;
    } else {
      lastTimeUpdate = Date.now();
    }
  });
  audio.addEventListener("loadedmetadata", updateTimeUI);
  audio.addEventListener("error", () => {
    state.isPlaying = false;
    setDiscSpinning(false);
    updatePlayBtn();
    showToast("音频文件无法播放", "error");
  });

  // Player bar controls
  els.playBtn?.addEventListener("click", togglePlayPause);
  els.prevBtn?.addEventListener("click", () => playAdjacent(-1));
  els.nextBtn?.addEventListener("click", () => playAdjacent(1));
  els.shuffleBtn?.addEventListener("click", () => {
    state.playMode = state.playMode === "shuffle" ? "loop" : "shuffle";
    els.shuffleBtn.classList.toggle("is-active", state.playMode === "shuffle");
    if (els.loopBtn) els.loopBtn.classList.toggle("is-active", false);
    showToast(PLAY_MODE_LABEL[state.playMode], "info");
  });
  els.loopBtn?.addEventListener("click", () => {
    state.playMode = state.playMode === "loop-one" ? "loop" : "loop-one";
    const map = { loop: "↻", "loop-one": "①", shuffle: "⇄" };
    els.loopBtn.textContent = map[state.playMode];
    els.loopBtn.classList.toggle("is-active", state.playMode === "loop-one");
    showToast(PLAY_MODE_LABEL[state.playMode], "info");
  });

  els.progressBar?.addEventListener("input", (e) => {
    audio.currentTime = Number(e.target.value);
    updateTimeUI();
    syncLyrics();
  });

  els.volumeBar?.addEventListener("input", (e) =>
    applyVolume(Number(e.target.value)),
  );
  els.muteBtn?.addEventListener("click", toggleMute);

  els.gotoPlayingBtn?.addEventListener("click", () => switchView("playing"));
  els.barFavoriteBtn?.addEventListener("click", handleBarFavorite);
  els.playingFavoriteBtn?.addEventListener("click", handlePlayingFavorite);

  // Sidebar navigation
  document.querySelectorAll(".nav-item[data-view]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const v = btn.dataset.view;
      if (v === "library") {
        switchView("library");
        return;
      }
      switchView(v);
    });
  });

  // Playlist nav (delegated)
  els.playlistNav?.addEventListener("click", (e) => {
    const item = e.target.closest(".playlist-nav-item");
    if (!item) return;
    switchView("playlist", { folderId: item.dataset.folderId });
  });

  // Playlist nav right-click context menu
  els.playlistNav?.addEventListener("contextmenu", (e) => {
    const item = e.target.closest(".playlist-nav-item");
    if (!item) return;
    e.preventDefault();
    const folderId = item.dataset.folderId;
    showContextMenu(e.clientX, e.clientY, folderId);
  });

  // Context menu item clicks
  els.contextMenu?.addEventListener("click", (e) => {
    const menuItem = e.target.closest(".context-menu-item");
    if (!menuItem) return;
    const action = menuItem.dataset.action;
    handleContextMenuAction(action);
  });

  // Hide context menu when clicking elsewhere
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".context-menu") && !e.target.closest(".playlist-nav-item")) {
      hideContextMenu();
    }
  });

  // Create playlist
  els.createPlaylistBtn?.addEventListener("click", openCreatePlaylistModal);

  // Upload tracks button
  els.uploadTracksBtn?.addEventListener("click", openUploadDialog);
  audioFileInput?.addEventListener("change", handleAudioFileSelect);

  // Upload background
  els.uploadBgBtn?.addEventListener("click", openBgDialog);
  bgFileInput?.addEventListener("change", handleBgFileSelect);

  // Upload cover
  coverFileInput?.addEventListener("change", handleCoverFileSelect);
  playlistCoverFileInput?.addEventListener("change", handlePlaylistCoverFileSelect);

  // Library search
  els.librarySearch?.addEventListener("input", renderLibrary);

  // Library table (delegated)
  els.libraryTable?.addEventListener("click", async (e) => {
    // Action buttons first
    const addBtn = e.target.closest("[data-action='add-to-playlist']");
    if (addBtn) {
      openAddToPlaylistModal(addBtn.dataset.trackId);
      return;
    }

    const delBtn = e.target.closest("[data-action='delete-track']");
    if (delBtn) {
      openDeleteTrackModal(delBtn.dataset.trackId);
      return;
    }

    // Upload cover button
    const coverBtn = e.target.closest("[data-action='upload-cover']");
    if (coverBtn) {
      pendingCoverTrackId = coverBtn.dataset.trackId;
      coverFileInput.click();
      return;
    }

    // Play/pause button click
    const playBtn = e.target.closest("[data-action='play-and-view']");
    if (playBtn) {
      const trackId = playBtn.dataset.trackId;
      // If clicking the currently playing track's pause button, toggle pause
      if (state.currentTrack?.id === trackId && state.isPlaying) {
        await togglePlayPause();
        renderLibrary();
        return;
      }
      await playTrack(trackId, true);
      renderLibrary();
      return;
    }

    // Row click = play
    const row = e.target.closest(".track-row");
    if (row && row.dataset.trackId) {
      await playTrack(row.dataset.trackId, true);
      renderLibrary();
    }
  });

  // Playlist table (delegated)
  els.playlistTable?.addEventListener("click", async (e) => {
    const addBtn = e.target.closest("[data-action='add-to-playlist']");
    if (addBtn) {
      openAddToPlaylistModal(addBtn.dataset.trackId);
      return;
    }

    const removeBtn = e.target.closest("[data-action='remove-from-playlist']");
    if (removeBtn) {
      await removeTrackFromPlaylist(
        removeBtn.dataset.trackId,
        state.playlistViewId,
      );
      return;
    }

    // Play/pause button click - in playlist, don't auto-switch to playing view
    const playBtn = e.target.closest("[data-action='play-and-view']");
    if (playBtn) {
      const trackId = playBtn.dataset.trackId;
      // If clicking the currently playing track's pause button, toggle pause
      if (state.currentTrack?.id === trackId && state.isPlaying) {
        await togglePlayPause();
        renderPlaylistView();
        return;
      }
      await playTrack(trackId, true);
      renderPlaylistView();
      return;
    }

    const row = e.target.closest(".track-row");
    if (row && row.dataset.trackId) {
      await playTrack(row.dataset.trackId, true);
      renderPlaylistView();
    }
  });

  // Playlist view actions - global event delegation
  document.addEventListener("click", async (e) => {
    // Play all button
    const playAllBtn = e.target.closest("#playlistPlayAllBtn");
    if (playAllBtn) {
      e.preventDefault();
      e.stopPropagation();
      console.log("[Play All] clicked");
      
      const folder = state.folders.find((f) => f.id === state.playlistViewId);
      if (!folder) {
        showToast("歌单不存在", "error");
        return;
      }
      
      const trackIds = folder.trackIds || [];
      if (!trackIds.length) {
        showToast("歌单是空的", "warn");
        return;
      }
      
      const firstTrack = state.tracks.find((t) => trackIds.includes(t.id));
      if (!firstTrack) {
        showToast("找不到可播放的歌曲", "warn");
        return;
      }
      
      await playTrack(firstTrack.id, true);
      renderPlaylistView();
      return;
    }
    
    // Upload playlist cover button
    const uploadBtn = e.target.closest("#uploadPlaylistCoverBtn");
    if (uploadBtn) {
      e.preventDefault();
      e.stopPropagation();
      if (state.playlistViewId) {
        pendingCoverPlaylistId = state.playlistViewId;
        playlistCoverFileInput.click();
      }
      return;
    }
  });

  // Download view
  els.startDownloadBtn?.addEventListener("click", startDownload);
  els.downloadUrlInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") startDownload();
  });
  
  // Bilibili search
  els.searchBilibiliBtn?.addEventListener("click", searchBilibili);
  els.bilibiliSearchInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") searchBilibili();
  });
  els.clearSearchBtn?.addEventListener("click", clearSearch);
  
  // Search results click (delegated)
  els.searchResultsList?.addEventListener("click", (e) => {
    const item = e.target.closest(".search-result-item");
    if (!item) return;
    
    const url = item.dataset.url;
    const title = item.dataset.title;
    if (url) {
      downloadVideoFromSearch(url, title);
    }
  });

  // Download job list (delegated)
  els.downloadJobList?.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-dismiss-job]");
    if (!btn) return;
    const jobId = btn.dataset.dismissJob;
    const job = state.downloadJobs.get(jobId);
    if (job?.intervalId) clearInterval(job.intervalId);
    state.downloadJobs.delete(jobId);
    try {
      await fetch(`/api/download-jobs/${encodeURIComponent(jobId)}`, {
        method: "DELETE",
      });
    } catch {}
    renderDownloadJobs();
  });

  // Modal controls
  els.modalConfirmBtn?.addEventListener("click", () => {
    if (_modalConfirmCb) _modalConfirmCb();
    else closeModal();
  });
  els.modalCancelBtn?.addEventListener("click", () => {
    if (_modalCancelCb) _modalCancelCb();
    closeModal();
  });
  els.modalCloseBtn?.addEventListener("click", closeModal);

  // Lyrics line click = seek
  els.lyricsScroll?.addEventListener("click", (e) => {
    const line = e.target.closest("[data-lyric-index]");
    if (!line || !state.lyricLines.length) return;
    const idx = parseInt(line.dataset.lyricIndex, 10);
    if (Number.isFinite(idx) && state.lyricLines[idx]) {
      audio.currentTime = state.lyricLines[idx].time;
      state.activeLyricIndex = idx;
      renderLyrics();
    }
  });

  // Keyboard shortcuts
  document.addEventListener("keydown", async (e) => {
    const tag = (e.target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return;

    if (e.code === "Space") {
      e.preventDefault();
      await togglePlayPause();
    }
    if (e.altKey && e.code === "ArrowRight") {
      e.preventDefault();
      await playAdjacent(1);
    }
    if (e.altKey && e.code === "ArrowLeft") {
      e.preventDefault();
      await playAdjacent(-1);
    }
    if (e.code === "Escape") {
      if (isImmersiveMode) toggleImmersiveMode();
      else closeModal();
    }
  });
}


// ─── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  try {
    // Apply defaults before data loads
    applyVolume(0.8);
    renderPlayingView();
    renderLyrics();
    renderSidebarPlaylists();

    bindEvents();

    // Load data in parallel
    await Promise.all([
      refreshTracks(false).catch(() => {}),
      refreshFolders().catch(() => {}),
      refreshSettings().catch(() => {}),
    ]);

    // Restore last played track from localStorage (without playing)
    try {
      const lastTrackId = localStorage.getItem('lastPlayedTrackId');
      if (lastTrackId && !state.currentTrack) {
        const track = state.tracks.find(t => t.id === lastTrackId);
        if (track) {
          state.currentTrack = track;
          // Set audio source but don't play
          audio.src = track.url;
          // Load lyrics
          loadLyrics(track.id);
          renderPlayingView();
          applyBackground();
          // Highlight in library
          document.querySelectorAll(".track-row").forEach((r) => {
            r.classList.toggle("is-active", r.dataset.trackId === track.id);
          });
        }
      }
    } catch {}

    renderLibrary();
    renderPlayingView();
    renderSidebarPlaylists();
    updateTimeUI();
    updatePlayBtn();
    updateStatsDisplay();
    renderLibraryStats();
    renderListeningCalendar();
    initCalendarEvents();

    showToast("播放器已就绪", "success");
  } catch (err) {
    showToast(err.message || "初始化失败", "error");
  }
}

init();
