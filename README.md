# 🎬 Theama.app

A powerful, fully-featured Progressive Web App (PWA) designed for browser-based streaming. It combines addons, social and playlisting capabilities, metadata matching for files, and a WASM-based remuxing engine for playing any type of codec in the browser.

## ✨ Key Features

### 🚀 Browser Playback
Bypass WebKit's strict media limitations. Play **MKV files** and unsupported audio codecs natively in the browser without needing a separate backend transcoding server.
- **Custom Rust Remuxer:** Fast, on-the-fly container remuxing to MP4 compiled to WebAssembly.
- **FFmpeg.wasm Integration:** Real-time audio transcoding specifically for AAC encoding to handle unsupported audio formats perfectly.

### 🧩 Seamless Addon Ecosystem
- Fully compatible with the Stremio addon ecosystem.
- Supports powerful third-party addons out of the box.

### ☁️ Smart Debrid Library Management
- Reads directly from your connected Debrid library.
- **Auto-Cleaning:** Automatically parses and cleans up messy, raw torrent file names.
- **Rich Metadata:** Assigns high-quality posters and data, turning a raw file list into a premium, polished UI.

### 🎬 Rich Catalogs
- **TMDB Preinstalled:** The Movie Database catalog comes preinstalled for instant discovery of trending movies and TV shows.
- **AniList and Kitsu** Used for providing better data for anime.

### 🎧 Playlists & Queues
- Build custom playlists and continuous queues.
- **Ultimate Flexibility:** Mix and match any movie or specific TV episodes from your library into a single seamless playlist.

### 👥 Social & Community
- **Watchlists:** Create completely custom watchlists and toggle them between **Public** and **Private**.
- **Follow Friends:** Connect with others, follow your friends' profiles, and explore their favourite media.

## 🛠️ Stack
- **Client:** Progressive Web App (PWA) for an app-like experience.
- **Remux Engine:** Custom-written Rust compiled to WASM.
- **Audio Transcoding:** **FFmpeg** (via WebAssembly) dedicated to AAC encoding.
- **Metadata:** Integrated with TMDB, AniList and Kitsu.

## 📝 License
This project is [MIT](LICENSE) licensed.
