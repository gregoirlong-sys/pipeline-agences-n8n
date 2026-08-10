// n8n:node Préparer le run
// Fichier généré — édité librement, puis « node scripts/code-workflow.mjs injecter ».

// ── Préparation du run ────────────────────────────────────────
//
// Trois responsabilités :
//   1. générer un identifiant de run (traçabilité + jointure des logs)
//   2. normaliser les domaines — c'est LA clé d'idempotence, donc elle doit
//      être stable : https://WWW.Exemple.fr/contact et exemple.fr doivent
//      produire exactement la même clé, sinon on re-scrape et on re-facture
//   3. dédoublonner dans le lot et appliquer le plafond du run

const config = $('Configuration').first().json;

const runId = crypto.randomUUID();

function normaliserDomaine(entree) {
  return String(entree)
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/.*$/, '')
    .replace(/:\d+$/, '');
}

const vus = new Set();
const domaines = [];

for (const brut of config.domaines ?? []) {
  const domaine = normaliserDomaine(brut);
  // Filtre minimal : il faut au moins un point et pas d'espace
  if (!domaine || !domaine.includes('.') || /\s/.test(domaine)) continue;
  if (vus.has(domaine)) continue;
  vus.add(domaine);
  domaines.push(domaine);
  if (domaines.length >= config.plafond_par_run) break;
}

if (domaines.length === 0) {
  throw new Error("Aucun domaine exploitable en entrée — vérifier le champ 'domaines' de la Configuration.");
}

return domaines.map((domaine) => ({
  json: {
    run_id: runId,
    domaine,
    url: `https://${domaine}`,
    nb_entrees: domaines.length,
    declencheur: $('Configuration').first().json.body ? 'webhook' : 'manuel',
  },
}));
