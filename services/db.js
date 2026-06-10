import { createClient } from '@supabase/supabase-js';
import { SUPABASEURL, SUPABASEKEY, showToast, appState } from './config.js';

export const supabase = createClient(SUPABASEURL, SUPABASEKEY);

let currentSession = null;
let signUp = true;
let updateDetails = false;

function setAuthState(user) {
    appState.currentUser = user; 
    
    const authEvent = new CustomEvent('auth-state-changed', {
        detail: { user: user }
    });
    
    window.dispatchEvent(authEvent);
}

export async function initializeSupabase() {
    supabase.auth.onAuthStateChange((event, session) => {
        console.log(`Supabase Auth Event: ${event}`);
        currentSession = session;
        setAuthState(session ? session.user : null);
        updateSettingsUI();
    });

    const { data: { session } } = await supabase.auth.getSession();

    if (session) {
        const { data: { user }, error } = await supabase.auth.getUser();

        if (error || !user) {
            console.log("User no longer exists on server. Clearing session...");
            await supabase.auth.signOut();
        }
    }
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
    const toggleBtn = document.getElementById('toggle-btn');

    const toggleUpdateDiv = document.getElementById('edit-profile-toggle');

    //Inputs
    const usernameInput = document.getElementById('settings-username');
    const emailInput = document.getElementById('settings-email');
    const passwordInput = document.getElementById('settings-password');

    if (currentSession) {   // Logged in
        const currentUsername = currentSession.user.user_metadata.username;
        const currentEmail = currentSession.user.email;
        const hasEmail = currentSession.user.user_metadata.hasEmail;

        accountMessage.textContent = `Welcome, ${currentUsername}!`;
        multiDiv.classList.add('hidden');
        toggleAuthDiv.classList.add('hidden');

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
        toggleUpdateDiv.classList.add('hidden');

        accountMessage.textContent = "Log in to optimize your experience";

        usernameInput.placeholder = "Username";
        emailInput.placeholder = "Email";

        if (!signUp) {
            usernameDiv.classList.add('hidden');
            emailDiv.classList.add('hidden');
            multiDiv.classList.remove('hidden');

            submitBtn.textContent = 'Log In';

            toggleText.textContent = "Don't have an account?";
            toggleBtn.textContent = "Sign Up";
        }
        else {
            usernameDiv.classList.remove('hidden');
            emailDiv.classList.remove('hidden');
            multiDiv.classList.add('hidden');

            submitBtn.textContent = 'Sign Up';

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
        const hasEmail = currentSession.user.user_metadata.hasEmail;
        const currentUsername = currentSession.user.user_metadata.username;

        if (username && username !== currentUsername) {
            if (!hasEmail && !email) {
                return showInputError('username', "You can't change your username without an email linked.");
            }
            if (!validUsernameRegex.test(username)) {
                return showInputError('username', "Usernames can only contain letters and numbers.");
            }
        }
        
        if (password && password.length < 6) {
            return showInputError('password', "New password must be at least 6 characters.");
        }

        const originalText = submitBtn.textContent;
        response = await performUpdate(username, email, password);

    } else if (signUp) {
        // GUARD CLAUSES
        if (!username) return showInputError('username', "Username is required.");
        if (!validUsernameRegex.test(username)) return showInputError('username', "Usernames can only contain letters and numbers.");
        if (password.length < 6) return showInputError('password', "Password must be at least 6 characters.");

        const originalText = submitBtn.textContent;
        response = await performSignUp(username, email, password);

    } else {
        if (!multi) return showInputError('multi', "Please enter your username or email.");
        if (!password) return showInputError('password', "Password is required.");

        const originalText = submitBtn.textContent;
        const finalEmail = multi.includes('@') ? multi : `${multi.toLowerCase()}@theama.app`;
        response = await performLogIn(finalEmail, password);
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

    // 2. If there's an error, target the specific data-attribute
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
window.toggleAuthMode = toggleAuthMode;

export function toggleUpdateMode() {
    updateDetails = !updateDetails;
    updateSettingsUI();
};
window.toggleUpdateMode = toggleUpdateMode;

// 2. SIGN UP FUNCTION
async function performSignUp(username, email, password) {
    const finalEmail = email ? email : `${username.toLowerCase()}@theama.app`;

    // Return the promise result directly ({ data, error })
    return await supabase.auth.signUp({
        email: finalEmail,
        password: password,
        options: {
            data: {
                username: username,
                hasEmail: !!email
            }
        }
    });
}

// 3. LOG IN FUNCTION
async function performLogIn(username, password) {
    return await supabase.auth.signInWithPassword({
        email: username,
        password: password,
    });
}

// Update user details
async function performUpdate(username, email, password) {
    const updates = {};

    if (password) {
        updates.password = password;
    }

    if (email) {
        updates.email = email;
        updates.data = { hasEmail: true };
    }

    if (username) {
        updates.data = { ...updates.data, username: username };
    }

    return await supabase.auth.updateUser(updates);
}

// HELPER: Standalone Log Out
export async function logOutUser() {
    // 1. Tell Supabase to kill the session
    const { error } = await supabase.auth.signOut();

    // 2. Handle any potential errors
    if (error) {
        console.error("Logout Error:", error.message);
        alert("Failed to log out: " + error.message);
    } else {
        // Success! 
        console.log("Successfully logged out.");
    }
}
window.logOutUser = logOutUser;