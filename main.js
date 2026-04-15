"use strict";

const { app, BrowserWindow, shell, Menu, ipcMain } = require("electron");
const path = require("path");

const PORT = process.env.PORT || 3000;
let mainWindow = null;

// 先启动 Express 服务（server.js 会在 require 时自动 listen）
require("./server");

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1300,
    height: 840,
    minWidth: 1000,
    minHeight: 660,
    backgroundColor: "#0f1923",
    frame: false,
    icon: path.join(__dirname, "public", "favicon.ico"),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      preload: path.join(__dirname, "preload.js"),
    },
    show: false,
  });

  // 隐藏默认菜单（保留 DevTools 快捷键）
  Menu.setApplicationMenu(null);

  // 重试加载，等待 Express 服务就绪
  let retries = 0;
  const MAX_RETRIES = 30;

  function tryLoad() {
    mainWindow
      .loadURL(`http://localhost:${PORT}`)
      .then(() => {
        mainWindow.show();
      })
      .catch(() => {
        retries += 1;
        if (retries < MAX_RETRIES) {
          setTimeout(tryLoad, 400);
        } else {
          mainWindow.show();
          mainWindow.loadURL(`http://localhost:${PORT}`);
        }
      });
  }

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  tryLoad();

  // 外链在系统浏览器中打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(`http://localhost:${PORT}`)) {
      shell.openExternal(url);
    }
    return { action: "deny" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// Window control IPC handlers
ipcMain.on("window-minimize", () => {
  if (mainWindow) mainWindow.minimize();
});
ipcMain.on("window-maximize", () => {
  if (mainWindow) {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  }
});
ipcMain.on("window-close", () => {
  if (mainWindow) mainWindow.close();
});

app.whenReady().then(() => {
  createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
