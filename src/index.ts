import { TextMessage, WebhookEvent } from "@line/bot-sdk";
import { Hono } from "hono";

type Bindings = {
  QUEUE: Queue;
  CHANNEL_ACCESS_TOKEN: string;
  CHANNEL_SECRET: string;
  OPENAI_API_KEY: string;
  LINE_GPT_KV: KVNamespace;
};

type Role = "user" | "system" | "assistant";

type RequestBody = {
  events: WebhookEvent[];
};

type QueueData = {
  userId: string;
  content: string;
  replyToken: string;
};

type QueueMessage = {
  body: QueueData;
  timestamp: string;
  id: string;
};

type ChatGPTRequestMessage = {
  role: Role;
  content: string;
};

type ChatGPTResponse = {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  usage: {
    prompt_token: number;
    completion_token: number;
    total_tokens: number;
  };
  choices: {
    message: {
      role: "assistant";
      content: string;
    };
    finish_reason: string;
    index: number;
  }[];
};

const app = new Hono<{ Bindings: Bindings }>();

app.post("/api/webhook", async (c) => {
  const data = await c.req.json<RequestBody>();
  const event = data.events[0];
  if (event.type !== "message" || event.message.type !== "text") {
    return new Response("body error", { status: 400 });
  }
  const { source, replyToken } = event;
  if (source.type !== "user") {
    return new Response("body error", { status: 400 });
  }
  const { userId } = source;
  const { text } = event.message;
  const queueData = {
    userId,
    content: text,
    replyToken,
  };
  await c.env.QUEUE.send(queueData);
  return c.json({ message: "ok" });
});

export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch<Error>, env: Bindings): Promise<void> {
    let messages = JSON.stringify(batch.messages);
    const queueMessages = JSON.parse(messages) as QueueMessage[];
    for await (const message of queueMessages) {
      const { userId, content, replyToken } = message.body;
      // KVに登録する
      const now = new Date();
      await env.LINE_GPT_KV.put(
        `${userId}:${now.getTime()}`,
        JSON.stringify({ role: "user", content }),
        { expirationTtl: 60 * 60 * 6 }
      );

      // KVを参照する
      const { keys } = await env.LINE_GPT_KV.list({
        prefix: `${userId}:`,
        limit: 20,
      });

      const chatGPTcontents = [];
      for (const key of keys) {
        const value = await env.LINE_GPT_KV.get(key.name, "json");
        if (value) {
          chatGPTcontents.push(value);
        }
      }

      try {
        const res = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "post",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${env.OPENAI_API_KEY}`,
          },
          body: JSON.stringify({
            model: "gpt-3.5-turbo",
            messages: chatGPTcontents,
          }),
        });
        const body = await res.json<ChatGPTResponse>();

        // KVに登録する
        const now = new Date();
        await env.LINE_GPT_KV.put(
          `${userId}:${now.getTime()}`,
          JSON.stringify({
            role: "assistant",
            content: body.choices[0].message.content,
          }),
          { expirationTtl: 60 * 60 * 6 }
        );

        const accessToken: string = env.CHANNEL_ACCESS_TOKEN;
        const response: TextMessage = {
          type: "text",
          text: body.choices[0].message.content,
        };
        await fetch("https://api.line.me/v2/bot/message/reply", {
          body: JSON.stringify({
            replyToken: replyToken,
            messages: [response],
          }),
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
        });
      } catch (error) {
        if (error instanceof Error) {
          console.error(error);
        }
      }
    }
  },
};
