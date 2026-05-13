// ===== Room Logic =====
const socket = io();
const roomId = window.location.pathname.split('/').pop();
const userName = sessionStorage.getItem('vcall-username') || 'Guest';
let initialMic = sessionStorage.getItem('vcall-mic') !== 'false';
let initialCam = sessionStorage.getItem('vcall-cam') !== 'false';

// State
let localStream = null;
let screenStream = null;
let myPeer = null;
let myPeerId = null;
let isMuted = !initialMic;
let isCameraOff = !initialCam;
let isScreenSharing = false;
let isHandRaised = false;
let isChatOpen = false;
let isParticipantsOpen = false;
let peers = {}; // peerId -> { call, video, userName }
let startTime = Date.now();

// DOM
const videoGrid = document.getElementById('video-grid');
const chatMessages = document.getElementById('chat-messages');
const chatInput = document.getElementById('chat-input');
const chatPanel = document.getElementById('chat-panel');
const participantsPanel = document.getElementById('participants-panel');
const participantsList = document.getElementById('participants-list');
const roomMain = document.getElementById('room-main');

// ===== Initialize =====
async function init() {
  // Display room ID
  document.getElementById('room-id-display').textContent = roomId;
  document.getElementById('copy-room-id').onclick = () => {
    navigator.clipboard.writeText(`${window.location.origin}/room/${roomId}`);
    showToast('Meeting link copied!');
  };

  // Get media
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  } catch (err) {
    console.warn('Camera/mic error:', err);
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => {
      return new MediaStream();
    });
  }

  // Apply initial states
  if (isMuted) {
    localStream.getAudioTracks().forEach(t => (t.enabled = false));
  }
  if (isCameraOff) {
    localStream.getVideoTracks().forEach(t => (t.enabled = false));
  }

  // Add local video
  addVideoTile('local', localStream, userName + ' (You)', true);
  updateToolbarButtons();

  // Setup PeerJS with ICE servers (STUN + TURN)
  let iceServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ];

  // Try to get TURN credentials from server
  try {
    const iceRes = await fetch('/api/ice-servers');
    if (iceRes.ok) {
      const data = await iceRes.json();
      if (data.iceServers && data.iceServers.length > 0) {
        iceServers = data.iceServers;
      }
    }
  } catch (err) {
    console.warn('Could not fetch TURN credentials, using STUN only:', err);
  }

  // Build PeerJS config — don't pass port for default HTTPS/HTTP (Render needs this)
  const peerConfig = {
    host: window.location.hostname,
    path: '/peerjs',
    secure: window.location.protocol === 'https:',
    config: { iceServers },
    debug: 2,
  };
  // Only set port if non-default (e.g. localhost:3000)
  if (window.location.port) {
    peerConfig.port = parseInt(window.location.port);
  }

  myPeer = new Peer(undefined, peerConfig);

  myPeer.on('open', (id) => {
    myPeerId = id;
    console.log('My peer ID:', id);
    socket.emit('join-room', { roomId, peerId: id, userName });
  });

  myPeer.on('error', (err) => {
    console.error('PeerJS error:', err);
    showToast('Connection issue — retrying...');
    // Reconnect after error
    setTimeout(() => {
      if (myPeer && myPeer.destroyed) {
        myPeer = new Peer(undefined, peerConfig);
        myPeer.on('open', (id) => {
          myPeerId = id;
          socket.emit('join-room', { roomId, peerId: id, userName });
        });
      }
    }, 3000);
  });

  myPeer.on('disconnected', () => {
    console.warn('PeerJS disconnected, reconnecting...');
    myPeer.reconnect();
  });

  // Answer incoming calls
  myPeer.on('call', (call) => {
    call.answer(localStream);
    call.on('stream', (remoteStream) => {
      const peerUserName = call.metadata?.userName || 'Participant';
      if (!peers[call.peer]) {
        peers[call.peer] = { call, userName: peerUserName };
        addVideoTile(call.peer, remoteStream, peerUserName, false);
      }
    });
    call.on('close', () => removeVideoTile(call.peer));
  });

  // Socket events
  socket.on('existing-users', (users) => {
    users.forEach(user => connectToPeer(user.peerId, user.userName));
  });

  socket.on('user-joined', ({ peerId, userName: name }) => {
    showToast(`${name} joined the meeting`);
    connectToPeer(peerId, name);
    updateParticipantsList();
  });

  socket.on('user-left', ({ peerId, userName: name }) => {
    showToast(`${name} left the meeting`);
    if (peers[peerId]) {
      peers[peerId].call?.close();
      removeVideoTile(peerId);
      delete peers[peerId];
    }
    updateParticipantsList();
  });

  socket.on('participant-count', (count) => {
    document.getElementById('participant-count').textContent = count;
    document.getElementById('people-count').textContent = count;
    updateGridLayout();
  });

  socket.on('chat-message', ({ message, userName: name, timestamp }) => {
    addChatMessage(name, message, timestamp, false);
    if (!isChatOpen) {
      document.getElementById('chat-notification').classList.remove('hidden');
    }
  });

  socket.on('user-toggle-audio', ({ peerId, isMuted: muted }) => {
    const tile = document.getElementById(`tile-${peerId}`);
    if (tile) {
      const indicator = tile.querySelector('.mic-indicator');
      if (indicator) {
        indicator.classList.toggle('hidden', !muted);
      }
    }
  });

  socket.on('user-toggle-video', ({ peerId, isCameraOff: camOff }) => {
    const tile = document.getElementById(`tile-${peerId}`);
    if (tile) {
      const placeholder = tile.querySelector('.avatar-placeholder');
      if (placeholder) placeholder.classList.toggle('active', camOff);
    }
  });

  socket.on('reaction', ({ emoji, userName: name }) => {
    showFloatingReaction(emoji);
  });

  socket.on('user-hand-raised', ({ peerId, userName: name, raised }) => {
    const tile = document.getElementById(`tile-${peerId}`);
    if (tile) {
      const hand = tile.querySelector('.hand-icon');
      if (hand) hand.classList.toggle('hidden', !raised);
    }
    if (raised) showToast(`${name} raised their hand ✋`);
  });

  // Setup toolbar
  setupToolbar();
  startTimer();
  updateClock();
  setInterval(updateClock, 1000);
  updateParticipantsList();
}

