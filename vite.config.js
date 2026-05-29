import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
    base: '/TorBox-Theater/',
    plugins: [
        VitePWA({
            registerType: 'autoUpdate',
            workbox: {
                // This tells Vite to automatically find every js, css, html, and image file 
                // and put it into your offline cache automatically!
                globPatterns: ['**/*.{js,css,html,ico,png,svg}']
            },
            manifest: {
                "name": "TorBox Theater",
                "short_name": "Theater",
                "description": "Your cloud media, unblocked.",
                "start_url": "./index.html",
                "display": "standalone",
                "background_color": "#0f172a",
                "theme_color": "#0f172a",
                "orientation": "any",
                "icons": [
                    {
                        "src": "pwa-icon.png",
                        "sizes": "512x512",
                        "type": "image/png",
                        "purpose": "any maskable"
                    }
                ]
            }
        })
    ]
});