// 1. Initialize the connection
const supabaseUrl = 'YOUR_PROJECT_URL'
const supabaseKey = 'YOUR_ANON_KEY'
//const supabase = createClient(supabaseUrl, supabaseKey)

// 2. How to Sign Up a New User
async function signUpNewUser(email, password) {
  const { data, error } = await supabase.auth.signUp({
    email: email,
    password: password,
  })
  
  if (error) console.log("Error signing up:", error.message)
  else console.log("Success! User created:", data.user)
}

// 3. How to Log In an Existing User
async function logInUser(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({
    email: email,
    password: password,
  })

  if (error) console.log("Error logging in:", error.message)
  else console.log("Success! User logged in:", data.user)
}

// Auth
export async function updateTheaterAccount(event) {
    event.preventDefault();

    // 1. Get Inputs and Error text elements
    const emailInput = document.getElementById('settings-email');
    const passwordInput = document.getElementById('settings-password');
    const emailError = document.getElementById('email-error');
    const passwordError = document.getElementById('password-error');

    const email = emailInput.value.trim();
    const password = passwordInput.value;

    // 2. Reset Errors visually
    emailError.classList.add('hidden');
    passwordError.classList.add('hidden');
    emailInput.classList.remove('border-red-500', 'focus:ring-red-500');
    passwordInput.classList.remove('border-red-500', 'focus:ring-red-500');

    let isValid = true;

    // 3. Email Validation
    const strictEmailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!strictEmailRegex.test(email)) {
        emailError.textContent = "Please enter a valid email address.";
        emailError.classList.remove('hidden');
        emailInput.classList.add('border-red-500', 'focus:ring-red-500'); 
        isValid = false;
    }

    // 4. Password Validation
    if (password.length <= 6) {
        passwordError.textContent = "Password must be more than 6 characters.";
        passwordError.classList.remove('hidden');
        passwordInput.classList.add('border-red-500', 'focus:ring-red-500'); 
        isValid = false;
    }

    // Stop here if there were any errors
    if (!isValid) return;

    // 5. Supabase Update Logic
    const submitBtn = event.target.querySelector('button[type="submit"]');
    const originalText = submitBtn.textContent;
    
    // Show a loading state so the user knows something is happening
    submitBtn.textContent = "Updating...";
    submitBtn.disabled = true; // Prevent them from clicking twice

    // TRIGGER SUPABASE HERE
    const { data, error } = await supabase.auth.updateUser({
        email: email,
        password: password
    });

    // Re-enable the button once Supabase replies
    submitBtn.disabled = false;

    // 6. Handle Errors from Supabase (e.g., weak password, or network issue)
    if (error) {
        console.error("Supabase Error:", error.message);
        // You can reuse your password error text to show the Supabase error!
        passwordError.textContent = error.message;
        passwordError.classList.remove('hidden');
        submitBtn.textContent = originalText;
        return; 
    }

    // 7. Success State
    console.log("✅ Success! Account updated in database.", data);
    
    submitBtn.textContent = "Saved!";
    submitBtn.classList.replace('bg-blue-600', 'bg-green-600');
    
    setTimeout(() => {
        submitBtn.textContent = originalText;
        submitBtn.classList.replace('bg-green-600', 'bg-blue-600');
        
        // Optional: clear the password field after a successful save
        passwordInput.value = ''; 
    }, 2000);
}