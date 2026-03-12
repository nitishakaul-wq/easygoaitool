export default async function handler(req, res) {

if(req.method !== "POST"){
return res.status(405).json({error:"Method not allowed"});
}

try{

const { jd, resume } = req.body;

if(!jd || !resume){
return res.status(400).json({error:"Missing JD or resume"});
}

const prompt = `
You are an ATS resume optimizer.

Job Description:
${jd}

Current Resume:
${resume}

Tasks:
1. Rewrite the resume to be ATS optimized.
2. Include keywords from the job description.
3. Generate a professional cover letter.
4. Give an ATS match score from 0-100.
5. Suggest improvements.

Format response clearly in sections:
ATS SCORE
OPTIMIZED RESUME
COVER LETTER
SUGGESTIONS
`;

const response = await fetch(
"https://api.groq.com/openai/v1/chat/completions",
{
method:"POST",
headers:{
"Content-Type":"application/json",
"Authorization":`Bearer ${process.env.GROQ_API_KEY}`
},
body:JSON.stringify({
model:"llama-3.3-70b-versatile",
messages:[
{
role:"user",
content:prompt
}
]
})
}
);

const data = await response.json();

const result = data?.choices?.[0]?.message?.content;

res.status(200).json({
result:result || "No result generated"
});

}catch(error){

console.error(error);

res.status(500).json({
error:"Server error"
});

}

}
