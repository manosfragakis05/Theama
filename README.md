# Theama.app

A powerful, fully-featured Progressive Web App (PWA) designed for browser-based streaming. It combines addons, social and playlisting capabilities, metadata matching for files, and a WASM-based remuxing engine for playing any type of codec in the browser.

## Key Features

### Browser Playback
Bypass WebKit's strict media limitations. Play **MKV files** and unsupported audio codecs natively in the browser without needing a separate backend transcoding server.
- **Custom Rust Remuxer:** Fast, on-the-fly remuxing to MP4 for bypassing Apples limitaions.
- **FFmpeg.wasm Integration:** Real-time client-side audio transcoding to AAC using WebCodecs API to handle unsupported audio formats perfectly.

### Seamless Addon Ecosystem
- Fully compatible with the Stremio addon ecosystem.

### Smart Debrid Library Management
- Reads directly from your connected Debrid library.
- **Auto-Cleaning:** Automatically parses and cleans up messy, raw torrent file names.
- **Metadata Matching:** Assigns high-quality posters and data, turning a raw file list into a polished UI.

### Profiles and Data
- **Auto-Sync:** Any media watched is save on your profile so you can start where you left off and track anything across devices.
- **App-Library:** Aside from your debrid library, anything added within Theama will be stored in your profile.

### Playlists & Queues
- **Custom Queues:** Mix and match any movie or specific TV episodes from your library into a single seamless playlist. 
- Automatically queues any remaining episodes found in you library with the ability to shuffle and add anything in between.

### Friends & Social
- **Watchlists:** Create completely custom watchlists and toggle them between **Public** and **Private**.
- **Follow Friends:** Connect with others, follow your friends' profiles, and explore their favourite media.

### Rich Catalogs
- **TMDB Preinstalled:** The Movie Database catalog comes preinstalled for instant discovery of trending movies and TV shows.
- **Anime Matching** For the default catalogs automatically uses **kitsu ids** for better results.


## Getting Started
- Currently only supports **TorBox** as a debrid service which is necessary for playback. But more will services will be added in the future.
- Theama is only a **video player** it does **not** contain any media. Any content must be provided from **addons**.


## License and official project

Copyright (c) 2026 Manos Fragakis. The official Theama app is [theama.app](https://theama.app).

The original project code is available under the custom [Theama Source Available License](LICENSE). You may use and modify it privately, publish source code forks, and contribute improvements. Offering a competing app or service to other users requires separate written permission, even when it is free. Forks must preserve notices, identify themselves as unofficial, and link to the official project. This is a source available project, not an open-source license.

FFmpeg and other third-party components retain their own licenses. The project license preserves the applicable LGPL modification, reverse engineering, and rebuild/relink permissions. See the full license for the terms that apply.

- [Project license](LICENSE)
- [Third-party notices](THIRD_PARTY_NOTICES.txt)
- [FFmpeg / engine source and rebuild archive](mkv-engine-rebuild-2026-10-21.zip)
- [Privacy policy](public/privacy.html)
- [Request permission for a competing app](https://github.com/manosfragakis05/Theama/issues)

## Support development

If Theama is useful to you, you can [buy me a coffee](https://buymeacoffee.com/manosfragakis) your supports means a lot, thank you.
