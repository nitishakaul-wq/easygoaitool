export default async function handler(req, res) {

if (req.method !== "POST") {
return res.status(405).json({ error: "Method not allowed" });
}

try {

const { message, tone } = req.body;

if (!message) {
return res.status(400).json({ error: "No message provided" });
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
model: "llama3-8b-8192",
messages: [
{
role: "system",
content: "Rewrite messages to be polite, clear, and professional."
},
{
role: "user",
content: `Rewrite this message in a ${tone} tone: ${message}`
}
]
})
}
);

const data = await response.json();

const result =
data?.choices &&
data.choices[0] &&
data.choices[0].message &&
data.choices[0].message.content;

if (!result) {
console.log("Groq response:", data);
return res.status(500).json({
error: "AI returned empty result"
});
}

return res.status(200).json({
result: result
});

} catch (err) {

console.error(err);

return res.status(500).json({
error: "Server error"
});

}

}
