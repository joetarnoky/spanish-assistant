// pages/api/turn.ts
import type { NextApiRequest, NextApiResponse } from "next";
import OpenAI from "openai";
import formidable, { File } from "formidable";
import { toFile } from "openai/uploads";
import fs from "fs";
import { Readable } from "stream";

export const config = {
  api: { bodyParser: false }, // needed for multipart/form-data
};

const SYSTEM_PROMPT = `
You are a warm Spanish conversation partner and coach.
Always reply in Spanish. Keep responses to 1–3 sentences.
When there’s a clear mistake, first write “Corrección:” with a short fix,
then give a natural reply. Ask a brief follow-up question each turn.
Use Latin American Spanish consistently.
`;

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function parseForm(req: NextApiRequest): Promise<{ filePath: string }> {
  const form = formidable({ multiples: false });
  return new Promise((resolve, reject) => {
    form.parse(req, (err, _fields, files) => {
      if (err) return reject(err);
      const anyFile =
        (files.audio as formidable.File) ||
        (Object.values(files)[0] as formidable.File);
      if (!anyFile?.filepath) return reject(new Error("No audio file uploaded"));
      resolve({ filePath: anyFile.filepath });
    });
  });
}

function fileStream(path: string) {
  return fs.createReadStream(path);
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const { filePath } = await parseForm(req);

    // 1) STT
    // const stt = await client.audio.transcriptions.create({
    //   file: fileStream(filePath) as unknown as Readable,
    //   model: "gpt-4o-mini-transcribe", // or "whisper-1"
    //   // language: "es", // optional hint
    // });

    const stt = await client.audio.transcriptions.create({
      file: await toFile(fs.createReadStream(filePath), "audio.m4a"),
      model: "whisper-1", // or "gpt-4o-mini-transcribe"
    });

    const userText = (stt as any).text ?? "";

    // 2) Chat
    const chat = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userText },
      ],
      temperature: 0.7,
    });
    const reply = chat.choices[0]?.message?.content || "¿Puedes repetir, por favor?";

    // 3) TTS
    const speech = await client.audio.speech.create({
      model: "tts-1",
      voice: "alloy",
      input: reply,
    });

    const audioBuf = Buffer.from(await speech.arrayBuffer());
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      audioBase64: audioBuf.toString("base64"),
      // (optional) echo these if you want to display them in the UI later:
      // transcript: userText,
      // replyText: reply,
    });
  } catch (e: any) {
    console.error(e);
    return res.status(500).json({ error: e?.message ?? "Internal error" });
  }
}
