// server.js
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const http = require('http');
const socketIo = require('socket.io');
const session = require('express-session');
const bcrypt = require('bcrypt');
const Groq = require('groq-sdk');
const groq = new Groq({apiKey: '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'})
const db = require('./db');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);
const PORT = process.env.PORT || 3000;

// Middleware
app.use(bodyParser.json({ limit: '10mb' }));
app.use(express.static('public'));
app.use(
    session({
        secret: process.env.SESSION_SECRET || 'default_secret_key',
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

// Helper: Generate subtasks using Groq (fixed JSON template)
async function generateSubtasks(description) {
    const messages = [
        { role: "system", content: `You are an AI task‑decomposer.
Given a single High‑Level Task, break it into exactly three sequential, low‑level subtasks.
For each subtask, provide:
- "id": 1, 2, or 3
- "description": one concise sentence of the action to perform
- "criteria": the exact OCR log keywords or patterns that would unambiguously indicate completion of this subtask
- "status": which must always be "pending" and nothing else
Do NOT analyze any OCR data yourself—just produce the subtasks and their OCR‑based success criteria.
Output JSON in this exact format:
{
  "subtasks": [
    {
      "id": 1,
      "description": "...",
      "criteria": "...",
      "status": "pending"
    },
    {
      "id": 2,
      "description": "...",
      "criteria": "...",
      "status": "pending"
    },
    {
      "id": 3,
      "description": "...",
      "criteria": "...",
      "status": "pending"
    }
  ]
}` },
        { role: "user", content: description }
    ];
    
    try {
        const chat = await groq.chat.completions.create({
            messages,
            model: "meta-llama/llama-4-scout-17b-16e-instruct",
            temperature: 0.6,
            stream: false // Changed to non-streaming for more reliable results
        });
        
        // Parse the complete response
        const content = chat.choices[0].message.content;
        
        // Extract JSON using a more robust method
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            throw new Error("No valid JSON found in response");
        }
        
        const parsedData = JSON.parse(jsonMatch[0]);
        return parsedData.subtasks;
    } catch (err) {
        console.error("Error generating subtasks:", err);
        // Return default subtasks as fallback
        return [
            { id: 1, description: "First step of task", criteria: "step 1 complete", status: "pending" },
            { id: 2, description: "Second step of task", criteria: "step 2 complete", status: "pending" },
            { id: 3, description: "Final step of task", criteria: "task complete", status: "pending" }
        ];
    }
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

// User Info
app.get('/api/user', requireLogin, (req, res) => {
    res.json({ success: true, user: req.session.user });
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

// Get current
// server.js (continued)

//api assign
app.post('/api/assign', requireLogin, async (req, res) => {
    const { taskId } = req.body;
    const senderId = req.session.user.id;

    if (!taskId) {
        return res.status(400).json({ success: false, message: 'Missing task ID' });
    }
    
    try {
        // First check if the task exists and its current status
        const checkResult = await db.query(
            'SELECT status FROM tasks WHERE id = $1',
            [taskId]
        );
        
        if (checkResult.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Task not found' });
        }
        
        const currentStatus = checkResult.rows[0].status;
        if (currentStatus !== 'open') {
            return res.status(400).json({ 
                success: false, 
                message: `Cannot assign task with status "${currentStatus}". Task must be "open".` 
            });
        }
        
        // Proceed with assignment
        const { rows } = await db.query(
            `UPDATE tasks
            SET sender_id = $1, status = 'doing task'
            WHERE id = $2 AND status = 'open'
            RETURNING *`,
            [senderId, taskId]
        );
        
        const task = rows[0];
        io.emit('taskUpdated', task);
        res.json({ success: true, task });
    } catch (err) {
        console.error('Task assignment error:', err);
        res.status(500).json({ 
            success: false, 
            message: 'Failed to assign task: ' + (err.message || 'Unknown database error') 
        });
    }
});





// Get current task for a sender
app.get('/api/current-task', requireLogin, async (req, res) => {
  const senderId = req.session.user.id;
  try {
      const { rows } = await db.query(
          `SELECT * FROM tasks
          WHERE sender_id = $1 AND status = 'doing task'
          LIMIT 1`,
          [senderId]
      );
      if (rows.length === 0) {
          return res.json({ success: false, message: 'No current task' });
      }
      res.json({ success: true, task: rows[0] });
  } catch (err) {
      console.error(err);
      res.status(500).json({ success: false, message: err.message });
  }
});

// Get subtasks for a specific task
app.get('/api/subtasks/:taskId', requireLogin, async (req, res) => {
  const { taskId } = req.params;
  try {
      // First check if subtasks exist
      const { rows: existingSubtasks } = await db.query(
          `SELECT id, description, criteria, status
          FROM subtasks
          WHERE task_id = $1
          ORDER BY id`,
          [taskId]
      );
      
      // If subtasks already exist, return them
      if (existingSubtasks.length > 0) {
          return res.json({ success: true, subtasks: existingSubtasks });
      }
      
      // If no subtasks exist, get task description to generate them
      const { rows: taskRows } = await db.query(
          `SELECT description FROM tasks WHERE id = $1`,
          [taskId]
      );
      
      if (taskRows.length === 0) {
          return res.status(404).json({ success: false, message: 'Task not found' });
      }
      
      // Generate subtasks using the task description
      const taskDescription = taskRows[0].description;
      const subtasks = await generateSubtasks(taskDescription);
      
      // Insert the generated subtasks into the database
      const insertText = `
          INSERT INTO subtasks
          (task_id, id, description, criteria, status)
          VALUES ($1, $2, $3, $4, $5)
      `;
      
      for (const sub of subtasks) {
          await db.query(insertText, [
              taskId,
              sub.id,
              sub.description,
              sub.criteria,
              sub.status
          ]);
      }
      
      io.emit('subtasksGenerated', { taskId, subtasks });
      res.json({ success: true, subtasks });
  } catch (err) {
      console.error(err);
      res.status(500).json({ success: false, message: err.message });
  }
});

// Get status of a specific subtask
app.get('/api/subtask-status/:taskId/:subtaskId', requireLogin, async (req, res) => {
  const { taskId, subtaskId } = req.params;
  try {
      const { rows } = await db.query(
          `SELECT status FROM subtasks
          WHERE task_id = $1 AND id = $2`,
          [taskId, subtaskId]
      );
      
      if (rows.length === 0) {
          return res.status(404).json({ success: false, message: 'Subtask not found' });
      }
      
      res.json({ success: true, status: rows[0].status });
  } catch (err) {
      console.error(err);
      res.status(500).json({ success: false, message: err.message });
  }
});

// Upload result for a subtask
app.post('/api/upload', async (req, res) => {
  const { senderId, taskId, subtaskId, result } = req.body;
  if (!senderId || !taskId || !subtaskId || !result) {
      return res.status(400).json({ success: false, message: 'Missing fields' });
  }
  
  const client = await db.connect();
  try {
      await client.query('BEGIN');
      
      // Insert upload record
      await client.query(
          `INSERT INTO uploads
          (sender_id, task_id, subtask_id, result)
          VALUES ($1, $2, $3, $4)`,
          [senderId, taskId, subtaskId, result]
      );
      
      // Update subtask status
      await client.query(
          `UPDATE subtasks
          SET status = $1
          WHERE task_id = $2 AND id = $3`,
          [result === 'pass' ? 'passed' : 'failed', taskId, subtaskId]
      );
      
      // Check if all subtasks are passed
      const { rows } = await client.query(
          `SELECT COUNT(*) FILTER (WHERE status != 'passed') AS not_passed
          FROM subtasks WHERE task_id = $1`,
          [taskId]
      );
      
      // If all subtasks are passed, update task status
      if (Number(rows[0].not_passed) === 0) {
          await client.query(
              `UPDATE tasks SET status='completed' WHERE id=$1`,
              [taskId]
          );
          io.emit('taskUpdated', { id: taskId, status: 'completed' });
      }
      
      await client.query('COMMIT');
      
      // Emit event for real-time updates
      io.emit('subtaskUpdated', {
          taskId,
          subtaskId,
          status: result === 'pass' ? 'passed' : 'failed'
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
