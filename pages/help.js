import helpMarkup from './help.html?raw';
import { switchTab } from '../utils/ui.js';
import { returnToMyProfile } from '../user-data/profile.js';

let installPrompt = null;
let installedThisSession = false;
const standalone = window.matchMedia('(display-mode: standalone)');

function renderInstallState() {
    const runningStandalone = standalone.matches || navigator.standalone === true;
    const installed = runningStandalone || installedThisSession;
    const button = document.getElementById('help-install-btn');
    if (!button) return;
    button.hidden = installed || !installPrompt;
    document.getElementById('help-install-status').textContent = runningStandalone
        ? 'You’re using Theama as an installed app.'
        : installed ? 'Theama is installed. Open it from your home screen or app launcher.'
        : 'Choose your device below for installation steps. Menu names can vary by browser version.';
}

// Capture the browser's installation offer even before the guide is opened.
window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    installPrompt = event;
    renderInstallState();
});
window.addEventListener('appinstalled', () => {
    installedThisSession = true;
    installPrompt = null;
    renderInstallState();
});
standalone.addEventListener('change', renderInstallState);

function focusSection(element) {
    if (!element) return;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    element.scrollIntoView({ behavior: reducedMotion ? 'instant' : 'smooth', block: 'start' });
    element.focus({ preventScroll: true });
}

export function initializeHelpPage() {
    const page = document.getElementById('help-page');
    page.innerHTML = helpMarkup;
    document.getElementById('open-help-btn').addEventListener('click', () => switchTab('help-page'));

    page.addEventListener('click', event => {
        const topic = event.target.closest('[data-help-topic]');
        if (topic) {
            focusSection(document.getElementById(topic.dataset.helpTopic));
            return;
        }
        const action = event.target.closest('[data-help-page]');
        if (!action) return;
        if (action.dataset.helpPage === 'profile-page') returnToMyProfile();
        switchTab(action.dataset.helpPage);
        const target = action.dataset.helpFocus
            ? document.getElementById(action.dataset.helpFocus)
            : document.querySelector(`#${action.dataset.helpPage} h1`);
        if (target) {
            if (!target.matches('button, input, select, textarea, a, [tabindex]')) target.tabIndex = -1;
            focusSection(target);
        } else {
            document.getElementById('app-main').scrollTop = 0;
        }
    });

    document.getElementById('help-install-btn').addEventListener('click', async () => {
        if (!installPrompt) return;
        const prompt = installPrompt;
        installPrompt = null;
        renderInstallState();
        try {
            await prompt.prompt();
            const choice = await prompt.userChoice;
            if (installedThisSession) {
                renderInstallState();
                return;
            }
            document.getElementById('help-install-status').textContent = choice.outcome === 'accepted'
                ? 'Installation requested. Open Theama from your home screen or app launcher when it’s ready.'
                : 'You can install later using your browser menu. The steps below are always available.';
        } catch {
            document.getElementById('help-install-status').textContent = 'Use your browser menu to install Theama. Follow the steps below for your device.';
        }
    });

    const isAppleMobile = /iPhone|iPad|iPod/.test(navigator.userAgent)
        || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const guide = isAppleMobile ? 'ios' : /Android/.test(navigator.userAgent) ? 'android' : 'desktop';
    page.querySelector(`[data-install-guide="${guide}"]`).open = true;
    renderInstallState();
}
