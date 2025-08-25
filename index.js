import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import admin from "firebase-admin";
import { VertexAI } from "@google-cloud/vertexai";

dotenv.config();
const app = express();
app.use(express.json());

const {
  PORT = 8080,
  VERIFY_TOKEN,
  WHATSAPP_TOKEN,
  WHATSAPP_PHONE_ID,
  GOOGLE_CLOUD_PROJECT,
  VERTEX_LOCATION = "us-central1",
  GEMINI_MODEL = "gemini-2.5-flash",
} = process.env;

// Firestore (Admin SDK) — use ADC no Cloud Run; local: chave JSON se quiser
if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

// Gemini (Vertex AI)
const vertex = new VertexAI({ project: GOOGLE_CLOUD_PROJECT, location: VERTEX_LOCATION });
const model = vertex.getGenerativeModel({ model: GEMINI_MODEL });

// Health opcional
app.get("/", (_, res) => res.status(200).send("ok"));

// GET /webhook (verificação)
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

// POST /webhook (mensagens)
app.post("/webhook", async (req, res) => {
  try {
    const msg = req?.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!msg) return res.sendStatus(200);

    const from = msg.from;                         // telefone do usuário
    const text = msg.text?.body?.trim() || "";     // texto enviado

    // 1) Buscar/atualizar histórico no Firestore
    const userRef = db.collection("whatsapp_users").doc(from);
    const snap = await userRef.get();
    const userData = snap.exists ? snap.data() : {};
    const nowIso = new Date().toISOString();

    await userRef.set({
      lastMessageAt: nowIso,
      lastText: text,
      history: admin.firestore.FieldValue.arrayUnion({ at: nowIso, user: text })
    }, { merge: true });

    // 2) Montar prompt e chamar Gemini
    const prompt = `Você é um assistente de rotina médica. Histórico curto: ${JSON.stringify(userData).slice(0, 800)}.
Pergunta do usuário: ${text}
Responda em PT-BR, breve e útil.`;

    const gen = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: prompt }] }]
    });
    const aiText = gen?.response?.candidates?.[0]?.content?.parts?.[0]?.text
      || "Não consegui gerar uma resposta agora.";

    // 3) Salvar resposta no histórico
    await userRef.set({
      history: admin.firestore.FieldValue.arrayUnion({ at: nowIso, bot: aiText })
    }, { merge: true });

    // 4) Responder no WhatsApp
    await axios.post(
      `https://graph.facebook.com/v21.0/${WHATSAPP_PHONE_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to: from,
        type: "text",
        text: { body: aiText }
      },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
    );

    return res.sendStatus(200);
  } catch (e) {
    console.error("Erro no webhook:", e?.response?.data || e);
    return res.sendStatus(200); // evita retries em loop
  }
});

app.listen(PORT, "0.0.0.0", () => console.log(`OK em :${PORT}`));
