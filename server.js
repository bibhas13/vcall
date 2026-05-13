require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const { ExpressPeerServer } = require('peer');
const mongoose = require('mongoose');
const cookieParser = require('cookie-parser');
const path = require('path');

const User = require('./models/User');
const { generateToken, verifyToken, requireAuth, requireAuthAPI } = require('./middleware/auth');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// PeerJS server
const peerServer = ExpressPeerServer(server, { debug: true, path: '/' });
app.use('/peerjs', peerServer);

// Middleware
app.use(express.json());
app.use(cookieParser());

// ===== Auth Routes (before static/protected routes) =====

// Serve auth page (public)
app.get('/auth.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'auth.html'));
});

// Signup
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'All fields are required' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ error: 'Email already registered' });
    }

    const user = await User.create({ name, email, password });
    const token = generateToken(user);

    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    });

    res.status(201).json({ user: { id: user._id, name: user.name, email: user.email } });
  } catch (err) {
    console.error('Signup error:', err);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

// Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const user = await User.findOne({ email }).select('+password');
    if (!user || !(await user.comparePassword(password))) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = generateToken(user);

    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    res.json({ user: { id: user._id, name: user.name, email: user.email } });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

// Logout
app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ message: 'Logged out' });
});

// Get current user
app.get('/api/auth/me', requireAuthAPI, (req, res) => {
  res.json({ user: req.user });
});

// ===== Static files (public assets like CSS/JS) =====
app.use('/styles', express.static(path.join(__dirname, 'public', 'styles')));
app.use('/scripts', express.static(path.join(__dirname, 'public', 'scripts')));
app.use('/assets', express.static(path.join(__dirname, 'public', 'assets')));

// ===== Protected Routes =====

// Home — requires login
app.get('/', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Room — requires login
app.get('/room/:roomId', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'room.html'));
});

// Create room — requires login
app.post('/api/room', requireAuthAPI, (req, res) => {
  const roomId = uuidv4().split('-').slice(0, 3).join('-');
  res.json({ roomId });
});

// ===== Socket.io =====
const rooms = new Map();

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  socket.on('join-room', ({ roomId, peerId, userName }) => {
    socket.join(roomId);

    if (!rooms.has(roomId)) {
      rooms.set(roomId, new Map());
    }
    const room = rooms.get(roomId);
    room.set(socket.id, { peerId, userName, isMuted: false, isCameraOff: false });

    socket.to(roomId).emit('user-joined', { peerId, userName, socketId: socket.id });

    const existingUsers = [];
    room.forEach((user, sid) => {
      if (sid !== socket.id) {
        existingUsers.push({ ...user, socketId: sid });
      }
    });
    socket.emit('existing-users', existingUsers);
    io.to(roomId).emit('participant-count', room.size);

    console.log(`${userName} joined room ${roomId} (${room.size} participants)`);

    socket.on('disconnect', () => {
      if (rooms.has(roomId)) {
        const room = rooms.get(roomId);
        room.delete(socket.id);
        socket.to(roomId).emit('user-left', { peerId, userName, socketId: socket.id });
        io.to(roomId).emit('participant-count', room.size);
        if (room.size === 0) rooms.delete(roomId);
        console.log(`${userName} left room ${roomId}`);
      }
    });
  });

  socket.on('chat-message', ({ roomId, message, userName, timestamp }) => {
    socket.to(roomId).emit('chat-message', { message, userName, timestamp });
  });

  socket.on('toggle-audio', ({ roomId, peerId, isMuted }) => {
    socket.to(roomId).emit('user-toggle-audio', { peerId, isMuted });
  });

  socket.on('toggle-video', ({ roomId, peerId, isCameraOff }) => {
    socket.to(roomId).emit('user-toggle-video', { peerId, isCameraOff });
  });

  socket.on('screen-share-started', ({ roomId, peerId }) => {
    socket.to(roomId).emit('user-screen-share', { peerId, sharing: true });
  });

  socket.on('screen-share-stopped', ({ roomId, peerId }) => {
    socket.to(roomId).emit('user-screen-share', { peerId, sharing: false });
  });

  socket.on('reaction', ({ roomId, emoji, userName }) => {
    io.to(roomId).emit('reaction', { emoji, userName });
  });

  socket.on('hand-raised', ({ roomId, peerId, userName, raised }) => {
    socket.to(roomId).emit('user-hand-raised', { peerId, userName, raised });
  });
});

// ===== Connect to MongoDB & Start Server =====
const MONGODB_URI = process.env.MONGODB_URI;
const PORT = process.env.PORT || 3000;

async function start() {
  if (MONGODB_URI) {
    try {
      await mongoose.connect(MONGODB_URI);
      console.log('✅ Connected to MongoDB');
    } catch (err) {
      console.error('❌ MongoDB connection error:', err.message);
      process.exit(1);
    }
  } else {
    console.warn('⚠️  No MONGODB_URI set — auth will not work. Set it in .env file.');
  }

  server.listen(PORT, () => {
    console.log(`\n🚀 vCall server running at http://localhost:${PORT}\n`);
  });
}

start();
