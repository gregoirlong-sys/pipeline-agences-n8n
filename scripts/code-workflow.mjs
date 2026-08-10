// ──────────────────────────────────────────────────────────────
// Synchronisation des nœuds Code entre le JSON et des fichiers .js
//
//   node scripts/code-workflow.mjs extraire   # JSON  → workflow/code/*.js
//   node scripts/code-workflow.mjs injecter   # workflow/code/*.js → JSON
//   node scripts/code-workflow.mjs verifier   # les deux sont-ils synchrones ?
//
// Pourquoi : dans un export n8n, le JavaScript des nœuds Code est une longue
// chaîne JSON échappée. Illisible en revue, indiffable dans un commit, et on
// n'y voit pas une accolade manquante. En le gardant aussi en .js, on obtient
// une coloration syntaxique, des diffs propres, et un lint possible.
//
// Boucle de travail : on édite dans l'interface n8n, on ré-exporte le JSON,
// on lance `extraire`. Ou on édite le .js, on lance `injecter`, on réimporte.
// `verifier` tourne en CI pour empêcher les deux sources de diverger.
// ──────────────────────────────────────────────────────────────

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const WORKFLOW = "workflow/pipeline-agences.json";
const DOSSIER = "workflow/code";
const TYPE_CODE = "n8n-nodes-base.code";

const action = process.argv[2];

function slug(nom) {
  return nom
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function charger() {
  return JSON.parse(readFileSync(WORKFLOW, "utf8"));
}

function noeudsCode(wf) {
  return wf.nodes.filter((n) => n.type === TYPE_CODE);
}

// L'en-tête porte le nom du nœud : c'est ce qui relie le fichier au JSON.
// Sans elle, un fichier renommé perdrait sa cible silencieusement.
function entete(nom) {
  return `// n8n:node ${nom}\n// Fichier généré — édité librement, puis « node scripts/code-workflow.mjs injecter ».\n\n`;
}

function sansEntete(contenu) {
  return contenu.replace(/^\/\/ n8n:node .*\n\/\/ Fichier généré.*\n\n/, "");
}

if (action === "extraire") {
  mkdirSync(DOSSIER, { recursive: true });
  const wf = charger();
  for (const n of noeudsCode(wf)) {
    const fichier = join(DOSSIER, `${slug(n.name)}.js`);
    writeFileSync(fichier, entete(n.name) + n.parameters.jsCode + "\n", "utf8");
    console.log(`→ ${fichier}`);
  }
  console.log(`\n${noeudsCode(wf).length} nœud(s) Code extrait(s).`);
} else if (action === "injecter") {
  const wf = charger();
  let modifies = 0;
  for (const n of noeudsCode(wf)) {
    const fichier = join(DOSSIER, `${slug(n.name)}.js`);
    if (!existsSync(fichier)) {
      console.warn(`⚠️  Aucun fichier pour "${n.name}" — nœud laissé tel quel.`);
      continue;
    }
    const code = sansEntete(readFileSync(fichier, "utf8")).replace(/\n+$/, "");
    // Le JS est validé avant écriture : on n'injecte jamais du code cassé
    // dans un workflow qu'on va importer en production.
    try {
      new Function(code);
    } catch (e) {
      console.error(`❌ ${fichier} : ${e.message}`);
      process.exit(1);
    }
    if (code !== n.parameters.jsCode) {
      n.parameters.jsCode = code;
      modifies++;
      console.log(`→ "${n.name}" mis à jour`);
    }
  }
  writeFileSync(WORKFLOW, JSON.stringify(wf, null, 2) + "\n", "utf8");
  console.log(`\n${modifies} nœud(s) modifié(s).`);
} else if (action === "verifier") {
  const wf = charger();
  const ecarts = [];
  for (const n of noeudsCode(wf)) {
    const fichier = join(DOSSIER, `${slug(n.name)}.js`);
    if (!existsSync(fichier)) {
      ecarts.push(`Fichier manquant pour "${n.name}" (${fichier})`);
      continue;
    }
    const code = sansEntete(readFileSync(fichier, "utf8")).replace(/\n+$/, "");
    if (code !== n.parameters.jsCode) ecarts.push(`Désynchronisé : "${n.name}"`);
  }
  const attendus = new Set(noeudsCode(wf).map((n) => `${slug(n.name)}.js`));
  if (existsSync(DOSSIER)) {
    for (const f of readdirSync(DOSSIER)) {
      if (f.endsWith(".js") && !attendus.has(f)) ecarts.push(`Fichier orphelin : ${f}`);
    }
  }
  if (ecarts.length) {
    console.error("❌ JSON et fichiers .js divergent :");
    for (const e of ecarts) console.error(`   • ${e}`);
    process.exit(1);
  }
  console.log("✅ JSON et fichiers .js synchronisés.");
} else {
  console.error("Usage : node scripts/code-workflow.mjs extraire|injecter|verifier");
  process.exit(1);
}
