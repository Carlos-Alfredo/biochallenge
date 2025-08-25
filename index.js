import { onRequest } from "firebase-functions/v2/https";
import * as admin from "firebase-admin";
import axios from "axios";
import crypto from "crypto";
import { VertexAI } from "@google-cloud/vertexai";

admin.initializeApp(); // uses default service account
const db = admin.firestore();

// Read secrets from environment (set in step 5)
const {
  WHATSAPP_TOKEN,
  WHATSAPP_PHONE_ID,
  VERIFY_TOKEN,
  VERTEX_LOCATION = "us-central1",
  GEMINI_MODEL = "gemini-2.5-flash",
} = process.env;

// Enable Vertex AI on this project and grant aiplatform.user to the Functions SA
const vertex = new VertexAI({
  project: process.env.GCLOUD_PROJECT,
  location: VERTEX_LOCATION,
});
const model = vertex.getGenerativeModel({ model: GEMINI_MODEL });

export const webhook = onRequest({ region: "us-central1" }, async (req, res) => {
  // 1) Verification (GET)
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.sendStatus(403);
  }

  // 2) POST: (optional) validate signature for security
  const sig = req.get("x-hub-signature-256");
  const appSecret = process.env.APP_SECRET; // optional: set if you want signature check
  if (sig && appSecret) {
    const expected = "sha256=" + crypto.createHmac("sha256", appSecret).update(req.rawBody).digest("hex");
    if (expected !== sig) return res.sendStatus(401);
  }

  try {
    const msg = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!msg) return res.sendStatus(200);

    const from = msg.from;                  // user phone (E.164)
    const text = msg.text?.body?.trim() ?? "";

    // Firestore: persist short history
    const userRef = db.collection("whatsapp_users").doc(from);
    const snap = await userRef.get();
    const userData = snap.exists ? snap.data() : {};
    const nowIso = new Date().toISOString();

    await userRef.set({
      lastMessageAt: nowIso,
      lastText: text,
      history: admin.firestore.FieldValue.arrayUnion({ at: nowIso, user: text }),
    }, { merge: true });

    // Gemini: generate a reply
    const prompt = `Você é um assistente de rotina médica. Histórico curto: ${JSON.stringify(userData).slice(0, 800)}.
Pergunta do usuário: ${text}
Responda em PT-BR, breve e útil.`;

    const gen = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: prompt }] }]
    });
    const aiText = gen?.response?.candidates?.[0]?.content?.parts?.[0]?.text
      || "Não consegui gerar uma resposta agora.";

    // Save bot reply
    await userRef.set({
      history: admin.firestore.FieldValue.arrayUnion({ at: nowIso, bot: aiText })
    }, { merge: true });

    // WhatsApp: send the reply
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
    console.error("Webhook error:", e?.response?.data || e);
    return res.sendStatus(200);
  }
});
