export default async function handler(req, res) {

if (req.method !== "POST") {
return res.status(405).json({ error: "Method not allowed" });
}

try {

const { message } = req.body;

if (!message) {
return res.status(400).json({ error: "No text provided" });
}

const response = await fetch(
"https://api.groq.com/openai/v1/chat/completions",
{
method: "POST",
headers: {
"Content-Type": "application/json",
"Authorization": `Bearer ${process.env.GROQ_API_KEY}`
},
body: JSON.stringify({
model: "llama-3.3-70b-versatile",
messages: [
{
role: "system",
content:
"You explain technical screenshots or error messages in simple language."
},
{
role: "user",
content: `Explain this screenshot or error message clearly: ${message}`
}
]
})
}
);

const data = await response.json();

const result = data?.choices?.[0]?.message?.content;

return res.status(200).json({
result: result || "No explanation returned"
});

} catch (error) {

console.error(error);

return res.status(500).json({
error: "Server error"
});

}

}
