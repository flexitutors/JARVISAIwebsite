require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cors = require("cors");
const admin = require("firebase-admin");

// =====================================================
// FIREBASE INITIALIZATION
// =====================================================
// Ensure FIREBASE_SERVICE_ACCOUNT is set in Render as a stringified JSON
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

const app = express();
app.use(cors());
app.use(express.json());

// =====================================================
// GEMINI API KEY ROTATOR
// =====================================================
const API_KEYS = [
    process.env.GEMINI_API_KEY_1, process.env.GEMINI_API_KEY_2,
    process.env.GEMINI_API_KEY_3, process.env.GEMINI_API_KEY_4,
    process.env.GEMINI_API_KEY_5, process.env.GEMINI_API_KEY_6,
    process.env.GEMINI_API_KEY_7, process.env.GEMINI_API_KEY_8
].filter(Boolean);

let keyIndex = 0;
const getNextKey = () => {
    if (!API_KEYS.length) throw new Error("No Gemini API Keys Found");
    const key = API_KEYS[keyIndex];
    keyIndex = (keyIndex + 1) % API_KEYS.length;
    return key;
};

async function callGemini(contents) {
    let lastError;
    for (let i = 0; i < API_KEYS.length; i++) {
        const key = getNextKey();
        try {
            const response = await axios.post(
                `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`,
                { contents },
                { timeout: 45000, headers: { "Content-Type": "application/json" } }
            );
            const text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
            if (text) return text.trim();
        } catch (err) {
            lastError = err;
        }
    }
    throw new Error(lastError?.message || "Gemini request failed");
}

// =====================================================
// AUTH MIDDLEWARE
// =====================================================
const authenticateUser = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return res.status(401).json({ error: "Unauthorized" });
    }
    const token = authHeader.split("Bearer ")[1];
    try {
        req.user = await admin.auth().verifyIdToken(token);
        next();
    } catch (e) {
        res.status(401).json({ error: "Invalid token" });
    }
};

// =====================================================
// CHAT ROUTE (Memory + Firebase)
// =====================================================
app.post("/chat", authenticateUser, async (req, res) => {
    const { prompt } = req.body;
    const uid = req.user.uid;
    const chatRef = db.collection("users").doc(uid).collection("history");

    try {
        // 1. Get last 10 messages from Firestore
        const snapshot = await chatRef.orderBy("timestamp", "asc").limitToLast(10).get();
        const history = snapshot.docs.map(doc => doc.data().content);

        // 2. Add current message
        history.push({ role: "user", parts: [{ text: prompt }] });

        // 3. Generate response
        const result = await callGemini(history);

        // 4. Save both to Firestore
        await chatRef.add({ content: { role: "user", parts: [{ text: prompt }] }, timestamp: new Date() });
        await chatRef.add({ content: { role: "model", parts: [{ text: result }] }, timestamp: new Date() });

        res.json({ reply: result });
    } catch (err) {
        res.status(500).json({ error: "AI Processing failed" });
    }
});

app.listen(process.env.PORT || 3000, () => console.log("🚀 Jarvis Web Core running"));
