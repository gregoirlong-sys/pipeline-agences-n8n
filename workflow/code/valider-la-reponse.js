// n8n:node Valider la réponse
// Fichier généré — édité librement, puis « node scripts/code-workflow.mjs injecter ».

// ── Validation ────────────────────────────────────────────────
//
// La sortie structurée garantit la FORME, pas le BON SENS. On vérifie ici ce
// que le schéma ne peut pas vérifier : bornes du score, longueurs plausibles,
// absence de champs vides sur les clés qui pilotent la suite.

const amont  = $('Extraire le texte').item.json;
const source = $('Boucle par domaine').item.json;

const brut = $json.content?.[0]?.text;
if (!brut) {
  throw new Error(`Réponse sans bloc texte exploitable (stop_reason : ${$json.stop_reason ?? 'inconnu'})`);
}

let a;
try {
  a = JSON.parse(brut);
} catch (e) {
  throw new Error(`JSON illisible malgré la sortie structurée : ${String(brut).slice(0, 200)}`);
}

const score = Number(a.score);
if (!Number.isInteger(score) || score < 0 || score > 100) {
  throw new Error(`Score hors bornes : ${a.score}`);
}
if (!a.entreprise || String(a.entreprise).trim().length < 2) {
  throw new Error("Nom d'entreprise absent — le site n'a probablement pas été compris.");
}
if (String(a.ligne_perso ?? '').length > 600) {
  throw new Error('Ligne de personnalisation anormalement longue — sortie suspecte.');
}

const usage = $json.usage ?? {};
const tokensIn  = usage.input_tokens  ?? 0;
const tokensOut = usage.output_tokens ?? 0;

// Tarifs Claude Haiku 4.5 : 1 $ / MTok en entrée, 5 $ / MTok en sortie.
const coutUsd = (tokensIn / 1e6) * 1 + (tokensOut / 1e6) * 5;

// Le tiret cadratin et la flèche sont des signatures d'écriture automatique,
// reconnues au premier coup d'œil par des fondateurs techniques qui utilisent
// ces outils tous les jours. Le prompt les interdit ; on nettoie quand même,
// parce qu'une consigne de prompt est une préférence et pas une garantie.
function assainirPonctuation(s) {
  return s
    .replace(/\s*[—–]\s*/g, ', ')
    .replace(/\s*→\s*/g, ' vers ')
    .replace(/\s{2,}/g, ' ')
    .replace(/,\s*,/g, ',')
    .trim();
}

const lignePerso = assainirPonctuation(String(a.ligne_perso ?? '').trim());

// Le corps complet, pas seulement l'accroche : le script d'envoi expédie le
// champ « Email (corps) » tel quel. N'y mettre que la ligne personnalisée
// enverrait un email d'une seule phrase.
// Les sauts de ligne sont des <br> (convention de la base Notion existante).
// Le prénom reste absent tant que le contact n'est pas trouvé : ce pipeline
// qualifie des entreprises, il n'invente jamais une adresse ni une identité.
const emailCorps = [
  'Bonjour,',
  '',
  lignePerso,
  '',
  "Je construis des automatisations et des agents IA en freelance : n8n, Make, API Claude et OpenAI, Next.js/Supabase. Je m'adresse aux agences plutôt qu'aux clients finaux : je cherche à livrer pour vous, pas à démarcher vos comptes.",
  '',
  "Deux choses que j'ai mises en production, testables en trente secondes :",
  '- t.me/NoriaxDevisBot : un bot qui transforme un message vocal en devis PDF',
  '- noriax.fr : chatbot Claude avec son dashboard de suivi',
  '',
  "Est-ce qu'il vous arrive de sous-traiter du build ?",
  '',
  'Grégoire Long',
  'noriax.fr/sous-traitance',
].join('<br>');

return [{
  json: {
    run_id:  source.run_id,
    domaine: source.domaine,
    site:    source.url,
    entreprise:     String(a.entreprise).trim(),
    ville:          String(a.ville ?? '').trim(),
    resume:         String(a.resume ?? '').trim(),
    signaux:        Array.isArray(a.signaux) ? a.signaux : [],
    score,
    score_pourquoi: String(a.score_pourquoi ?? '').trim(),
    ligne_perso:    lignePerso,
    email_corps:    emailCorps,
    tokens_in:  tokensIn,
    tokens_out: tokensOut,
    cout_usd:   Number(coutUsd.toFixed(6)),
    duree_ms:   Date.now() - amont.demarre_a,
  },
}];
