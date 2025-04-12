// server.js
require('dotenv').config();
const express       = require('express');
const bodyParser    = require('body-parser');
const http          = require('http');
const socketIo      = require('socket.io');
const session       = require('express-session');
const bcrypt        = require('bcrypt');
const Groq          = require('groq-sdk');
const groq = new Groq({apiKey: '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'}) 
const db            = require('./db');

const app    = express();
const server = http.createServer(app);
const io     = socketIo(server);
const PORT   = process.env.PORT || 3000;

// Middleware
app.use(bodyParser.json({ limit: '10mb' }));
app.use(express.static('public'));

app.use(
  session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false } // Set to true if using HTTPS
  })
);

// Helper: require login middleware
function requireLogin(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({ success: false, message: 'Not logged in' });
  }
  next();
}

// Helper: Generate subtasks using Groq (simplified)
async function generateSubtasks(description) {
  const messages = [
    { role: "system", content: `You are an AI task‑decomposer.  
Given a single High‑Level Task, break it into exactly three sequential, low‑level subtasks.  

For each subtask, provide:
- "id": 1, 2, or 3  
- "description": one concise sentence of the action to perform  
- "criteria": the exact OCR log keywords or patterns that would unambiguously indicate completion of this subtask  

Do NOT analyze any OCR data yourself—just produce the subtasks and their OCR‑based success criteria.  

Output (JSON):
{
  "subtasks": [
    {
      "id": 1,
      "description": "…",
      "criteria": "…"
    },
    {
      "id": 2,
      "description": "…",
      "criteria": "…"
    },
    {
      "id": 3,
      "description": "…",
      "criteria": "…"
    }
  ]
}`
 },
    { role: "user",   content: description }
  ];
  const chat = await groq.chat.completions.create({
    messages,
    model: "qwen-qwq-32b",
    temperature: 0.6,
    stream: true
  });
  let full = "";
  for await (const chunk of chat) {
    full += chunk.choices[0].delta?.content || "";
  }
  return JSON.parse(
    full.slice(full.indexOf('{'), full.lastIndexOf('}') + 1)
  ).subtasks;
}

// Authentication Endpoints

// Sign Up
app.post('/api/signup', async (req, res) => {
  const { username, password, role } = req.body;
  if (!username || !password || !role) {
    return res.status(400).json({ success: false, message: 'Missing fields' });
  }
  try {
    const password_hash = await bcrypt.hash(password, 10);
    const result = await db.query(
      `INSERT INTO users (username, password_hash, role)
       VALUES ($1, $2, $3)
       RETURNING id, username, role`,
      [username, password_hash, role]
    );
    const user = result.rows[0];
    // Store numeric user id in session
    req.session.user = user;
    res.json({ success: true, user });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ success: false, message: 'Username already taken' });
    }
    console.error(err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// Log In
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ success: false, message: 'Missing fields' });
  }
  try {
    const { rows } = await db.query(
      `SELECT id, username, password_hash, role
       FROM users WHERE username = $1`,
      [username]
    );
    if (rows.length === 0) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }
    const user = rows[0];
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }
    // Remove hash before storing in session
    delete user.password_hash;
    req.session.user = user;
    res.json({ success: true, user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// Log Out
app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ success: true });
  });
});

// Task Endpoints

// Create a new task (Receiver only)
app.post('/api/task', requireLogin, async (req, res) => {
  const { description, payment } = req.body;
  const receiverId = req.session.user.id;
  if (!description || !payment) {
    return res.status(400).json({ success: false, message: 'Missing fields' });
  }
  try {
    const { rows } = await db.query(
      `INSERT INTO tasks
         (description, payment, receiver_id, status)
       VALUES ($1, $2, $3, 'open')
       RETURNING *`,
      [description, payment, receiverId]
    );
    const task = rows[0];
    io.emit('taskCreated', task);
    res.json({ success: true, task });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// List tasks (open or in-progress)
app.get('/api/tasks', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT * FROM tasks
       WHERE status IN ('open','doing task')`
    );
    res.json({ success: true, tasks: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// Assign a task to a sender
app.post('/api/assign', requireLogin, async (req, res) => {
  const { taskId } = req.body;
  // Use the numeric id from session rather than passing a string from the client.
  const senderId = req.session.user.id;
  try {
    const { rows, rowCount } = await db.query(
      `UPDATE tasks
         SET sender_id = $1, status = 'doing task'
       WHERE id = $2 AND status = 'open'
       RETURNING *`,
      [senderId, taskId]
    );
    if (rowCount === 0) {
      return res.status(404).json({ success: false, message: 'Task not found' });
    }
    const task = rows[0];
    io.emit('taskUpdated', task);
    res.json({ success: true, task });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// Generate and store subtasks for a given task
app.post('/api/generateSubtasks', requireLogin, async (req, res) => {
  const { taskId, taskDescription } = req.body;
  if (!taskId || !taskDescription) {
    return res.status(400).json({ success: false, message: 'Missing fields' });
  }
  try {
    const subtasks = await generateSubtasks(taskDescription);
    const insertText = `
      INSERT INTO subtasks
        (task_id, id, description, criteria, status)
      VALUES ($1, $2, $3, $4, 'pending')
    `;
    for (const sub of subtasks) {
      await db.query(insertText, [
        taskId,
        sub.id,
        sub.description,
        sub.criteria
      ]);
    }
    io.emit('subtasksGenerated', { taskId, subtasks });
    res.json({ success: true, subtasks });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// Upload result for a subtask
app.post('/api/upload', requireLogin, async (req, res) => {
  const { senderId, taskId, subtaskId, result } = req.body;
  if (!senderId || !taskId || !subtaskId || !result) {
    return res.status(400).json({ success: false, message: 'Missing fields' });
  }
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO uploads
         (sender_id, subtask_id, result)
       VALUES ($1, $2, $3)`,
      [senderId, subtaskId, result]
    );
    await client.query(
      `UPDATE subtasks
         SET status = $1
       WHERE task_id = $2 AND id = $3`,
      [result === 'pass' ? 'passed' : 'pending', taskId, subtaskId]
    );
    const { rows } = await client.query(
      `SELECT COUNT(*) FILTER (WHERE status != 'passed') AS not_passed
         FROM subtasks WHERE task_id = $1`,
      [taskId]
    );
    if (Number(rows[0].not_passed) === 0) {
      await client.query(
        `UPDATE tasks SET status='passed' WHERE id=$1`,
        [taskId]
      );
      io.emit('taskUpdated', { taskId, status: 'passed' });
    }
    await client.query('COMMIT');
    io.emit('subtaskUpdated', {
      taskId,
      subtaskId,
      status: result === 'pass' ? 'passed' : 'pending'
    });
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ success: false, message: err.message });
  } finally {
    client.release();
  }
});

// Start the server
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});