import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
    plugins: [
        VitePWA({
            registerType: 'autoUpdate',
            injectRegister: 'inline',
            workbox: {
                globPatterns: ['**/*.{js,css,html,ico,png,svg}']
            },
            devOptions: {
                enabled: false,
                type: 'module'
            },
            manifest: {
                "name": "Theama",
                "short_name": "Theama",
                "description": "Your cloud media, unblocked.",
                "start_url": "/",
                "display": "standalone",
                "background_color": "#0f172a",
                "theme_color": "#0f172a",
                "orientation": "any",
                "icons": [
                    {
                        "src": "/pwa-icon.png",
                        "sizes": "192x192",
                        "type": "image/png",
                        "purpose": "any maskable"
                    },
                    {
                        "src": "/pwa-icon.png",
                        "sizes": "512x512",
                        "type": "image/png",
                        "purpose": "any maskable"
                    }
                ]
            }
        })
    ]
});