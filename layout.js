function renderMainMenu() {
    // 1. Find the container
    const navContainer = document.getElementById('nav-container');
    if (!navContainer) return;

    // 2. THE DETECTOR: Is the screen 768px or wider? (Tailwind's 'md' size)
    const isDesktop = window.innerWidth >= 768;

    // 3. Inject a super simple menu (just text for now)
    navContainer.innerHTML = `<div class="p-6 text-white font-bold text-xl">TorBox Menu</div>`;

    // 4. THE MAGIC: Change the colors based on the detector
    if (isDesktop) {
        // PC: Make it pitch black and pin it to the left side
        navContainer.className = "fixed top-0 left-0 w-64 h-screen bg-black border-r border-slate-800";
        console.log("🖥️ PC Detected: Menu is Black");
    } else {
        // MOBILE: Make it slate-900 and pin it to the bottom
        navContainer.className = "fixed bottom-0 left-0 w-full bg-slate-900 border-t border-slate-800";
        console.log("📱 Mobile Detected: Menu is Slate");
    }
}

// 5. Start the engine when the script loads!
renderMainMenu();

// 6. Listen for the user resizing the window, and run it again if they do
window.addEventListener('resize', renderMainMenu);