// ===== Peer Connection =====
function connectToPeer(peerId, peerName) {
  if (peers[peerId]) return;
  const call = myPeer.call(peerId, localStream, { metadata: { userName } });
  call.on('stream', (remoteStream) => {
    if (!peers[peerId]) {
      peers[peerId] = { call, userName: peerName };
      addVideoTile(peerId, remoteStream, peerName, false);
      updateParticipantsList();
    }
  });
  call.on('close', () => {
    removeVideoTile(peerId);
    delete peers[peerId];
    updateParticipantsList();
  });
}

// ===== Video Tiles =====
function addVideoTile(id, stream, name, isLocal) {
  if (document.getElementById(`tile-${id}`)) return;

  const tile = document.createElement('div');
  tile.className = 'video-tile';
  tile.id = `tile-${id}`;

  const video = document.createElement('video');
  video.srcObject = stream;
  video.autoplay = true;
  video.playsInline = true;
  if (isLocal) video.muted = true;

  const avatar = document.createElement('div');
  avatar.className = 'avatar-placeholder';
  if (isLocal && isCameraOff) avatar.classList.add('active');
  const circle = document.createElement('div');
  circle.className = 'avatar-circle';
  circle.textContent = name.charAt(0).toUpperCase();
  avatar.appendChild(circle);

  const overlay = document.createElement('div');
  overlay.className = 'tile-overlay';
  overlay.innerHTML = `
    <div class="tile-name">
      <span>${name}</span>
      <span class="hand-icon hidden">✋</span>
    </div>
    <div class="tile-indicators">
      <div class="indicator muted mic-indicator ${isLocal && isMuted ? '' : 'hidden'}">
        <i class="fas fa-microphone-slash"></i>
      </div>
    </div>
  `;

  tile.appendChild(video);
  tile.appendChild(avatar);
  tile.appendChild(overlay);
  videoGrid.appendChild(tile);
  updateGridLayout();
}

function removeVideoTile(id) {
  const tile = document.getElementById(`tile-${id}`);
  if (tile) {
    tile.style.animation = 'fadeOut 0.3s ease forwards';
    setTimeout(() => {
      tile.remove();
      updateGridLayout();
    }, 300);
  }
}

function updateGridLayout() {
  const count = videoGrid.children.length;
  videoGrid.setAttribute('data-count', Math.min(count, 6));
}

