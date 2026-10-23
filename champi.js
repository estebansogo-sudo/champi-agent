global.Headers = require("node-fetch").Headers;
global.fetch = require("node-fetch");
global.WebSocket = require("ws");
const TelegramBot = require("node-telegram-bot-api");
const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();
const express = require("express");

const app = express();
app.use(express.json());

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN);
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { realtime: { enabled: false } }
);

const PORT = process.env.PORT || 3000;
const WEBHOOK_URL = process.env.RENDER_EXTERNAL_URL 
  ? `${process.env.RENDER_EXTERNAL_URL}/webhook`
  : `https://TU-SERVICIO.onrender.com/webhook`; // cámbialo después

console.log("Champi está arrancando en modo webhook...");

// Configurar webhook
bot.setWebHook(WEBHOOK_URL);

// Endpoint del webhook
app.post("/webhook", (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

app.get("/", (req, res) => {
  res.send("Champi está activo");
});

app.listen(PORT, () => {
  console.log(`Servidor escuchando en puerto ${PORT}`);
});

// ==================== HERRAMIENTAS ====================

async function getCiclosAbiertos() {
  const { data, error } = await supabase
    .from("ciclos")
    .select("id, sala_id, fecha_inicio, toneladas_compost, coste_compost, kg_primera, kg_segunda, kg_total, estado")
    .eq("estado", "abierto")
    .order("sala_id");
  if (error) return { error: error.message };
  return { ciclos_abiertos: data || [] };
}

async function getSalaStatus(salaId) {
  const { data, error } = await supabase
    .from("ciclos")
    .select("*")
    .eq("sala_id", salaId)
    .eq("estado", "abierto")
    .maybeSingle();
  if (error) return { error: error.message };
  if (!data) return { mensaje: `La sala ${salaId} no tiene ciclo abierto.` };
  return { sala_id: salaId, ciclo: data };
}

async function createTask(salaId, title, description = "", priority = "medium") {
  const { data, error } = await supabase
    .from("agent_tasks")
    .insert({
      sala_id: salaId || null,
      title,
      description: description || null,
      priority,
      status: "pending",
      created_by: "champi"
    })
    .select()
    .single();
  if (error) return { error: error.message };
  return { tarea_creada: data };
}

async function saveLearning(content, salaId = null) {
  const { error } = await supabase
    .from("agent_memory")
    .insert({ content, type: "learning", sala_id: salaId });
  if (error) return { error: error.message };
  return { aprendizaje_guardado: true };
}

// ==================== GROQ ====================

async function callGroq(messages) {
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "qwen/qwen3.8-27b",
      messages,
      temperature: 0.3,
      max_tokens: 1024
    })
  });
  const data = await response.json();
  return data.choices?.[0]?.message?.content || "No he podido generar una respuesta.";
}

// ==================== LÓGICA DEL BOT ====================

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text?.trim() || "";
  const userName = msg.from?.first_name || "Usuario";

  if (!text) return;

  console.log(`[${userName}] ${text}`);

  const systemPrompt = `Eres Champi, el agente experto en cultivo de champiñones de Soriano Cultivos.
Gestionas 27 salas. Hablas en español de España, de forma clara, profesional y proactiva.
El usuario se llama ${userName}.

Puedes usar herramientas para consultar datos reales. Cuando necesites datos, responde SOLO con una de estas acciones en formato JSON:
{"action": "get_ciclos_abiertos"}
{"action": "get_sala_status", "sala_id": 5}
{"action": "create_task", "sala_id": 3, "title": "revisar humedad"}
{"action": "save_learning", "content": "texto a recordar"}

Si no necesitas datos, responde normalmente.`;

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: text }
  ];

  let reply = await callGroq(messages);

  try {
    const action = JSON.parse(reply);
    if (action.action) {
      let result;
      if (action.action === "get_ciclos_abiertos") result = await getCiclosAbiertos();
      else if (action.action === "get_sala_status") result = await getSalaStatus(action.sala_id);
      else if (action.action === "create_task") result = await createTask(action.sala_id, action.title, action.description);
      else if (action.action === "save_learning") result = await saveLearning(action.content, action.sala_id);

      messages.push({ role: "assistant", content: reply });
      messages.push({ role: "user", content: `Resultado de la herramienta: ${JSON.stringify(result)}` });
      reply = await callGroq(messages);
    }
  } catch (e) {}

  bot.sendMessage(chatId, reply);
});
