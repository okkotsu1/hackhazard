const express = require('express');
const bodyParser = require('body-parser');
const http = require('http');
const socketIo = require('socket.io');
const Groq = require('groq-sdk');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Initialize the Groq SDK with your API key
const groq = new Groq({ apiKey: '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' });

const PORT = process.env.PORT || 3000;

// Increase JSON payload limit
app.use(bodyParser.json({ limit: '10mb' }));

// Serve static assets
app.use(express.static('public'));

// In‑memory storage
let tasks = [];
let nextTaskId = 1;

// Stub ML processor
function processML(ocrData) {
  console.log("Processing ML on OCR data:", ocrData);
  // Replace with real logic; returns "pass" or "fail"
  return "pass";
}

/**
 * generateSubtasks: calls Groq to break a high‑level task into three subtasks,
 * each with id, description, and OCR-based criteria.
 */
async function generateSubtasks(taskDescription) {
  const messages = [
    {
      role: "system",
      content: `You are an AI task‑decomposer. Given a single high‑level task, break it into exactly three sequential subtasks.
Output JSON exactly in this format:
{
  "subtasks": [
    { "id": 1, "description": "…", "criteria": "…" },
    { "id": 2, "description": "…", "criteria": "…" },
    { "id": 3, "description": "…", "criteria": "…" }
  ]
}`
    },
    { role: "user", content: taskDescription }
  ];

  const chatCompletion = await groq.chat.completions.create({
    messages,
    model: "qwen-qwq-32b",
    temperature: 0.6,
    max_completion_tokens: 4096,
    top_p: 0.95,
    stream: true
  });

  let full = "";
  for await (const chunk of chatCompletion) {
    const c = chunk.choices[0]?.delta?.content || "";
    process.stdout.write(c);
    full += c;
  }
  console.log("\n\nGroq response complete.");

  // Extract JSON blob
  const start = full.indexOf('{'), end = full.lastIndexOf('}');
  if (start < 0 || end < 0) throw new Error("Invalid JSON from model");
  return JSON.parse(full.slice(start, end + 1));
}

// ------------------ Endpoints ------------------

// 1) Create a new task
app.post('/api/task', (req, res) => {
  const { description, payment, receiverId } = req.body;
  if (!description || !payment || !receiverId) {
    return res.status(400).json({ success: false, message: "Missing parameters." });
  }
  const task = {
    taskId: nextTaskId++,
    description,
    payment,
    receiverId,
    senderId: null,
    status: "open",     // overall status
    subtasks: []        // will hold generated subtasks
  };
  tasks.push(task);
  io.emit('taskCreated', task);
  res.json({ success: true, task });
});

// 2) List available tasks
app.get('/api/tasks', (req, res) => {
  const avail = tasks.filter(t => t.status === "open" || t.status === "doing task");
  res.json({ success: true, tasks: avail });
});

// 3) Assign a task to a sender
app.post('/api/assign', (req, res) => {
  const { taskId, senderId } = req.body;
  const task = tasks.find(t => t.taskId == taskId);
  if (!task) return res.status(404).json({ success: false, message: "Task not found" });
  task.senderId = senderId;
  task.status = "doing task";
  io.emit('taskUpdated', task);
  res.json({ success: true, task });
});

// 4) Generate & store subtasks for a task
app.post('/api/generateSubtasks', async (req, res) => {
  const { taskDescription } = req.body;
  if (!taskDescription) {
    return res.status(400).json({ success: false, message: "taskDescription is required." });
  }
  try {
    const { subtasks } = await generateSubtasks(taskDescription);
    console.log(`Generated subtasks for description "${taskDescription}":`, subtasks);
    res.json({ success: true, subtasks });
  } catch (err) {
    console.error("Error generating subtasks:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// 5) Upload OCR data for a specific subtask
app.post('/api/upload', (req, res) => {
  const { senderId, taskId, subtaskId, timestamp, data } = req.body;
  if (!senderId || !taskId || !subtaskId || !data?.length) {
    return res.status(400).json({ success: false, message: "Missing parameters." });
  }
  const task = tasks.find(t => t.taskId == taskId && t.senderId === senderId);
  if (!task) return res.status(404).json({ success: false, message: "Assigned task not found." });

  const sub = task.subtasks.find(s => s.id === subtaskId);
  if (!sub) return res.status(404).json({ success: false, message: "Subtask not found." });

  console.log(`OCR upload for Task ${taskId}, Subtask ${subtaskId} at ${timestamp}`);
  const result = processML(data);

  if (result === "pass") {
    sub.status = "passed";
    io.emit('subtaskUpdated', { taskId, subtaskId, status: "passed" });
  } else {
    io.emit('subtaskUpdated', { taskId, subtaskId, status: sub.status });
  }

  // If all subtasks passed, mark overall task passed
  if (task.subtasks.every(s => s.status === "passed")) {
    task.status = "passed";
    io.emit('taskUpdated', task);
  }

  res.json({ success: true, subtask: sub });
});

// ------------------ Start ------------------

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

io.on('connection', socket => {
  console.log('Client connected:', socket.id);
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});