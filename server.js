const express = require('express');
const bodyParser = require('body-parser');
const http = require('http');
const socketIo = require('socket.io');
const Groq = require('groq-sdk');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Initialize the Groq SDK instance.
const groq = new Groq({ apiKey: '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'});

const PORT = process.env.PORT || 3000;

// Use body-parser with an increased JSON payload limit.
app.use(bodyParser.json({ limit: '10mb' }));

// Serve static files from the "public" directory.
app.use(express.static('public'));

// In-memory storage for tasks.
let tasks = [];
let nextTaskId = 1;

// Existing ML processing stub for OCR data.
function processML(ocrData) {
  console.log("Processing ML on OCR data:", ocrData);
  // For now, return "pass" as a dummy result.
  return "pass";
}

/**
 * generateSubtasks
 * Uses Groq's SDK to generate subtasks for a given task description.
 * The prompt is split into two parts: a system message that tells the assistant what to do,
 * and a user message that provides the task description.
 * The output is expected to be a JSON object containing a "subtasks" array.
 *
 * This version will strip out any extra "thinking" text and only parse the JSON.
 *
 * @param {string} taskDescription - The task description provided by the user.
 * @returns {Promise<Object>} - A promise that resolves to the generated JSON object.
 */
async function generateSubtasks(taskDescription) {
  const messages = [
    {
      role: "system",
      content: `You are an AI task‑decomposer.  
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
    {
      role: "user",
      content: taskDescription
    }
  ];

  // Create a chat completion request that streams the result.
  const chatCompletion = await groq.chat.completions.create({
    messages,
    model: "qwen-qwq-32b",
    temperature: 0.6,
    max_completion_tokens: 4096,
    top_p: 0.95,
    stream: true
  });

  let fullResult = "";
  // Stream the response.
  for await (const chunk of chatCompletion) {
    const content = chunk.choices[0]?.delta?.content || "";
    process.stdout.write(content);
    fullResult += content;
  }
  console.log("\n\nComplete response received.");

  // Strip out anything before the first '{' and after the last '}' to isolate the JSON.
  const firstBrace = fullResult.indexOf('{');
  const lastBrace = fullResult.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1) {
    throw new Error('Failed to extract JSON from model response');
  }
  const jsonString = fullResult.slice(firstBrace, lastBrace + 1);

  // Parse and return.
  return JSON.parse(jsonString);
}

// ------------------------------------------------
// Endpoints

// Endpoint for receiver to create a new task.
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
    status: "open" // open, assigned, doing task, passed, failed.
  };
  tasks.push(task);
  io.emit('taskCreated', task);
  return res.json({ success: true, task });
});

// Endpoint to list available tasks.
app.get('/api/tasks', (req, res) => {
  const availableTasks = tasks.filter(task => task.status === "open" || task.status === "doing task");
  return res.json({ success: true, tasks: availableTasks });
});

// Endpoint for a sender to assign a task.
app.post('/api/assign', (req, res) => {
  const { taskId, senderId } = req.body;
  const task = tasks.find(t => t.taskId == taskId);
  if (!task) {
    return res.status(404).json({ success: false, message: "Task not found" });
  }
  task.senderId = senderId;
  task.status = "doing task";
  io.emit('taskUpdated', task);
  return res.json({ success: true, task });
});

// Endpoint where the sender's background process uploads OCR data.
app.post('/api/upload', (req, res) => {
  const { senderId, taskId, timestamp, data } = req.body;
  if (!senderId || !taskId || !data || data.length === 0) {
    return res.status(400).json({ success: false, message: "Invalid payload" });
  }

  const task = tasks.find(t => t.taskId == taskId && t.senderId === senderId);
  if (!task) {
    return res.status(404).json({ success: false, message: "Assigned task not found" });
  }

  console.log(`Received OCR data for task ${taskId} from sender ${senderId} at ${timestamp}`);
  const mlResult = processML(data);

  if (mlResult === "pass") {
    task.status = "passed";
    io.emit('taskUpdated', task);
  }
  return res.json({ success: true, mlResult, task });
});

// NEW: Endpoint to generate subtasks for a given task description.
app.post('/api/generateSubtasks', async (req, res) => {
  const { taskDescription } = req.body;
  if (!taskDescription) {
    return res.status(400).json({ success: false, message: "Task description is required." });
  }

  try {
    const result = await generateSubtasks(taskDescription);
    console.log("Generated subtasks:", result.subtasks);
    return res.json({ success: true, subtasks: result.subtasks });
  } catch (error) {
    console.error("Error generating subtasks:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

// ------------------------------------------------
// Start the Server & Set up Socket.io for real-time updates.

server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

io.on('connection', (socket) => {
  console.log('A client connected:', socket.id);
  socket.on('disconnect', () => {
    console.log('A client disconnected:', socket.id);
  });
});