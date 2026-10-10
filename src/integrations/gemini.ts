// Gemini: parses free text into a structured intent (JSON-schema output) and writes short option reasons.
// Scores, budgets and times are never computed here.
import { GoogleGenAI } from "@google/genai";
import { config, hasGemini } from "../config.ts";
import { INTENT_TYPES, parseRules, type Intent } from "../intent.ts";

let client: GoogleGenAI | null = null;
const ai = () => (client ??= new GoogleGenAI({ apiKey: config.gemini.apiKey! }));

const INTENT_SCHEMA = {
  type: "object",
  properties: {
    type: { type: "string", enum: [...INTENT_TYPES] },
    mood: { type: "string", enum: ["light", "filling"], description: "hungry_solo / set_pref: how hungry. 'starving' means filling." },
    names: { type: "array", items: { type: "string" }, description: "plan_group: first names or nicknames of the friends, exactly as written." },
    when: { type: "string", description: "plan_group: 'tonight', 'tomorrow', or a day." },
    meal: { type: "string", enum: ["lunch", "dinner"] },
    n: { type: "integer", description: "choose: the option number picked." },
    yes: { type: "boolean", description: "confirm: true for yes / in / booked / sounds good." },
    free_at: { type: "string", description: "availability: 24h HH:MM the user is free from. 'after 7' in the evening is 19:00." },
    unavailable: { type: "boolean", description: "availability: true when they can't make it." },
    diet: { type: "array", items: { type: "string" }, description: "set_pref: dietary restrictions, e.g. vegetarian, vegan, no seafood, halal, gluten-free." },
    dislikes: { type: "array", items: { type: "string" } },
    max_per_meal: { type: "number", description: "set_pref: a dollar max per meal if stated." },
    target: { type: "string", description: "veto / forget: what to exclude or forget, e.g. 'ramen', 'my budget'." },
    never: { type: "boolean", description: "veto: true only for 'never X' (permanent)." },
    kind: { type: "string", enum: ["treat", "cheap"] },
    amount: { type: "number" },
    sentiment: { type: "string", enum: ["positive", "negative", "neutral"], description: "feedback about a meal." },
  },
  required: ["type"],
} as const;

const SYSTEM = `You classify one text message sent to Foodie, an iMessage dining assistant, into exactly one intent.
Intents:
- hungry_solo: the sender wants somewhere to eat now, alone ("I'm hungry", "starving", "where should I get lunch").
- plan_group: plan a meal with named friends ("dinner tonight with Clive and Eric", "lunch with the usual").
- choose: picks an option by number.
- confirm: yes/no to Foodie's last question; "in" is yes.
- availability: when they're free ("after 7", "free at 6:30") or that they can't come ("can't make it").
- set_pref: dietary restrictions, dislikes, a per-meal max, or answering light/filling.
- veto: "not ramen" (soft, never=false) or "never ramen" (never=true).
- budget_override: "treat night" (treat) or "keep it cheap" (cheap), with an amount if given.
- feedback: how a meal was.
- what_do_you_know: asks what Foodie knows about them.
- forget: asks Foodie to delete something.
- stop: wants Foodie to pause.
- other: anything else.
Return only the fields that apply.`;

type Raw = {
  type?: string;
  mood?: "light" | "filling";
  names?: string[];
  when?: string;
  meal?: "lunch" | "dinner";
  n?: number;
  yes?: boolean;
  free_at?: string;
  unavailable?: boolean;
  diet?: string[];
  dislikes?: string[];
  max_per_meal?: number;
  target?: string;
  never?: boolean;
  kind?: "treat" | "cheap";
  amount?: number;
  sentiment?: "positive" | "negative" | "neutral";
};

function toIntent(raw: Raw, text: string): Intent {
  switch (raw.type) {
    case "hungry_solo":
      return { type: "hungry_solo", mood: raw.mood };
    case "plan_group":
      return raw.names?.length ? { type: "plan_group", names: raw.names, when: raw.when, meal: raw.meal } : { type: "other" };
    case "choose":
      return raw.n ? { type: "choose", n: raw.n } : { type: "other" };
    case "confirm":
      return { type: "confirm", yes: raw.yes !== false };
    case "availability": {
      if (raw.unavailable) return { type: "availability", unavailable: true };
      const m = raw.free_at?.match(/^(\d{1,2}):(\d{2})$/);
      return m ? { type: "availability", freeAt: { hour: Number(m[1]), minute: Number(m[2]) } } : { type: "other" };
    }
    case "set_pref":
      return { type: "set_pref", diet: raw.diet, dislikes: raw.dislikes, maxPerMeal: raw.max_per_meal, mood: raw.mood };
    case "veto":
      return raw.target ? { type: "veto", target: raw.target, never: raw.never === true } : { type: "other" };
    case "budget_override":
      return raw.kind ? { type: "budget_override", kind: raw.kind, amount: raw.amount } : { type: "other" };
    case "feedback":
      return { type: "feedback", sentiment: raw.sentiment ?? "neutral" };
    case "what_do_you_know":
      return { type: "what_do_you_know" };
    case "forget":
      return raw.target ? { type: "forget", target: raw.target } : { type: "other" };
    case "stop":
      return { type: "stop" };
    default:
      return parseRules(text);
  }
}

/** Free text → intent. Uses Gemini when configured, the rules parser otherwise or on any failure. */
export async function parseIntent(text: string, context?: { lastQuestion?: string; localTime?: string }): Promise<Intent> {
  const rules = parseRules(text);
  if (!hasGemini()) return rules;
  try {
    const prompt = [
      context?.localTime ? `Local time: ${context.localTime}.` : "",
      context?.lastQuestion ? `Foodie's last question to the sender: "${context.lastQuestion}"` : "",
      `Message: """${text.slice(0, 500)}"""`,
    ]
      .filter(Boolean)
      .join("\n");
    const res = await ai().models.generateContent({
      model: config.gemini.model,
      contents: prompt,
      config: {
        systemInstruction: SYSTEM,
        responseMimeType: "application/json",
        responseJsonSchema: INTENT_SCHEMA,
        temperature: 0,
      },
    });
    const raw = JSON.parse(res.text ?? "{}") as Raw;
    return toIntent(raw, text);
  } catch (err) {
    console.warn("[gemini] intent parse failed, using rules:", (err as Error).message);
    return rules;
  }
}

/**
 * One short reason for an option, from a reason code computed in code. Gemini may rephrase the template;
 * anything long, with digits or emoji, falls back to the template.
 */
export async function writeReason(template: string, placeName: string): Promise<string> {
  if (!template || !hasGemini()) return template;
  try {
    const res = await ai().models.generateContent({
      model: config.gemini.model,
      contents: `Rewrite this reason for suggesting "${placeName}" as a casual fragment of at most 6 words, lowercase, no punctuation at the end, no numbers, no emoji. Keep its meaning exactly. Reason: "${template}"`,
      config: { temperature: 0.3, maxOutputTokens: 30 },
    });
    const out = (res.text ?? "").trim().replace(/^["']|["']$/g, "").replace(/[.!]+$/, "");
    if (!out || out.split(/\s+/).length > 6 || /\d|\p{Extended_Pictographic}/u.test(out)) return template;
    return out;
  } catch {
    return template;
  }
}
