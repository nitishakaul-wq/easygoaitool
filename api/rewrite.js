export default async function handler(req, res) {

if (req.method !== "POST") {
return res.status(405).json({ error: "Method not allowed" });
}

try {

const { message, tone } = req.body;

if (!message) {
return res.status(400).json({ error: "Message missing" });
}

const aiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
method: "POST",
headers: {
"Content-Type": "application/json",
Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
},
body: JSON.stringify({
model: "gpt-4o-mini",
messages: [
{
role: "system",
content: "You rewrite messages to be polite, clear and professional."
},
{
role: "user",
content: `Rewrite this message in a ${tone} tone: ${message}`
}
]
})
});

const data = await aiResponse.json();

const result = data.choices?.[0]?.message?.content;

if (!result) {
return res.status(500).json({ error: "AI returned empty result" });
}

res.status(200).json({
result: result
});

} catch (error) {

res.status(500).json({
error: "Server error"
});

}

}
