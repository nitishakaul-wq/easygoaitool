export default async function handler(req, res) {

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {

    const { message, tone } = req.body;

    if (!message) {
      return res.status(400).json({ error: "Message missing" });
    }

    const aiResponse = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        input: `Rewrite this message in a ${tone} tone: ${message}`
      })
    });

    const data = await aiResponse.json();

    const result = data.output?.[0]?.content?.[0]?.text;

    if (!result) {
      console.log("OpenAI response:", data);
      return res.status(500).json({ error: "AI returned empty result" });
    }

    res.status(200).json({ result });

  } catch (error) {

    console.error(error);

    res.status(500).json({ error: "Server error contacting AI" });

  }

}
