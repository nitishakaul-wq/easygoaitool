export async function handler(event) {

const data = JSON.parse(event.body);

const message = data.message;
const tone = data.tone;

const apiKey = process.env.OPENAI_API_KEY;

const response = await fetch("https://api.openai.com/v1/chat/completions", {

method: "POST",

headers: {
"Content-Type": "application/json",
"Authorization": "Bearer " + apiKey
},

body: JSON.stringify({

model: "gpt-4o-mini",

messages: [
{
role: "system",
content: "Rewrite messages clearly in the requested tone."
},
{
role: "user",
content: `Rewrite this message in a ${tone} tone: ${message}`
}
]

})

});

const result = await response.json();

return {

statusCode: 200,

body: JSON.stringify({
reply: result.choices[0].message.content
})

};

}
