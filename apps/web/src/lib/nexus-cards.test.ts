import assert from "node:assert/strict";
import { test } from "node:test";

import { parseGitUrls, parseSourceCard, sourceAnswer } from "./nexus-cards";

test("a project-source block becomes a card, and the reply keeps its text", () => {
  const card = parseSourceCard('Hi! Let\'s set up your project.\n\n```project-source\n{"question": "¿De dónde sale el código?"}\n```');
  assert.deepEqual(card, { body: "Hi! Let's set up your project.", question: "¿De dónde sale el código?" });
  assert.equal(parseSourceCard("```project-source\n```")?.question, "Where does the code come from?");
  assert.equal(parseSourceCard("no card here"), null);
});

test("pasted Git URLs are picked out; anything else is ignored", () => {
  assert.deepEqual(parseGitUrls("https://github.com/a/b.git, git@github.com:a/c.git\nnot a url"), [
    "https://github.com/a/b.git",
    "git@github.com:a/c.git",
  ]);
  assert.equal(sourceAnswer.git(["https://x/a.git"]), "Git repositories:\n- https://x/a.git");
});

test("a confirm block becomes a card only with a real action id", async () => {
  const { parseConfirmCard } = await import("./nexus-cards");
  const card = parseConfirmCard('Listo.\n```confirm\n{"actionId": "act_1a2b", "title": "Launch on Civo", "detail": "Costs money"}\n```');
  assert.deepEqual(card, { body: "Listo.", actionId: "act_1a2b", title: "Launch on Civo", detail: "Costs money" });
  assert.equal(parseConfirmCard('```confirm\n{"actionId": "anything"}\n```'), null);
});

test("an add-credential block becomes a card for AWS or Civo only", async () => {
  const { parseCredentialCard } = await import("./nexus-cards");
  assert.deepEqual(parseCredentialCard('Falta la llave.\n```add-credential\n{"provider": "aws"}\n```'), {
    body: "Falta la llave.",
    provider: "aws",
  });
  assert.equal(parseCredentialCard('```add-credential\n{"provider": "github"}\n```'), null);
});
