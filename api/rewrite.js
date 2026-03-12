export default async function handler(req, res) {

const { message, tone } = req.body;

const response = await fetch("https://api.openai.com/v1/chat/completions", {
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
content: "Rewrite messages politely and clearly."
},
{
role: "user",
content: `Rewrite this message in a ${tone} tone: ${message}`
}
]
})
});

const data = await response.json();

res.status(200).json({
result: data.choices[0].message.content
});

}
