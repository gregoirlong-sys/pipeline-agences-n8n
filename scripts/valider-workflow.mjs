// ──────────────────────────────────────────────────────────────
// Validation du workflow avant import
//
//   node scripts/valider-workflow.mjs
//
// Un workflow n8n est un gros JSON : une virgule de trop, un nœud renommé
// sans mettre à jour les connexions, une faute de frappe dans un nœud Code —
// et l'erreur ne se voit qu'à l'exécution, sur le site n°14. Ce script attrape
// ces trois familles de problèmes en une seconde, hors de n8n.
// ──────────────────────────────────────────────────────────────

import { readFileSync } from "node:fs";

const chemin = process.argv[2] ?? "workflow/pipeline-agences.json";
const erreurs = [];
const avertissements = [];

// ── 1. Le JSON parse-t-il ? ───────────────────────────────────

let wf;
try {
  wf = JSON.parse(readFileSync(chemin, "utf8"));
} catch (e) {
  console.error(`❌ JSON invalide : ${e.message}`);
  process.exit(1);
}

const noms = new Set(wf.nodes.map((n) => n.name));

// ── 2. Les connexions pointent-elles vers des nœuds réels ? ────

for (const [source, sorties] of Object.entries(wf.connections)) {
  if (!noms.has(source)) {
    erreurs.push(`Connexion depuis un nœud inexistant : "${source}"`);
  }
  for (const branche of sorties.main ?? []) {
    for (const lien of branche ?? []) {
      if (!noms.has(lien.node)) {
        erreurs.push(`"${source}" pointe vers un nœud inexistant : "${lien.node}"`);
      }
    }
  }
}

// Un nœud sans entrée et sans être un déclencheur est du code mort.
const cibles = new Set(
  Object.values(wf.connections)
    .flatMap((s) => s.main ?? [])
    .flat()
    .map((l) => l.node)
);
for (const n of wf.nodes) {
  const estDeclencheur = /trigger|webhook/i.test(n.type);
  if (!estDeclencheur && !cibles.has(n.name)) {
    avertissements.push(`Nœud jamais atteint : "${n.name}"`);
  }
}

// ── 3. Les nœuds Code sont-ils du JavaScript valide ? ─────────

for (const n of wf.nodes.filter((n) => n.type === "n8n-nodes-base.code")) {
  try {
    new Function(n.parameters.jsCode);
  } catch (e) {
    erreurs.push(`Syntaxe JS invalide dans "${n.name}" : ${e.message}`);
  }
}

// ── 4. Les références $('Nœud') existent-elles ? ───────────────
//
// C'est l'erreur la plus fréquente : on renomme un nœud dans l'éditeur et les
// expressions qui le référencent cassent silencieusement.

const referencees = new Set();
const motif = /\$\(\s*['"]([^'"]+)['"]\s*\)/g;
const brut = JSON.stringify(wf);
for (const m of brut.matchAll(motif)) referencees.add(m[1]);

for (const ref of referencees) {
  if (!noms.has(ref)) {
    erreurs.push(`Expression référençant un nœud inexistant : $('${ref}')`);
  }
}

// ── 5. Les placeholders sont-ils bien signalés ? ──────────────

const nbPlaceholders = (brut.match(/REMPLACER/g) ?? []).length;

// ── Verdict ───────────────────────────────────────────────────

console.log(`Workflow  : ${wf.name}`);
console.log(`Nœuds     : ${wf.nodes.length}`);
console.log(`Nœuds Code: ${wf.nodes.filter((n) => n.type === "n8n-nodes-base.code").length}`);
console.log(`Références inter-nœuds vérifiées : ${referencees.size}`);
console.log(`Placeholders à renseigner après import : ${nbPlaceholders}`);

for (const a of avertissements) console.log(`⚠️  ${a}`);

if (erreurs.length) {
  console.error(`\n❌ ${erreurs.length} erreur(s) :`);
  for (const e of erreurs) console.error(`   • ${e}`);
  process.exit(1);
}

console.log("\n✅ Workflow valide — prêt à importer.");
