import { createClient } from '@supabase/supabase-js';
import { SUPABASEURL, SUPABASEKEY, showToast, appState } from '../services/config.js';

const privacyAwareStorage = {
    getItem: (key) => {
        // Look in both places to find the token when the app boots
        return sessionStorage.getItem(key) || localStorage.getItem(key);
    },
    setItem: (key, value) => {
        // Get local settings
        const settingsStr = localStorage.getItem('user_settings') || sessionStorage.getItem('user_settings');
        const settings = settingsStr ? JSON.parse(settingsStr) : null;

        // Default to true if not found
        const trustDevice = settings?.user_preferences?.trustThisDevice ?? true;

        if (trustDevice) {
            localStorage.setItem(key, value);
        } else {
            sessionStorage.setItem(key, value);
        }
    },
    removeItem: (key) => {
        // Scorched earth on logout
        localStorage.removeItem(key);
        sessionStorage.removeItem(key);
    }
};

export const supabase = createClient(SUPABASEURL, SUPABASEKEY, {
    auth: {
        storage: privacyAwareStorage
    }
});

let currentSession = null;
let signUp = true;
let updateDetails = false;

let initialization;
export function initializeSupabase() {
    if (initialization) return initialization;

    initialization = new Promise(resolve => {
        supabase.auth.onAuthStateChange((event, session) => {
            currentSession = session;
            appState.currentUser = session?.user ?? null;
            updateSettingsUI();
            window.dispatchEvent(new CustomEvent('auth-state-changed', {
                detail: { user: appState.currentUser }
            }));
            if (event === 'INITIAL_SESSION') resolve();
        });
    });

    return initialization;
}

// Set UI according to current state
function updateSettingsUI() {
    const accountMessage = document.getElementById('account-message');

    const multiDiv = document.getElementById('multi-container');
    const usernameDiv = document.getElementById('username-container');
    const emailDiv = document.getElementById('email-container');
    const passwordDiv = document.getElementById('password-container');
    const submitBtn = document.getElementById('submit');

    const toggleAuthDiv = document.getElementById('settings-auth-toggle');
    const toggleText = document.getElementById('toggle-text');
    const toggleBtn = document.getElementById('toggle-auth-mode-btn');
    const forgotPasswordBtn = document.getElementById('forgot-password-btn');

    const toggleUpdateDiv = document.getElementById('edit-profile-toggle');

    //Inputs
    const usernameInput = document.getElementById('settings-username');
    const emailInput = document.getElementById('settings-email');
    const passwordInput = document.getElementById('settings-password');

    // Info next to input fields, and log out button
    const loggedInPanel = document.getElementById('settings-logged-in-info');
    const loggedOutPanel = document.getElementById('settings-logged-out-info');

    if (currentSession) {   // Logged in
        const currentUsername = currentSession.user.user_metadata.username;
        const currentEmail = currentSession.user.email;
        const hasEmail = !currentEmail.endsWith('@theama.app');

        accountMessage.textContent = `Welcome, ${currentUsername}!`;
        multiDiv.classList.add('hidden');
        toggleAuthDiv.classList.add('hidden');

        //Show log out button
        loggedInPanel.classList.remove("hidden");
        loggedOutPanel.classList.add("hidden");

        if (hasEmail) emailInput.placeholder = currentEmail;
        else emailInput.placeholder = "Not Added Yet";
        usernameInput.placeholder = currentUsername;

        toggleUpdateDiv.classList.remove('hidden');
        if (!updateDetails) {
            usernameDiv.classList.add('hidden');
            emailDiv.classList.add('hidden');
            passwordDiv.classList.add('hidden');

            submitBtn.classList.add('hidden');
        }
        else {
            usernameDiv.classList.remove('hidden');
            emailDiv.classList.remove('hidden');
            passwordDiv.classList.remove('hidden');

            submitBtn.classList.remove('hidden');
            submitBtn.textContent = 'Update Profile';
        }
        // Logged out
    } else {
        toggleAuthDiv.classList.remove('hidden');
        passwordDiv.classList.remove('hidden');
        submitBtn.classList.remove('hidden');
        toggleUpdateDiv.classList.add('hidden');

        accountMessage.textContent = "Log in to optimize your experience";

        usernameInput.placeholder = "Username";
        emailInput.placeholder = "Email";

        //Remove log out button
        loggedInPanel.classList.add("hidden");
        loggedOutPanel.classList.remove("hidden");

        if (!signUp) {
            usernameDiv.classList.add('hidden');
            emailDiv.classList.add('hidden');
            multiDiv.classList.remove('hidden');

            submitBtn.textContent = 'Log In';

            forgotPasswordBtn.classList.remove('hidden');
            toggleText.textContent = "Don't have an account?";
            toggleBtn.textContent = "Sign Up";
        }
        else {
            usernameDiv.classList.remove('hidden');
            emailDiv.classList.remove('hidden');
            multiDiv.classList.add('hidden');

            submitBtn.textContent = 'Sign Up';

            forgotPasswordBtn.classList.add('hidden');
            toggleText.textContent = "Already have an account?";
            toggleBtn.textContent = "Log In";
        }
    }
}

