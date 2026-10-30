// server.js — Backend complet : Claude + déploiement CF Pages + stockage
import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import "dotenv/config";
import crypto from "crypto";
import fs from "fs/promises";
import path from "path";

const app = express();
app.use(express.json({ limit: "50mb" }));
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const STORE_DIR = "./data";

/* ============================================================
   STOCKAGE PERSISTANT DES PROJETS (fichiers + URL)
   ============================================================ */
async function loadProject(projectId) {
  try {
    const raw = await fs.readFile(path.join(STORE_DIR, `${projectId}.json`), "utf-8");
    return JSON.parse(raw);
  } catch {
    return { id: projectId, name: null, files: {}, url: null };
  }
}
async function saveProject(projectId, project) {
  await fs.mkdir(STORE_DIR, { recursive: true });
  await fs.writeFile(path.join(STORE_DIR, `${projectId}.json`), JSON.stringify(project, null, 2));
}

/* ============================================================
   GET /api/project/:id — recharge un projet (fichiers + URL)
   ============================================================ */
app.get("/api/project/:id", async (req, res) => {
  try {
    res.json(await loadProject(req.params.id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ============================================================
   POST /api/chat — l'IA ne déploie JAMAIS
   - Charge les fichiers existants depuis le serveur
   - Fusionne avec les nouveaux fichiers envoyés
   - Envoie à Claude
   - Retourne { message, files } pour aperçu
   ============================================================ */
app.post("/api/chat", async (req, res) => {
  const { projectId, userMessage, newFiles } = req.body;

  // 1. Charger l'état actuel (source de vérité = serveur)
  const project = await loadProject(projectId);
  const existingFiles = project.files || {};
  const hasUrl = !!project.url;

  // 2. Fusionner avec les nouveaux fichiers uploadés
  const merged = { ...existingFiles };
  if (Array.isArray(newFiles)) {
    newFiles.forEach(f => { merged[f.name] = f.content; });
  }

  // 3. Contexte pour Claude
  const filesContext = Object.entries(merged)
    .map(([name, content]) => `--- ${name} ---\n${content.slice(0, 6000)}`)
    .join("\n\n");

  const system = `Tu es un développeur senior expert. Tu modifies et écris du code pour un site web.

RÈGLES:
- hasUrl=false → Premier déploiement. Prépare/complète les fichiers.
- hasUrl=true → Projet déjà en ligne. Applique les modifications sur les fichiers existants.
- NE DÉPLOIE JAMAIS. L'utilisateur approuve après aperçu.
- Réponds TOUJOURS en JSON strict:
{
  "message": "texte pour l'utilisateur en français",
  "files": { "chemin/fichier.html": "contenu complet" } | null
}
Si aucune modification : "files": null.`;

  const userContent = `Message: ${userMessage || "(aucun)"}

${newFiles?.length ? `Nouveaux fichiers: ${newFiles.map(f => f.name).join(", ")}` : ""}

État actuel (hasUrl=${hasUrl}):
${filesContext || "(aucun fichier)"}`;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  try {
    const stream = await client.messages.create({
      model: process.env.ANTHROPIC_MODEL || "claude-opus-4-7",
      max_tokens: 128000,
      stream: true,
      system,
      messages: [{ role: "user", content: userContent }],
    });

    let fullText = "";
    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta?.text) {
        fullText += event.delta.text;
        res.write(`data: ${JSON.stringify({ chunk: event.delta.text })}\n\n`);
      }
    }

    let parsed;
    try {
      const match = fullText.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(match ? match[0] : fullText);
    } catch {
      parsed = { message: fullText, files: null };
    }
    res.write(`data: ${JSON.stringify({ done: true, result: parsed })}\n\n`);
    res.end();
  } catch (err) {
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  }
});

/* ============================================================
   POST /api/deploy — SEULEMENT après approbation
   - Fusionne fichiers existants + modifiés
   - Déploie sur CF Pages (manifest SHA-256)
   - Sauvegarde l'état sur le serveur
   ============================================================ */
app.post("/api/deploy", async (req, res) => {
  const { projectId, projectName, newFiles } = req.body;
  const slug = slugify(projectName) + "-" + projectId.slice(-6);

  try {
    // 1. Fusionner avec l'état existant
    const project = await loadProject(projectId);
    const allFiles = { ...project.files, ...newFiles };

    // 2. Créer le projet Pages (ignorer 409)
    const createRes = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${process.env.CF_ACCOUNT_ID}/pages/projects`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${process.env.CF_API_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ name: slug, production_branch: "main" }),
      }
    );
    if (!createRes.ok && createRes.status !== 409) {
      const t = await createRes.text();
      if (!t.toLowerCase().includes("already exists")) throw new Error("CF create: " + t);
    }

    // 3. Manifest + envoi
    const manifest = {};
    const entries = [];
    for (const [p, content] of Object.entries(allFiles)) {
      const clean = "/" + p.replace(/^\.?\//, "");
      manifest[clean] = crypto.createHash("sha256").update(content).digest("hex");
      entries.push({ path: clean, content });
    }
    const form = new FormData();
    form.append("manifest", JSON.stringify(manifest));
    form.append("branch", "main");
    for (const { path: fp, content } of entries) {
      form.append(fp, new Blob([content], { type: guessType(fp) }), fp.slice(1));
    }

    const depRes = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${process.env.CF_ACCOUNT_ID}/pages/projects/${slug}/deployments`,
      { method: "POST", headers: { authorization: `Bearer ${process.env.CF_API_TOKEN}` }, body: form }
    );
    if (!depRes.ok) throw new Error("CF deploy: " + (await depRes.text()));
    const dep = await depRes.json();
    const url = dep.result?.url || `https://${slug}.pages.dev`;

    // 4. Persister côté serveur
    project.files = allFiles;
    project.url = url;
    project.name = projectName;
    project.slug = slug;
    project.deployedAt = Date.now();
    await saveProject(projectId, project);

    res.json({ url, slug });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* UTILS */
function slugify(s) {
  return s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "site";
}
function guessType(p) {
  if (p.endsWith(".html")) return "text/html";
  if (p.endsWith(".css")) return "text/css";
  if (p.endsWith(".js")) return "application/javascript";
  if (p.endsWith(".json")) return "application/json";
  if (p.endsWith(".svg")) return "image/svg+xml";
  return "text/plain";
}

app.listen(process.env.PORT || 3000, () =>
  console.log(`✅ Serveur sur le port ${process.env.PORT || 3000}`)
);
