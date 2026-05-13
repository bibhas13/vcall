// ===== Landing Page Logic =====
let previewStream = null;
let isMicOn = true;
let isCamOn = true;
let pendingRoomId = null;
let currentUser = null;

// --- Load current user info ---
(async function loadUser() {
  try {
    const res = await fetch('/api/auth/me');
    if (res.ok) {
      const data = await res.json();
      currentUser = data.user;
      sessionStorage.setItem('vcall-username', currentUser.name);

      // Populate user menu
      document.getElementById('avatar-initial').textContent = currentUser.name.charAt(0).toUpperCase();
      document.getElementById('dropdown-name').textContent = currentUser.name;
      document.getElementById('dropdown-email').textContent = currentUser.email;
    }
  } catch (err) {
    console.warn('Could not load user:', err);
  }
})();

function toggleUserMenu() {
  document.getElementById('user-dropdown').classList.toggle('hidden');
}
document.addEventListener('click', (e) => {
  if (!e.target.closest('.user-menu')) {
    document.getElementById('user-dropdown')?.classList.add('hidden');
  }
});

async function handleLogout() {
  await fetch('/api/auth/logout', { method: 'POST' });
  sessionStorage.removeItem('vcall-username');
  window.location.href = '/auth.html';
}

// --- Join code input handling ---
const joinInput = document.getElementById('join-code-input');
const joinBtn = document.getElementById('btn-join-meeting');

joinInput.addEventListener('input', () => {
  joinBtn.disabled = joinInput.value.trim().length === 0;
});
joinInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && joinInput.value.trim()) joinMeeting();
});

// --- Create meeting ---
async function createMeeting() {
  try {
    const res = await fetch('/api/room', { method: 'POST' });
    const data = await res.json();
    pendingRoomId = data.roomId;
    openPrejoinModal();
  } catch (err) {
    showToast('Failed to create meeting. Please try again.', 'error');
  }
}

// --- Join meeting ---
function joinMeeting() {
  let code = joinInput.value.trim();
  if (!code) return;

  // If user pasted a full URL, extract just the room ID
  if (code.includes('/room/')) {
    code = code.split('/room/').pop();
  }

  pendingRoomId = code;
  openPrejoinModal();
}

// --- Pre-join modal ---
async function openPrejoinModal() {
  const modal = document.getElementById('prejoin-modal');
  modal.classList.add('active');

  document.getElementById('meeting-link-display').textContent =
    `${window.location.origin}/room/${pendingRoomId}`;

  // Start camera preview
  try {
    previewStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    const video = document.getElementById('preview-video');
    video.srcObject = previewStream;
    document.getElementById('preview-placeholder').classList.remove('active');
  } catch (err) {
    document.getElementById('preview-placeholder').classList.add('active');
    console.warn('Could not access camera:', err);
  }

  // Auto-fill user name from auth
  const nameInput = document.getElementById('user-name-input');
  if (currentUser && currentUser.name) {
    nameInput.value = currentUser.name;
  }

  // Focus name input
  setTimeout(() => nameInput.focus(), 300);
}

function closePrejoinModal() {
  const modal = document.getElementById('prejoin-modal');
  modal.classList.remove('active');
  stopPreviewStream();
  pendingRoomId = null;
}

function stopPreviewStream() {
  if (previewStream) {
    previewStream.getTracks().forEach(t => t.stop());
    previewStream = null;
  }
}

function togglePreviewMic() {
  isMicOn = !isMicOn;
  const btn = document.getElementById('preview-mic-btn');
  if (previewStream) {
    previewStream.getAudioTracks().forEach(t => (t.enabled = isMicOn));
  }
  btn.classList.toggle('active', isMicOn);
  btn.classList.toggle('muted', !isMicOn);
  btn.innerHTML = isMicOn
    ? '<i class="fas fa-microphone"></i>'
    : '<i class="fas fa-microphone-slash"></i>';
}

function togglePreviewCam() {
  isCamOn = !isCamOn;
  const btn = document.getElementById('preview-cam-btn');
  const placeholder = document.getElementById('preview-placeholder');
  if (previewStream) {
    previewStream.getVideoTracks().forEach(t => (t.enabled = isCamOn));
  }
  btn.classList.toggle('active', isCamOn);
  btn.classList.toggle('muted', !isCamOn);
  btn.innerHTML = isCamOn
    ? '<i class="fas fa-video"></i>'
    : '<i class="fas fa-video-slash"></i>';
  placeholder.classList.toggle('active', !isCamOn);
}

function enterRoom() {
  const name = document.getElementById('user-name-input').value.trim() || 'Guest';
  stopPreviewStream();

  // Store preferences
  sessionStorage.setItem('vcall-username', name);
  sessionStorage.setItem('vcall-mic', isMicOn);
  sessionStorage.setItem('vcall-cam', isCamOn);

  window.location.href = `/room/${pendingRoomId}`;
}

function copyMeetingLink() {
  const link = `${window.location.origin}/room/${pendingRoomId}`;
  navigator.clipboard.writeText(link).then(() => {
    showToast('Meeting link copied!', 'success');
  });
}

// --- Toast ---
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = 'toast';
  const icon = type === 'success' ? 'check-circle' : type === 'error' ? 'exclamation-circle' : 'info-circle';
  toast.innerHTML = `<i class="fas fa-${icon}"></i><span>${message}</span>`;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

// --- Animated stats counter ---
function animateCounters() {
  document.querySelectorAll('.stat-number').forEach(el => {
    const target = parseInt(el.dataset.count);
    const duration = 1500;
    const start = performance.now();

    function update(now) {
      const elapsed = now - start;
      const progress = Math.min(elapsed / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      el.textContent = Math.floor(target * eased);
      if (progress < 1) requestAnimationFrame(update);
    }
    requestAnimationFrame(update);
  });
}

// Intersection observer for counter animation
const statsObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      animateCounters();
      statsObserver.disconnect();
    }
  });
}, { threshold: 0.5 });

const statsEl = document.getElementById('hero-stats');
if (statsEl) statsObserver.observe(statsEl);

// Scroll-based feature card reveals
const cardObserver = new IntersectionObserver((entries) => {
  entries.forEach((entry, i) => {
    if (entry.isIntersecting) {
      entry.target.style.animation = `fadeInUp 0.5s ease-out ${i * 0.1}s both`;
      cardObserver.unobserve(entry.target);
    }
  });
}, { threshold: 0.1 });

document.querySelectorAll('.feature-card, .step-card').forEach(card => {
  card.style.opacity = '0';
  cardObserver.observe(card);
});
