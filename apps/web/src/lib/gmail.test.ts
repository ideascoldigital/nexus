import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  accountBotIds,
  addressOf,
  botMayUseAccount,
  buildRawMessage,
  encodeHeader,
  googleAuthUrl,
  htmlToText,
  looksLikeClientId,
  messageText,
  missingScopes,
  pkcePair,
  readable,
  replySubject,
  summarize,
  type GmailMessage,
} from "./gmail";

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");

test("PKCE: the challenge is the verifier's SHA-256", () => {
  const { verifier, challenge } = pkcePair();
  assert.equal(challenge, createHash("sha256").update(verifier).digest("base64url"));
  assert.ok(verifier.length >= 43);
});

test("the consent URL asks for offline access, Gmail read + compose, with PKCE", () => {
  const url = new URL(googleAuthUrl({ clientId: "1-a.apps.googleusercontent.com", redirectUri: "http://localhost:3100/api/google/oauth/callback", state: "s", challenge: "c", loginHint: "me@x.com" }));
  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.equal(url.searchParams.get("prompt"), "consent");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("login_hint"), "me@x.com");
  assert.match(url.searchParams.get("scope")!, /gmail\.readonly/);
  assert.match(url.searchParams.get("scope")!, /gmail\.compose/);
});

test("unticked scopes are noticed", () => {
  assert.deepEqual(missingScopes("openid email https://www.googleapis.com/auth/gmail.readonly"), [
    "https://www.googleapis.com/auth/gmail.compose",
  ]);
  assert.deepEqual(missingScopes(null).length, 2);
  assert.equal(looksLikeClientId("123-abc.apps.googleusercontent.com"), true);
  assert.equal(looksLikeClientId("nope"), false);
});

test("a message is RFC 2822, UTF-8, and no header can be injected", () => {
  const raw = buildRawMessage({
    from: "Cristhian <me@x.com>",
    to: "ana@x.com",
    cc: "",
    bcc: "b@x.com",
    subject: "Bienvenido a Simplifybot\r\nBcc: evil@x.com",
    body: "Hola Ana,\n\n¿Cómo vas?",
    inReplyTo: "<m1@mail>",
  });
  const text = Buffer.from(raw, "base64url").toString("utf8");
  const [head, body] = text.split("\r\n\r\n");
  assert.match(head!, /^From: Cristhian <me@x\.com>$/m);
  assert.doesNotMatch(head!, /^Cc:/m);
  assert.match(head!, /^Bcc: b@x\.com$/m);
  assert.equal(head!.match(/^Bcc:/gm)!.length, 1);
  assert.match(head!, /^In-Reply-To: <m1@mail>$/m);
  assert.match(head!, /^References: <m1@mail>$/m);
  assert.equal(Buffer.from(body!.replace(/\r\n/g, ""), "base64").toString("utf8"), "Hola Ana,\r\n\r\n¿Cómo vas?");
  assert.equal(encodeHeader("Plain"), "Plain");
  assert.match(encodeHeader("¿Qué tal?"), /^=\?UTF-8\?B\?/);
});

test("reply subjects and addresses", () => {
  assert.equal(replySubject("Hola"), "Re: Hola");
  assert.equal(replySubject("RE: Hola"), "RE: Hola");
  assert.equal(addressOf("Ana Pérez <Ana@X.com>"), "ana@x.com");
  assert.equal(addressOf(" ana@x.com "), "ana@x.com");
  assert.equal(addressOf(undefined), "");
});

test("reading: text/plain first, HTML as text otherwise, attachments listed", () => {
  const msg: GmailMessage = {
    id: "m1",
    threadId: "t1",
    labelIds: ["INBOX", "UNREAD"],
    snippet: "Hola",
    internalDate: "1700000000000",
    payload: {
      mimeType: "multipart/mixed",
      headers: [
        { name: "From", value: "Ana <ana@x.com>" },
        { name: "Subject", value: "Pregunta" },
        { name: "Message-ID", value: "<m1@mail>" },
      ],
      parts: [
        { mimeType: "multipart/alternative", parts: [
          { mimeType: "text/plain", body: { data: b64("Hola, una pregunta") } },
          { mimeType: "text/html", body: { data: b64("<p>Hola</p>") } },
        ] },
        { mimeType: "application/pdf", filename: "factura.pdf", body: { size: 1200, attachmentId: "a" } },
      ],
    },
  };
  assert.equal(messageText(msg), "Hola, una pregunta");
  const s = summarize(msg);
  assert.equal(s.unread, true);
  assert.equal(s.date, new Date(1700000000000).toISOString());
  const r = readable(msg, 4);
  assert.equal(r.messageId, "<m1@mail>");
  assert.equal(r.body, "Hola\n…[cut at 4 characters]");
  assert.deepEqual(r.attachments, [{ filename: "factura.pdf", mimeType: "application/pdf", size: 1200 }]);

  const htmlOnly: GmailMessage = { id: "m2", threadId: "t2", payload: { mimeType: "text/html", body: { data: b64("<style>x{}</style><p>Hola&nbsp;Ana</p><br>Chao") } } };
  assert.equal(messageText(htmlOnly), "Hola Ana\n\nChao");
  assert.equal(htmlToText("<b>a</b> &amp; b"), "a & b");
});

test("bot access: none listed means every bot", () => {
  assert.equal(botMayUseAccount({ email: "a" }, "b1"), true);
  assert.equal(botMayUseAccount({ botIds: [] }, "b1"), true);
  assert.equal(botMayUseAccount({ botIds: ["b2"] }, "b1"), false);
  assert.deepEqual(accountBotIds({ botIds: ["b1", 3] }), ["b1"]);
  assert.equal(accountBotIds(null), null);
});
