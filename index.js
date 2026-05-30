require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cors = require("cors");
const admin = require("firebase-admin");

// =====================================================
// FIREBASE INITIALIZATION
// =====================================================
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

// =====================================================
// GEMINI API KEY ROTATOR
// =====================================================
const API_KEYS = [
    process.env.GEMINI_API_KEY_1,
    process.env.GEMINI_API_KEY_2,
    process.env.GEMINI_API_KEY_3,
    process.env.GEMINI_API_KEY_4,
    process.env.GEMINI_API_KEY_5,
    process.env.GEMINI_API_KEY_6,
    process.env.GEMINI_API_KEY_7,
    process.env.GEMINI_API_KEY_8
].filter(Boolean);

let keyIndex = 0;

function getNextKey() {
    if (!API_KEYS.length) {
        throw new Error("No Gemini API Keys Found");
    }

    const key = API_KEYS[keyIndex];
    keyIndex = (keyIndex + 1) % API_KEYS.length;

    return key;
}

async function callGemini(contents) {
    let lastError;

    for (let i = 0; i < API_KEYS.length; i++) {
        const key = getNextKey();

        try {
            const response = await axios.post(
                `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`,
                { contents },
                {
                    timeout: 45000,
                    headers: {
                        "Content-Type": "application/json"
                    }
                }
            );

            const text =
                response.data?.candidates?.[0]?.content?.parts?.[0]?.text;

            if (text) {
                return text.trim();
            }
        } catch (err) {
            console.error(`Gemini key failed: ${key.slice(0, 8)}...`);
            lastError = err;
        }
    }

    throw new Error(
        lastError?.response?.data?.error?.message ||
        lastError?.message ||
        "Gemini request failed"
    );
}

// =====================================================
// OPTIONAL AUTH MIDDLEWARE
// =====================================================
// Guests are allowed.
// Logged-in users get memory.
const optionalAuth = async (req, res, next) => {
    req.user = null;

    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return next();
    }

    try {
        const token = authHeader.split("Bearer ")[1];

        const decoded = await admin
            .auth()
            .verifyIdToken(token);

        req.user = decoded;
    } catch (err) {
        console.log("Invalid token. Continuing as guest.");
        req.user = null;
    }

    next();
};

// =====================================================
// HEALTH CHECK
// =====================================================
app.get("/", (req, res) => {
    res.json({
        status: "online",
        service: "JARVIS CORE",
        mode: "Guest + Auth Users Supported"
    });
});

// =====================================================
// CHAT ROUTE
// =====================================================
app.post("/chat", optionalAuth, async (req, res) => {
    try {
        const prompt = req.body?.prompt;

        if (!prompt || !prompt.trim()) {
            return res.status(400).json({
                error: "Prompt is required"
            });
        }

        // ============================================
        // GUEST MODE
        // ============================================
        if (!req.user) {
            const reply = await callGemini([
                {
                    role: "user",
                    parts: [
                        {
                            text: prompt
                        }
                    ]
                }
            ]);

            return res.json({
                reply,
                guest: true,
                memory: false
            });
        }

        // ============================================
        // AUTHENTICATED USER MODE
        // ============================================
        const uid = req.user.uid;

        const chatRef = db
            .collection("users")
            .doc(uid)
            .collection("history");

        const snapshot = await chatRef
            .orderBy("timestamp", "asc")
            .limitToLast(10)
            .get();

        const history = [];

        snapshot.forEach(doc => {
            const data = doc.data();

            if (data.content) {
                history.push(data.content);
            }
        });

        history.push({
            role: "user",
            parts: [
                {
                    text: prompt
                }
            ]
        });

        const reply = await callGemini(history);

        await chatRef.add({
            content: {
                role: "user",
                parts: [
                    {
                        text: prompt
                    }
                ]
            },
            timestamp: admin.firestore.FieldValue.serverTimestamp()
        });

        await chatRef.add({
            content: {
                role: "model",
                parts: [
                    {
                        text: reply
                    }
                ]
            },
            timestamp: admin.firestore.FieldValue.serverTimestamp()
        });

        return res.json({
            reply,
            guest: false,
            memory: true,
            uid
        });

    } catch (err) {
        console.error("CHAT ERROR:", err);

        return res.status(500).json({
            error: "AI Processing Failed",
            details:
                process.env.NODE_ENV === "development"
                    ? err.message
                    : undefined
        });
    }
});

// =====================================================
// START SERVER
// =====================================================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`🚀 JARVIS CORE running on port ${PORT}`);
});
