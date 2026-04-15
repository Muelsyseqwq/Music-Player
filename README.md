# 🎵 本地音乐播放器 (Local Music Player)

一个漂亮的二次元风格桌面音乐播放器，支持本地音乐管理和在线音乐下载。

![界面预览](preview.png)

## ✨ 特性

- 🎨 **二次元风格UI** - 梦幻紫粉配色、可爱动画效果
- 💿 **本地音乐播放** - 支持 MP3、FLAC、WAV、AAC、M4A、OGG 等格式
- 📥 **在线下载** - 支持 Bilibili、YouTube 视频音频提取
- 📝 **歌词自动匹配** - 自动从网易云音乐获取歌词
- 🎵 **歌单管理** - 创建自定义歌单，收藏喜欢的歌曲
- 🖼️ **自定义背景** - 支持上传自定义背景图片
- ⌨️ **快捷键支持** - 空格播放/暂停，Alt+方向键切歌
- 🌈 **视觉效果** - 旋转唱片、发光效果、流畅动画

## 🚀 快速开始

### 环境要求

- Node.js >= 18.0.0
- Python 3.7+ (用于 yt-dlp)
- FFmpeg (用于音频处理)

### 安装步骤

1. **克隆或下载项目**
   ```bash
   cd local-music-player
   ```

2. **安装 Node.js 依赖**
   ```bash
   npm install
   ```

3. **安装 yt-dlp** (用于下载 Bilibili/YouTube 音乐)
   ```bash
   pip install yt-dlp
   ```
   
   或使用 [yt-dlp 官方安装包](https://github.com/yt-dlp/yt-dlp/releases)

4. **安装 FFmpeg** (必需)
   
   - **Windows**: 下载 [FFmpeg](https://ffmpeg.org/download.html)，解压并将 `bin` 目录添加到系统环境变量 PATH
   - **macOS**: `brew install ffmpeg`
   - **Linux**: `sudo apt-get install ffmpeg`

5. **启动应用**
   
   **方式一：作为 Web 应用**
   ```bash
   npm start
   # 然后在浏览器打开 http://localhost:3000
   ```
   
   **方式二：作为桌面应用 (Electron)**
   ```bash
   npm run electron
   ```

## 📖 使用指南

### 导入本地音乐

1. 点击左侧导航栏 **🎼 本地音乐**
2. 点击右上角的 **📁 导入音乐** 按钮
3. 选择音乐文件（可多选）
4. 可同时导入配套的歌词文件（.lrc 格式）

### 下载在线音乐

1. 点击左侧导航栏 **💾 下载音乐**
2. 粘贴视频链接：
   - Bilibili: `https://www.bilibili.com/video/BVxxxxx`
   - YouTube: `https://www.youtube.com/watch?v=xxxxx`
   - 或直接音频文件链接
3. 可选择填写自定义文件名（可选）
4. 点击 **开始下载**
5. 在下方下载任务列表查看进度

### 创建歌单

1. 在左侧"我的歌单"区域点击 **＋** 按钮
2. 输入歌单名称
3. 在本地音乐列表中点击 **💖** 按钮将歌曲添加到歌单

### 设置背景图片

1. 点击左侧导航栏 **✨ 设置**
2. 点击 **上传背景图** 按钮
3. 选择喜欢的图片（推荐 1920x1080 或更高分辨率）
4. 背景将显示在"正在播放"页面

### 播放控制

| 功能 | 操作 |
|------|------|
| 播放/暂停 | 点击底部 ▶️ 按钮或按 `空格键` |
| 上一首 | 点击 ⏮️ 或按 `Alt + ←` |
| 下一首 | 点击 ⏭️ 或按 `Alt + →` |
| 随机播放 | 点击 🔀 按钮 |
| 循环模式 | 点击 🔁 按钮（列表循环/单曲循环） |
| 调整音量 | 拖动右侧音量条或点击 🔊 静音 |
| 查看歌词 | 点击底部 🎵 按钮 |

### 歌词功能

- 播放歌曲时自动尝试从网易云音乐匹配歌词
- 匹配成功的歌词会自动保存到本地
- 歌词会随播放进度高亮显示
- 点击歌词可跳转到对应位置

## 📁 项目结构

```
local-music-player/
├── data/                 # 数据文件
│   ├── favorites.json    # 歌单数据
│   ├── settings.json     # 设置数据
│   └── tmp/              # 临时文件
├── downloads/            # 下载的音乐文件
├── public/               # 前端资源
│   ├── index.html        # 主页面
│   ├── styles.css        # 样式文件（二次元风格）
│   └── app.js            # 前端逻辑
├── uploads/              # 上传的背景图片
├── main.js               # Electron 主进程
├── server.js             # Express 后端服务
├── package.json          # 项目配置
└── README.md             # 本文件
```

## 🔧 常见问题

### 无法下载 Bilibili 视频

1. 确保已安装 yt-dlp：`yt-dlp --version`
2. 确保已安装 FFmpeg：`ffmpeg -version`
3. 检查视频是否需要登录（大会员专属内容无法下载）
4. 更新 yt-dlp 到最新版本：`pip install -U yt-dlp`

### 无法播放某些音频文件

确保 FFmpeg 已正确安装并添加到系统 PATH。播放器依赖 FFmpeg 解码部分音频格式。

### 歌词匹配失败

- 确保歌曲标题正确（自动从文件名提取）
- 部分冷门歌曲可能没有歌词
- 可手动上传 .lrc 歌词文件

### 界面显示异常

- 确保使用现代浏览器（Chrome、Edge、Firefox 最新版）
- Electron 版本需要 Node.js 18+

## 🛠️ 构建桌面应用

```bash
# Windows 便携版
npm run build

# 输出目录：dist/
```

## 📝 技术栈

- **前端**: 原生 HTML/CSS/JavaScript
- **后端**: Node.js + Express
- **下载**: yt-dlp
- **桌面**: Electron
- **歌词**: 网易云音乐 API

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

## 📄 许可

MIT License

---

Made with 💖 by Music Lover
