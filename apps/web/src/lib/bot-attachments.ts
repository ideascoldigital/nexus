// Files the user attaches to a message (the paperclip, a drop or a paste). They
// are uploaded to Nexus first (bot-files/<botId>/up-<id>/<name>) and ride in
// the message as plain Markdown links to Nexus — `![shot.png](/api/bots/…)` —
// so the chat shows them and the message stays one string. When the message
// runs, the manager copies each file into the bot's computer, under its folder
// in the shared workspace, and the bot reads the path instead of the link
// (bot-uploads.ts). Pure: the chat uses it too.

const IMAGE = /\.(png|jpe?g|gif|webp|svg)$/i;

export const MAX_ATTACHMENTS = 10;
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** A file name safe in a URL, a Markdown link and a shell-free docker cp path. */
export function safeUploadName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  const rawExt = dot > 0 ? base.slice(dot) : "";
  const ext = rawExt.toLowerCase().replace(/[^.a-z0-9]/g, "").slice(0, 10);
  const stem = base
    .slice(0, base.length - rawExt.length)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\w.\- ]+/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^[.\s-]+|[\s-]+$/g, "")
    .slice(0, 80);
  return `${stem || "file"}${ext}`;
}

/** The Markdown a message carries for one attachment. */
export function attachmentMarkdown(a: { name: string; url: string }): string {
  return IMAGE.test(a.name) ? `![${a.name}](${a.url})` : `[${a.name}](${a.url})`;
}

export type Attachment = { name: string; url: string; image: boolean; uploadId: string };

/** `[name](/api/bots/<bot>/files/up-…/<file>)`, with or without the image `!`. */
const ATTACHMENT = /!?\[([^\]\n]*)\]\((\/api\/bots\/([\w-]+)\/files\/(up-[\w-]+)\/([^)\s/]+))\)/g;

/** A message split into what you wrote and what you attached. Only uploads count. */
export function splitAttachments(prompt: string): { text: string; attachments: Attachment[] } {
  const attachments: Attachment[] = [];
  const text = prompt
    .replace(ATTACHMENT, (_whole, _label: string, url: string, _bot: string, uploadId: string, file: string) => {
      let name = file;
      try {
        name = decodeURIComponent(file);
      } catch {
        /* keep it as written */
      }
      attachments.push({ name, url, image: IMAGE.test(name), uploadId });
      return "";
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text, attachments };
}

/** Where an attachment lands in the bot's computer. */
export function attachmentPath(workdir: string, a: { name: string; uploadId: string }, taken: Set<string>): string {
  let name = a.name;
  if (taken.has(name)) name = `${a.uploadId.slice(3, 9)}-${name}`;
  taken.add(name);
  return `${workdir}/attachments/${name}`;
}

/** The message as the bot reads it: each link swapped for the file's path in its computer. */
export function withDeliveredAttachments(prompt: string, delivered: Map<string, string>): string {
  if (delivered.size === 0) return prompt;
  const replaced = prompt.replace(ATTACHMENT, (whole, _l: string, url: string) => {
    const p = delivered.get(url);
    return p ? `[attached: ${p}]` : whole;
  });
  const list = [...new Set(delivered.values())].map((p) => `- ${p}`).join("\n");
  return `${replaced}\n\n(The user attached ${delivered.size === 1 ? "this file" : "these files"} — it is in your computer, open it with your Read tool; images too, you can see them:\n${list})`;
}
