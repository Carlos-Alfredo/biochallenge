import { onRequest } from "firebase-functions/v2/https";
import * as admin from "firebase-admin";
import corsLib from "cors";
import { VertexAI } from "@google-cloud/vertexai";

admin.initializeApp();
const db = admin.firestore();

const { VERTEX_LOCATION = "us-central1", GEMINI_MODEL = "gemini-2.5-flash" } = process.env;
const cors = corsLib({ origin: true });

const vertex = new VertexAI({ project: process.env.GCLOUD_PROJECT, location: VERTEX_LOCATION });
const model = vertex.getGenerativeModel({ model: GEMINI_MODEL });

export const chat = onRequest({ region: "us-central1" }, async (req, res) => {
  await new Promise((resolve)=>cors(req,res,resolve));
  if (req.method === "OPTIONS") return res.sendStatus(204);
  if (req.method !== "POST") return res.status(405).send("Use POST");

  try {
    const { uid, chatId, messages } = req.body || {};
    if (!uid || !Array.isArray(messages)) return res.status(400).json({ error: "uid e messages são obrigatórios" });

    // limita histórico e sanitiza
    const trimmed = messages.slice(-12).map(m => ({ role: m.role, content: String(m.content||"").slice(0,4000) }));
    const contents = trimmed.map(m => ({ role: m.role === "model" ? "model" : "user", parts: [{ text: m.content }] }));

    const gen = await model.generateContent({ contents });
    const reply = gen?.response?.candidates?.[0]?.content?.parts?.[0]?.text || "Desculpe, não consegui responder agora.";

    const now = new Date().toISOString();
    const convRef = db.collection("users").doc(uid).collection("chats").doc(chatId || "default");
    await convRef.set({ updatedAt: now }, { merge: true });
    await convRef.collection("messages").add({ at: now, role: "model", content: reply });

    return res.status(200).json({ reply });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "LLM error" });
  }
});
