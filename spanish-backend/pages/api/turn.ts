// pages/api/turn.ts
import type { NextApiRequest, NextApiResponse } from "next";
import OpenAI from "openai";
import formidable, { File } from "formidable";
import fs from "fs";
import { toFile } from "openai/uploads";

export const config = { api: { bodyParser: false } };

const SYSTEM_PROMPT = `
You are a warm Spanish conversation partner and coach.
Always reply in Spanish. Keep responses to 1–4 sentences.
When there’s a clear mistake, first write “Corrección:” with a short fix,
then give a natural reply. Ask a brief follow-up question each turn.
Use Latin American Spanish consistently. Use informal "tú" form.
Use simple vocabulary and grammar suitable for a beginner/intermediate learner.
`;

type Msg = { role: "user" | "assistant"; content: string };
type TranscriptionJSON = { text?: string };
type TurnJSON = { audioBase64: string; transcript: string; replyText: string };

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/** Coerce formidable field to a single string (or undefined). */
function fieldToString(f: undefined | string | string[]): string | undefined {
  if (typeof f === "string") return f;
  if (Array.isArray(f) && f.length > 0) return f[0];
  return undefined;
}

function parseForm(req: NextApiRequest): Promise<{ file: File; history: Msg[] }> {
  const form = formidable({ multiples: false, maxFileSize: 25 * 1024 * 1024 });
  return new Promise((resolve, reject) => {
    form.parse(req, (err, fields, files) => {
      if (err) return reject(err);

      const picked: unknown =
        (files as Record<string, unknown>)["audio"] ?? Object.values(files)[0];
      const file = picked as File;

      if (!file || !("filepath" in file) || typeof file.filepath !== "string" || file.filepath.length === 0) {
        return reject(new Error("No audio file uploaded"));
      }

      let history: Msg[] = [];
      const raw = fieldToString(fields["history" as keyof typeof fields] as unknown as string | string[] | undefined);
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as unknown;
          if (Array.isArray(parsed)) {
            history = parsed.filter((m): m is Msg => {
              if (!m || typeof m !== "object") return false;
              const o = m as Record<string, unknown>;
              return (o.role === "user" || o.role === "assistant") && typeof o.content === "string";
            });
          }
        } catch {
          // ignore malformed history
        }
      }
      if (history.length > 12) history = history.slice(-12);
      resolve({ file, history });
    });
  });
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === "GET") return res.status(200).json({ ok: true, route: "turn" });
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const { file, history } = await parseForm(req);

    // 1) STT
    const stt = (await client.audio.transcriptions.create({
      file: await toFile(
        fs.createReadStream(file.filepath),
        file.originalFilename || "audio.m4a"
      ),
      model: "gpt-4o-mini-transcribe", // or "whisper-1"
      // language: "es",
    })) as unknown as TranscriptionJSON;

    const userText: string = stt.text ?? "";

    // 2) Chat (prepend system, then history, then current user)
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: "system", content: SYSTEM_PROMPT },
      ...history.map<OpenAI.Chat.Completions.ChatCompletionMessageParam>((m) => ({
        role: m.role,
        content: m.content,
      })),
      { role: "user", content: userText },
    ];

    const chat = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
      temperature: 0.7,
      max_tokens: 200,
    });
    const reply: string =
      chat.choices[0]?.message?.content ?? "¿Puedes repetir, por favor?";

    // 3) TTS
    const speech = await client.audio.speech.create({
      model: "tts-1",
      voice: "alloy",
      input: reply,
    });
    const audioBuf = Buffer.from(await speech.arrayBuffer());

    // 4) Return audio + texts so the client can update history
    const payload: TurnJSON = {
      audioBase64: audioBuf.toString("base64"),
      transcript: userText,
      replyText: reply,
    };

    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json(payload);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(e);
    return res.status(500).json({ error: message });
  }
}
