// ===== Auth Page Logic =====

function showLogin() {
  document.getElementById('login-card').classList.remove('hidden');
  document.getElementById('signup-card').classList.add('hidden');
  clearErrors();
}

function showSignup() {
  document.getElementById('login-card').classList.add('hidden');
  document.getElementById('signup-card').classList.remove('hidden');
  clearErrors();
}

function clearErrors() {
  document.querySelectorAll('.form-error').forEach(el => el.classList.add('hidden'));
}

function showError(formId, message) {
  const errorEl = document.getElementById(`${formId}-error`);
  const textEl = document.getElementById(`${formId}-error-text`);
  textEl.textContent = message;
  errorEl.classList.remove('hidden');
}

function setLoading(formId, loading) {
  const btn = document.getElementById(`${formId}-submit`);
  const spinner = document.getElementById(`${formId}-spinner`);
  btn.disabled = loading;
  spinner.classList.toggle('hidden', !loading);
}

function togglePassword(inputId, btn) {
  const input = document.getElementById(inputId);
  const isPassword = input.type === 'password';
  input.type = isPassword ? 'text' : 'password';
  btn.innerHTML = isPassword ? '<i class="fas fa-eye-slash"></i>' : '<i class="fas fa-eye"></i>';
}

// Password strength indicator
const signupPassword = document.getElementById('signup-password');
if (signupPassword) {
  signupPassword.addEventListener('input', () => {
    const val = signupPassword.value;
    const fill = document.getElementById('strength-fill');
    const text = document.getElementById('strength-text');

    let strength = 0;
    if (val.length >= 6) strength++;
    if (val.length >= 10) strength++;
    if (/[A-Z]/.test(val) && /[a-z]/.test(val)) strength++;
    if (/[0-9]/.test(val)) strength++;
    if (/[^A-Za-z0-9]/.test(val)) strength++;

    const levels = [
      { width: '0%', color: 'transparent', label: '' },
      { width: '20%', color: '#e74c3c', label: 'Weak' },
      { width: '40%', color: '#e67e22', label: 'Fair' },
      { width: '60%', color: '#f1c40f', label: 'Good' },
      { width: '80%', color: '#2ecc71', label: 'Strong' },
      { width: '100%', color: '#00cec9', label: 'Excellent' },
    ];
    const level = levels[strength];
    fill.style.width = level.width;
    fill.style.background = level.color;
    text.textContent = level.label;
    text.style.color = level.color;
  });
}

// Login handler
async function handleLogin(e) {
  e.preventDefault();
  clearErrors();
  setLoading('login', true);

  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();

    if (!res.ok) {
      showError('login', data.error || 'Login failed');
      setLoading('login', false);
      return;
    }

    // Store name for meeting room
    sessionStorage.setItem('vcall-username', data.user.name);
    window.location.href = '/';
  } catch (err) {
    showError('login', 'Network error. Please try again.');
    setLoading('login', false);
  }
}

// Signup handler
async function handleSignup(e) {
  e.preventDefault();
  clearErrors();
  setLoading('signup', true);

  const name = document.getElementById('signup-name').value.trim();
  const email = document.getElementById('signup-email').value.trim();
  const password = document.getElementById('signup-password').value;

  try {
    const res = await fetch('/api/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, password }),
    });
    const data = await res.json();

    if (!res.ok) {
      showError('signup', data.error || 'Signup failed');
      setLoading('signup', false);
      return;
    }

    sessionStorage.setItem('vcall-username', data.user.name);
    window.location.href = '/';
  } catch (err) {
    showError('signup', 'Network error. Please try again.');
    setLoading('signup', false);
  }
}
