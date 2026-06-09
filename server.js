const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// In-memory session store
const sessions = {};

function generatePin() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// REST: create session
app.post('/api/session', (req, res) => {
  const pin = generatePin();
  sessions[pin] = {
    pin,
    teacherSocketId: null,
    questions: [],
    activeIndex: -1,
    responses: {},
    started: false,
    createdAt: Date.now()
  };
  res.json({ pin });
});

// REST: get session info (student join check)
app.get('/api/session/:pin', (req, res) => {
  const session = sessions[req.params.pin];
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json({
    pin: session.pin,
    started: session.started,
    activeIndex: session.activeIndex,
    activeQuestion: session.activeIndex >= 0 ? session.questions[session.activeIndex] : null
  });
});

io.on('connection', (socket) => {

  // Teacher registers as owner of a session
  socket.on('teacher:register', ({ pin }) => {
    const session = sessions[pin];
    if (!session) return socket.emit('error', 'Session not found');
    session.teacherSocketId = socket.id;
    socket.join(`session:${pin}`);
    socket.data.pin = pin;
    socket.data.role = 'teacher';
    socket.emit('session:state', buildState(session));
  });

  // Student joins a session
  socket.on('student:join', ({ pin, nickname }) => {
    const session = sessions[pin];
    if (!session) return socket.emit('error', 'Invalid session PIN');
    socket.join(`session:${pin}`);
    socket.data.pin = pin;
    socket.data.role = 'student';
    socket.data.nickname = nickname || 'Anonymous';
    socket.emit('session:state', buildStudentState(session));
    io.to(`session:${pin}`).emit('student:joined', {
      count: countStudents(pin)
    });
  });

  // Teacher adds a question
  socket.on('teacher:add_question', ({ pin, question }) => {
    const session = sessions[pin];
    if (!session) return;
    const q = {
      id: Date.now().toString(),
      type: question.type, // 'multiple_choice' | 'open_ended' | 'feeling'
      text: question.text,
      options: question.options || [],
      anonymous: true
    };
    session.questions.push(q);
    session.responses[q.id] = [];
    socket.emit('session:state', buildState(session));
  });

  // Teacher removes a question
  socket.on('teacher:remove_question', ({ pin, questionId }) => {
    const session = sessions[pin];
    if (!session) return;
    session.questions = session.questions.filter(q => q.id !== questionId);
    delete session.responses[questionId];
    socket.emit('session:state', buildState(session));
  });

  // Teacher activates a question (broadcasts to students)
  socket.on('teacher:activate', ({ pin, index }) => {
    const session = sessions[pin];
    if (!session) return;
    session.activeIndex = index;
    session.started = true;
    io.to(`session:${pin}`).emit('question:active', {
      index,
      question: index >= 0 ? session.questions[index] : null
    });
    socket.emit('session:state', buildState(session));
  });

  // Teacher toggles showing results
  socket.on('teacher:show_results', ({ pin, show }) => {
    const session = sessions[pin];
    if (!session) return;
    const q = session.questions[session.activeIndex];
    if (!q) return;
    const results = buildResults(session, q.id);
    if (show) {
      io.to(`session:${pin}`).emit('results:update', { questionId: q.id, results });
    } else {
      io.to(`session:${pin}`).emit('results:hide');
    }
  });

  // Student submits a response
  socket.on('student:respond', ({ pin, questionId, answer }) => {
    const session = sessions[pin];
    if (!session) return;
    if (!session.responses[questionId]) session.responses[questionId] = [];

    // One response per socket per question
    session.responses[questionId] = session.responses[questionId].filter(
      r => r.socketId !== socket.id
    );
    session.responses[questionId].push({
      socketId: socket.id,
      answer,
      timestamp: Date.now()
    });

    socket.emit('response:ack');

    // Send live update to teacher
    const q = session.questions.find(q => q.id === questionId);
    if (q) {
      const results = buildResults(session, questionId);
      io.to(session.teacherSocketId).emit('results:live', { questionId, results });
      io.to(session.teacherSocketId).emit('session:state', buildState(session));
    }
  });

  socket.on('disconnect', () => {
    const pin = socket.data.pin;
    if (pin && sessions[pin]) {
      io.to(`session:${pin}`).emit('student:joined', {
        count: countStudents(pin)
      });
    }
  });
});

function countStudents(pin) {
  const room = io.sockets.adapter.rooms.get(`session:${pin}`);
  if (!room) return 0;
  let count = 0;
  for (const sid of room) {
    const s = io.sockets.sockets.get(sid);
    if (s && s.data.role === 'student') count++;
  }
  return count;
}

function buildResults(session, questionId) {
  const responses = session.responses[questionId] || [];
  const q = session.questions.find(q => q.id === questionId);
  if (!q) return null;

  if (q.type === 'multiple_choice') {
    const tally = {};
    for (const opt of q.options) tally[opt] = 0;
    for (const r of responses) {
      if (tally[r.answer] !== undefined) tally[r.answer]++;
    }
    return { type: 'multiple_choice', tally, total: responses.length };
  }

  if (q.type === 'feeling') {
    const feelings = ['😄', '🙂', '😐', '😕', '😟'];
    const tally = {};
    for (const f of feelings) tally[f] = 0;
    for (const r of responses) {
      if (tally[r.answer] !== undefined) tally[r.answer]++;
    }
    return { type: 'feeling', tally, total: responses.length };
  }

  if (q.type === 'open_ended') {
    return {
      type: 'open_ended',
      answers: responses.map(r => r.answer),
      total: responses.length
    };
  }
}

function buildState(session) {
  return {
    pin: session.pin,
    questions: session.questions,
    activeIndex: session.activeIndex,
    started: session.started,
    responses: session.responses
  };
}

function buildStudentState(session) {
  return {
    pin: session.pin,
    started: session.started,
    activeIndex: session.activeIndex,
    activeQuestion: session.activeIndex >= 0 ? session.questions[session.activeIndex] : null
  };
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`ClassMate running at http://localhost:${PORT}`);
});
