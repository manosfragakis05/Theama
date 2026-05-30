import { createClient } from '@supabase/supabase-js';
import { SUPABASEURL, SUPABASEKEY } from './config.js';

const supabase = createClient(SUPABASEURL, SUPABASEKEY);


// UI HELPER
async function handleAuthForm(event, loadingText, supabaseCallback) {
    event.preventDefault();

    const form = event.target;
    const emailInput = form.querySelector('input[type="email"]');
    const passwordInput = form.querySelector('input[type="password"]');
    const submitBtn = form.querySelector('button[type="submit"]');

    const email = emailInput.value.trim();
    const password = passwordInput.value;

    // Save the original button state so we can restore it later
    const originalText = submitBtn.textContent;
    // Optional: save original classes to swap colors (assuming Tailwind)
    const originalClasses = submitBtn.className;

    // Update UI to loading state
    submitBtn.textContent = loadingText;
    submitBtn.disabled = true;

    // Execute the actual Supabase logic
    const { data, error } = await supabaseCallback(email, password);

    if (error) {
        // If it fails, restore the button immediately so they can try again
        submitBtn.textContent = originalText;
        submitBtn.disabled = false;
    } else {
        // 🎉 If it succeeds, show the Success state!
        submitBtn.textContent = "Success!";

        // Optional Tailwind flair: Make the button green
        submitBtn.classList.remove('bg-blue-600', 'hover:bg-blue-700');
        submitBtn.classList.add('bg-green-600', 'hover:bg-green-700');

        // Wait 2 seconds, then reset the form and the button
        setTimeout(() => {
            submitBtn.textContent = originalText;
            submitBtn.className = originalClasses; // Restore original colors
            submitBtn.disabled = false;
            form.reset(); // Clears out the email and password fields
        }, 2000);
    }

    // Return the result back to app.js to show the error message if needed
    return { data, error };
}

// 2. SIGN UP FUNCTION
export async function signUpNewUser(event) {
    // We pass the event, the loading text, and the specific Supabase command
    return await handleAuthForm(event, "Creating Account...", async (email, password) => {
        return await supabase.auth.signUp({
            email: email,
            password: password,
        });
    });
}

// 3. LOG IN FUNCTION
export async function logInUser(event) {
    return await handleAuthForm(event, "Logging In...", async (email, password) => {
        return await supabase.auth.signInWithPassword({
            email: email,
            password: password,
        });
    });
}

// 4. UPDATE ACCOUNT FUNCTION
export async function updateTheamaAccount(event) {
    return await handleAuthForm(event, "Saving...", async (email, password) => {
        return await supabase.auth.updateUser({
            email: email,
            password: password,
        });
    });
}