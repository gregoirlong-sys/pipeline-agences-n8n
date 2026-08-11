// ──────────────────────────────────────────────────────────────
// Prépare une version « prête à importer » du workflow
//
//   node scripts/preparer-import.mjs
//   npx n8n import:workflow --input=local/pipeline-agences.local.json
//
// Le workflow du dépôt est volontairement neutre : identifiants marqués
// REMPLACER, aucune valeur propre à une installation. C'est ce qui le rend
// publiable et réutilisable.
//
// Ce script produit, à côté, une version locale et gitignorée où sont injectés :
//   - les identifiants réellement présents dans l'instance n8n, retrouvés par
//     type (on ne lit que leur id et leur nom : les secrets restent chiffrés)
//   - les valeurs de local/config.json (identifiant de base Notion, email)
//
// Intérêt : réimporter une nouvelle version du workflow sans reperdre à chaque
// fois la configuration saisie à la main dans l'interface.
// ──────────────────────────────────────────────────────────────

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";

const SOURCE = "workflow/pipeline-agences.json";
const SORTIE = "local/pipeline-agences.local.json";
const CONFIG = "local/config.json";
const BASE_N8N = process.env.N8N_DB ?? join(homedir(), ".n8n", "database.sqlite");

// Identifiant fixe : réimporter met à jour le workflow existant au lieu d'en
// créer un doublon à chaque fois.
const ID_WORKFLOW = "pipelineAgences1";

if (!existsSync(CONFIG)) {
  mkdirSync("local", { recursive: true });
  writeFileSync(
    CONFIG,
    JSON.stringify({ notion_database_id: "", email_alerte: "" }, null, 2) + "\n"
  );
  console.error(`Fichier ${CONFIG} créé. Renseignez-le, puis relancez.`);
  process.exit(1);
}

const config = JSON.parse(readFileSync(CONFIG, "utf8"));
const wf = JSON.parse(readFileSync(SOURCE, "utf8"));

// ── Identifiants présents dans n8n, par type ──────────────────

if (!existsSync(BASE_N8N)) {
  console.error(`Base n8n introuvable : ${BASE_N8N}`);
  process.exit(1);
}

const db = new DatabaseSync(BASE_N8N, { readOnly: true });
const parType = new Map();
for (const l of db.prepare("SELECT id, name, type FROM credentials_entity").all()) {
  // Le premier trouvé pour un type donné fait foi. Suffisant ici : une seule
  // instance, un identifiant par service.
  if (!parType.has(l.type)) parType.set(l.type, { id: l.id, name: l.name });
}
db.close();

// ── Injection ─────────────────────────────────────────────────

let rattaches = 0;
const manquants = new Set();

for (const noeud of wf.nodes) {
  if (!noeud.credentials) continue;
  for (const type of Object.keys(noeud.credentials)) {
    const trouve = parType.get(type);
    if (trouve) {
      noeud.credentials[type] = { id: trouve.id, name: trouve.name };
      rattaches++;
    } else {
      manquants.add(`${type} (nœud « ${noeud.name} »)`);
    }
  }
}

const configNoeud = wf.nodes.find((n) => n.name === "Configuration");
for (const [cle, valeur] of Object.entries(config)) {
  if (!valeur) continue;
  const champ = configNoeud?.parameters?.assignments?.assignments?.find((a) => a.name === cle);
  if (champ) champ.value = valeur;
  else console.warn(`⚠️  Champ « ${cle} » absent du nœud Configuration.`);
}

wf.id = ID_WORKFLOW;
wf.active = false;

mkdirSync("local", { recursive: true });
// Sans BOM : n8n refuse un JSON qui commence par un caractère invisible.
writeFileSync(SORTIE, JSON.stringify(wf, null, 2) + "\n", { encoding: "utf8" });

console.log(`✅ ${SORTIE}`);
console.log(`   ${rattaches} rattachement(s) d'identifiant`);
for (const m of manquants) console.log(`   ⚠️  aucun identifiant de type ${m}`);
console.log(`\nImporter :\n   npx n8n import:workflow --input=${SORTIE}`);