// ===== Toolbar =====
function setupToolbar() {
  // Mic
  document.getElementById('btn-mic').onclick = () => {
    isMuted = !isMuted;
    localStream.getAudioTracks().forEach(t => (t.enabled = !isMuted));
    socket.emit('toggle-audio', { roomId, peerId: myPeerId, isMuted });
    const localTile = document.getElementById('tile-local');
    if (localTile) {
      localTile.querySelector('.mic-indicator')?.classList.toggle('hidden', !isMuted);
    }
    updateToolbarButtons();
  };

  // Camera
  document.getElementById('btn-camera').onclick = () => {
    isCameraOff = !isCameraOff;
    localStream.getVideoTracks().forEach(t => (t.enabled = !isCameraOff));
    socket.emit('toggle-video', { roomId, peerId: myPeerId, isCameraOff });
    const localTile = document.getElementById('tile-local');
    if (localTile) {
      localTile.querySelector('.avatar-placeholder')?.classList.toggle('active', isCameraOff);
    }
    updateToolbarButtons();
  };

  // Screen share
  document.getElementById('btn-screen-share').onclick = async () => {
    if (!isScreenSharing) {
      try {
        screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        isScreenSharing = true;
        socket.emit('screen-share-started', { roomId, peerId: myPeerId });

        // Show screen share view
        const ssView = document.getElementById('screen-share-view');
        const ssVideo = document.getElementById('screen-share-video');
        ssVideo.srcObject = screenStream;
        ssView.classList.remove('hidden');
        document.getElementById('screen-share-label').querySelector('span').textContent =
          `You are presenting`;

        // Replace video track in peer connections
        const videoTrack = screenStream.getVideoTracks()[0];
        Object.values(peers).forEach(({ call }) => {
          const sender = call.peerConnection?.getSenders().find(s => s.track?.kind === 'video');
          if (sender) sender.replaceTrack(videoTrack);
        });

        videoTrack.onended = () => stopScreenShare();
        updateToolbarButtons();
      } catch (err) {
        console.log('Screen share cancelled');
      }
    } else {
      stopScreenShare();
    }
  };

  // Hand raise
  document.getElementById('btn-hand').onclick = () => {
    isHandRaised = !isHandRaised;
    socket.emit('hand-raised', { roomId, peerId: myPeerId, userName, raised: isHandRaised });
    const localTile = document.getElementById('tile-local');
    if (localTile) {
      localTile.querySelector('.hand-icon')?.classList.toggle('hidden', !isHandRaised);
    }
    updateToolbarButtons();
  };

  // Reactions
  const reactionsPopup = document.getElementById('reactions-popup');
  document.getElementById('btn-reactions').onclick = () => {
    reactionsPopup.classList.toggle('hidden');
  };
  document.querySelectorAll('.reaction-btn').forEach(btn => {
    btn.onclick = () => {
      const emoji = btn.dataset.emoji;
      socket.emit('reaction', { roomId, emoji, userName });
      showFloatingReaction(emoji);
      reactionsPopup.classList.add('hidden');
    };
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#btn-reactions') && !e.target.closest('.reactions-popup')) {
      reactionsPopup.classList.add('hidden');
    }
  });

  // Chat toggle
  document.getElementById('btn-chat').onclick = () => {
    isChatOpen = !isChatOpen;
    chatPanel.classList.toggle('open', isChatOpen);
    if (isChatOpen) {
      isParticipantsOpen = false;
      participantsPanel.classList.remove('open');
      document.getElementById('chat-notification').classList.add('hidden');
      chatInput.focus();
    }
    roomMain.classList.toggle('chat-open', isChatOpen);
    roomMain.classList.remove('participants-open');
    updateToolbarButtons();
  };
  document.getElementById('close-chat-btn').onclick = () => {
    isChatOpen = false;
    chatPanel.classList.remove('open');
    roomMain.classList.remove('chat-open');
    updateToolbarButtons();
  };

  // Participants toggle
  document.getElementById('btn-participants').onclick = () => {
    isParticipantsOpen = !isParticipantsOpen;
    participantsPanel.classList.toggle('open', isParticipantsOpen);
    if (isParticipantsOpen) {
      isChatOpen = false;
      chatPanel.classList.remove('open');
      updateParticipantsList();
    }
    roomMain.classList.toggle('participants-open', isParticipantsOpen);
    roomMain.classList.remove('chat-open');
    updateToolbarButtons();
  };
  document.getElementById('close-participants-btn').onclick = () => {
    isParticipantsOpen = false;
    participantsPanel.classList.remove('open');
    roomMain.classList.remove('participants-open');
    updateToolbarButtons();
  };

  // Chat send
  chatInput.onkeydown = (e) => {
    if (e.key === 'Enter' && chatInput.value.trim()) sendChatMessage();
  };
  document.getElementById('send-message-btn').onclick = () => {
    if (chatInput.value.trim()) sendChatMessage();
  };

  // Leave
  document.getElementById('btn-leave').onclick = () => {
    document.getElementById('leave-modal').classList.remove('hidden');
  };
  document.getElementById('btn-cancel-leave').onclick = () => {
    document.getElementById('leave-modal').classList.add('hidden');
  };
  document.getElementById('btn-confirm-leave').onclick = () => {
    leaveRoom();
  };
}