// UI HELPER
export async function changeAuthState(event) {
    event.preventDefault();

    // 1. Clear old errors
    showInputError();

    const multiInput = document.getElementById('settings-multi');
    const usernameInput = document.getElementById('settings-username');
    const emailInput = document.getElementById('settings-email');
    const passwordInput = document.getElementById('settings-password');
    const submitBtn = document.getElementById('submit');

    const multi = multiInput.value.trim();
    const email = emailInput.value.trim();
    const password = passwordInput.value;
    const username = usernameInput ? usernameInput.value.trim() : '';

    const validUsernameRegex = /^[a-zA-Z0-9]+$/;
    let response;

    if (currentSession) {
        const hasEmail = !currentSession.user.email.endsWith('@theama.app');
        const currentUsername = currentSession.user.user_metadata.username;

        if (username && username !== currentUsername) {
            if (!hasEmail && !email) {
                return showInputError('username', "You can't change your username without an email linked.");
            }
            if (!validUsernameRegex.test(username)) {
                return showInputError('username', "Usernames can only contain letters and numbers.");
            }
        } else if (username && username == currentUsername) {
            return showInputError('username', "You can't change to the same username.");
        }

        if (password && password.length < 6) {
            return showInputError('password', "New password must be at least 6 characters.");
        }

        const updates = {};
        if (username) updates.data = { username };
        if (email) updates.email = email;
        if (password) updates.password = password;
        response = await supabase.auth.updateUser(updates);

    } else if (signUp) {
        // GUARD CLAUSES
        if (!username) return showInputError('username', "Username is required.");
        if (!validUsernameRegex.test(username)) return showInputError('username', "Usernames can only contain letters and numbers.");
        if (password.length < 6) return showInputError('password', "Password must be at least 6 characters.");

        response = await supabase.auth.signUp({
            email: email || `${username.toLowerCase()}@theama.app`,
            password,
            options: { data: { username } }
        });

    } else {
        if (!multi) return showInputError('multi', "Please enter your username or email.");
        if (!password) return showInputError('password', "Password is required.");

        const finalEmail = multi.includes('@') ? multi : `${multi.toLowerCase()}@theama.app`;
        response = await supabase.auth.signInWithPassword({ email: finalEmail, password });
    }

    const { data, error } = response || {};
    const originalText = submitBtn.textContent;

    if (error) {
        console.error("Auth Error:", error.message);
        showToast(error.message, "error");
    } else {
        submitBtn.textContent = "Success!";

        setTimeout(() => {
            submitBtn.textContent = originalText;
            event.target.reset();
        }, 2000);
    }
}

function showInputError(type, message) {
    document.querySelectorAll('.auth-error-msg').forEach(p => {
        p.classList.add('hidden');
    });

    if (message) {
        const errorEl = document.querySelector(`.auth-error-msg[data-target="${type}"]`);
        if (errorEl) {
            errorEl.textContent = message;
            errorEl.classList.remove('hidden');
        }
    }
}

export function toggleAuthMode() {
    signUp = !signUp;
    updateSettingsUI();
};

export function toggleUpdateMode() {
    updateDetails = !updateDetails;
    updateSettingsUI();
};

// Forgot password
export async function sendPasswordResetEmail() {
    const multiInput = document.getElementById('settings-multi');
    const identifier = multiInput ? multiInput.value.trim() : '';

    if (!identifier) {
        showToast("Please type your username or email in the box first.", "error");
        return;
    }

    if (!identifier.includes('@')) {
        showToast("You need an email to reset you password.", "error");
        return;
    }
    const email = identifier;

    try {
        const { data, error } = await supabase.auth.resetPasswordForEmail(email, {
            redirectTo: window.location.origin
        });

        if (error) throw error;

        showToast(`Password reset link sent to: ${email}`, "success");
        console.log("Password reset link sent to:", email);
        return { success: true };

    } catch (err) {
        console.error("Reset Error:", err.message);
        return { success: false, error: err.message };
    }
}

// Log out
export async function logOutUser() {
    const { error } = await supabase.auth.signOut();

    if (error) {
        console.error("Logout Error:", error.message);
        alert("Failed to log out: " + error.message);
    } else {
        appState.currentUser = null;
        localStorage.removeItem('user_settings');
        localStorage.removeItem('full_addon_data');
        sessionStorage.removeItem('user_settings');
        sessionStorage.removeItem('full_addon_data');

        window.location.reload();
        console.log("Successfully logged out.");
    }
}