function updateToolbarButtons() {
  const micBtn = document.getElementById('btn-mic');
  const camBtn = document.getElementById('btn-camera');
  const screenBtn = document.getElementById('btn-screen-share');
  const handBtn = document.getElementById('btn-hand');
  const chatBtn = document.getElementById('btn-chat');
  const participantsBtn = document.getElementById('btn-participants');

  micBtn.classList.toggle('active', !isMuted);
  micBtn.classList.toggle('muted', isMuted);
  micBtn.querySelector('.btn-icon').innerHTML = isMuted
    ? '<i class="fas fa-microphone-slash"></i>' : '<i class="fas fa-microphone"></i>';

  camBtn.classList.toggle('active', !isCameraOff);
  camBtn.classList.toggle('muted', isCameraOff);
  camBtn.querySelector('.btn-icon').innerHTML = isCameraOff
    ? '<i class="fas fa-video-slash"></i>' : '<i class="fas fa-video"></i>';

  screenBtn.classList.toggle('sharing', isScreenSharing);
  handBtn.classList.toggle('raised', isHandRaised);
  chatBtn.classList.toggle('active', isChatOpen);
  participantsBtn.classList.toggle('active', isParticipantsOpen);
}

function stopScreenShare() {
  if (screenStream) {
    screenStream.getTracks().forEach(t => t.stop());
    screenStream = null;
  }
  isScreenSharing = false;
  document.getElementById('screen-share-view').classList.add('hidden');
  socket.emit('screen-share-stopped', { roomId, peerId: myPeerId });

  // Restore camera track
  const videoTrack = localStream.getVideoTracks()[0];
  if (videoTrack) {
    Object.values(peers).forEach(({ call }) => {
      const sender = call.peerConnection?.getSenders().find(s => s.track?.kind === 'video');
      if (sender) sender.replaceTrack(videoTrack);
    });
  }
  updateToolbarButtons();
}

// ===== Chat =====
function sendChatMessage() {
  const msg = chatInput.value.trim();
  if (!msg) return;
  const ts = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  addChatMessage(userName, msg, ts, true);
  socket.emit('chat-message', { roomId, message: msg, userName, timestamp: ts });
  chatInput.value = '';
}

function addChatMessage(name, message, timestamp, isSelf) {
  const empty = document.getElementById('chat-empty');
  if (empty) empty.style.display = 'none';

  const div = document.createElement('div');
  div.className = `chat-msg ${isSelf ? 'self' : ''}`;
  div.innerHTML = `
    <div class="chat-msg-header">
      <span class="chat-msg-name">${isSelf ? 'You' : name}</span>
      <span class="chat-msg-time">${timestamp}</span>
    </div>
    <div class="chat-msg-text">${escapeHtml(message)}</div>
  `;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ===== Participants List =====
function updateParticipantsList() {
  participantsList.innerHTML = '';

  // Add self
  addParticipantItem(userName + ' (You)', !isMuted, !isCameraOff, true);

  // Add peers
  Object.values(peers).forEach(({ userName: name }) => {
    addParticipantItem(name, true, true, false);
  });
}

function addParticipantItem(name, micOn, camOn, isSelf) {
  const item = document.createElement('div');
  item.className = 'participant-item';
  item.innerHTML = `
    <div class="avatar-sm">${name.charAt(0).toUpperCase()}</div>
    <div class="name">${name}</div>
    <div class="status-icons">
      <i class="fas fa-microphone${micOn ? '' : '-slash off'}"></i>
      <i class="fas fa-video${camOn ? '' : '-slash off'}"></i>
    </div>
  `;
  participantsList.appendChild(item);
}

// ===== Reactions =====
function showFloatingReaction(emoji) {
  const container = document.getElementById('floating-reactions');
  const el = document.createElement('div');
  el.className = 'floating-emoji';
  el.textContent = emoji;
  el.style.left = Math.random() * 40 + 'px';
  container.appendChild(el);
  setTimeout(() => el.remove(), 2000);
}

// ===== Timer & Clock =====
function startTimer() {
  setInterval(() => {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    const mins = String(Math.floor(elapsed / 60)).padStart(2, '0');
    const secs = String(elapsed % 60).padStart(2, '0');
    document.getElementById('timer-display').textContent = `${mins}:${secs}`;
  }, 1000);
}

function updateClock() {
  document.getElementById('current-time-display').textContent =
    new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// ===== Leave =====
function leaveRoom() {
  if (localStream) localStream.getTracks().forEach(t => t.stop());
  if (screenStream) screenStream.getTracks().forEach(t => t.stop());
  if (myPeer) myPeer.destroy();
  socket.disconnect();
  window.location.href = '/';
}

// ===== Toast =====
function showToast(message) {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.innerHTML = `<i class="fas fa-info-circle"></i><span>${message}</span>`;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

// ===== Keyboard shortcuts =====
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if (e.key === 'd' && e.ctrlKey) { e.preventDefault(); document.getElementById('btn-mic').click(); }
  if (e.key === 'e' && e.ctrlKey) { e.preventDefault(); document.getElementById('btn-camera').click(); }
});

// ===== Start =====
init();
