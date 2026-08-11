# Pipeline n8n — enrichissement et scoring de prospects B2B

Une liste brute de noms de domaine entre. Des fiches CRM qualifiées, notées et
personnalisées en sortent.

Chaque site est récupéré, nettoyé, résumé et noté par Claude contre un profil de
client idéal, puis écrit dans une base Notion avec une phrase d'accroche fondée
sur ce que dit réellement le site. **Ce workflow tourne sur ma propre campagne de
prospection** : il n'a pas été fabriqué pour la démonstration.

```
domaines → contrôle des credentials → [ pour chaque domaine ]
                                        idempotence → scrape → extraction
                                        → Claude (résumé + score + accroche)
                                        → validation → Notion → journal
                                      → clôture du run → alerte si dérive
```

## Ce que ça remplace

La recherche et la rédaction manuelles : environ **une heure pour dix agences**,
et la qualité de la dernière ligne rédigée ne vaut pas celle de la première. Le
pipeline traite quarante domaines sans surveillance, pour **moins d'un centime
par fiche**, et la quarantième est notée avec les mêmes critères que la première.

## Chiffres d'un run réel

Premier passage en production, sur cinq agences non encore qualifiées :

| | |
|---|---|
| Durée | 55 secondes |
| Coût | 0,0201 $ |
| Retenues | 2 (scores 85 et 78), fiches créées |
| Rejetées | 2 (score 25), journalisées sans fiche |
| Échec | 1 (site en 503), parti en dead letter, rejouable |

Les deux rejets sont ceux qu'on attend d'un tri utile : une structure de plus de
vingt-cinq personnes avec un process achat, et un agrégateur de prestataires qui
n'est pas une agence. Ni l'une ni l'autre n'aurait été détectée par des
mots-clés.

## Ce qui fait la différence en production

Un workflow qui marche sur cinq sites choisis n'est pas un workflow. Les points
ci-dessous sont ce qui sépare « j'ai suivi un tutoriel » de « je peux prendre
votre débordement » :

| Sujet | Traitement |
|---|---|
| **Idempotence** | Clé = domaine normalisé (`https://WWW.X.fr/contact` et `x.fr` donnent la même clé). Relancer sur la même liste ne re-scrape rien et ne re-facture aucun appel API. |
| **Reprises** | 3 tentatives avec attente sur le scraping, 3 sur l'API. Un site lent ou un 429 passager ne coûte pas la ligne. |
| **Dead letter** | Un échec définitif est écrit avec son étape et son message, puis le run continue. Les lignes en échec sont rejouables sans relancer le run entier. |
| **Expiration des credentials** | Vérifiée **avant** le premier scraping. Une clé morte coûte un appel et un email d'alerte, pas quarante scrapings inutiles. |
| **Journalisation** | Deux tables Postgres : un enregistrement par run, un par domaine, avec durée, tokens et coût. On sait ce qui s'est passé une semaine plus tard. |
| **Alerte** | Au-delà d'un taux d'échec configurable, email avec le bilan et la requête SQL pour lister les échecs. Un pipeline qui échoue en silence est pire qu'un pipeline qui tombe. |
| **Sortie structurée** | Le schéma JSON est appliqué côté API : la réponse est valide par construction. Pas de parsing défensif, pas de retry sur JSON malformé. |
| **Injection SQL** | Requêtes paramétrées partout. Un nom d'entreprise avec une apostrophe ne casse rien. |
| **Politesse** | User-Agent identifiable avec une adresse de contact, temporisation entre deux sites. On ne martèle pas les serveurs de gens qu'on veut comme partenaires. |
| **Hallucination** | Le prompt interdit toute donnée absente du texte fourni ; une page trop pauvre est écartée avant l'appel plutôt que résumée à l'aveugle. La validation rejette les scores hors bornes et les sorties aberrantes. |

## Stack

n8n · Claude Haiku 4.5 (API Anthropic, sortie structurée) · PostgreSQL (Supabase) ·
API Notion · Node.js pour l'outillage.

## Essayer

```bash
git clone https://github.com/gregoirlong-sys/pipeline-agences-n8n
cd pipeline-agences-n8n
```

**1. Voir ce que le pipeline extrait, sans rien installer ni dépenser :**

```bash
node scripts/tester-analyse.mjs --extraction-seule hyperstack.studio sequance.fr
```

**2. Avec une clé Anthropic — l'analyse complète sur un domaine réel :**

```bash
ANTHROPIC_API_KEY=sk-ant-... node scripts/tester-analyse.mjs sequance.fr
```

Ce script rejoue exactement la logique du workflow (même extraction, même
prompt, même schéma) hors de n8n. Il sert à ajuster le prompt sans relancer une
exécution, et à diagnostiquer un domaine parti en dead letter.

**3. Le workflow entier :**

```bash
psql "$DATABASE_URL" -f sql/001_journalisation.sql   # les deux tables
node scripts/valider-workflow.mjs                    # contrôle avant import
```

Puis importer `workflow/pipeline-agences.json` dans n8n et renseigner les
emplacements marqués `REMPLACER` — trois credentials (Anthropic en header
`x-api-key`, Postgres, Notion), un SMTP pour les alertes, et dans le nœud
**Configuration** : l'identifiant de la base Notion et l'adresse d'alerte.

## Configuration

Tout se règle dans le nœud **Configuration**, sans toucher au reste :

| Champ | Défaut | Rôle |
|---|---|---|
| `modele` | `claude-haiku-4-5` | Haiku suffit pour résumer et noter. Passer à un modèle supérieur améliore surtout la phrase d'accroche. |
| `seuil_score` | `60` | En dessous, la fiche n'est pas créée mais reste journalisée. |
| `plafond_par_run` | `40` | Garde-fou : borne la dépense d'une exécution. |
| `delai_entre_sites_ms` | `2000` | Temporisation entre deux sites. |
| `taux_echec_alerte` | `0.3` | Au-delà, email d'alerte. |
| `icp` | — | Le profil de client idéal, en texte. C'est le seul champ à réécrire pour changer de cible. |

## Le workflow versionné en clair

Dans un export n8n, le JavaScript des nœuds Code est une longue chaîne JSON
échappée : illisible en revue, indiffable en commit, et une accolade manquante
ne se voit pas. Les quatre nœuds Code sont donc aussi versionnés en `.js`
lisibles dans `workflow/code/`, synchronisés dans les deux sens :

```bash
node scripts/code-workflow.mjs extraire   # après édition dans l'interface n8n
node scripts/code-workflow.mjs injecter   # après édition des fichiers .js
node scripts/code-workflow.mjs verifier   # échoue si les deux divergent
```

`injecter` refuse d'écrire du JavaScript qui ne compile pas : on n'importe
jamais un workflow cassé.

## Exploitation

Ce qu'on veut savoir une fois le pipeline en service : ce qu'il a fait, ce qui a
cassé, et comment y revenir.

```bash
npm run runs              # bilan des derniers runs, item par item
npm run runs -- --echecs  # la dead letter, avec l'étape et le message
```

L'idempotence protège des doublons jusqu'au jour où l'on veut justement
retraiter quelque chose : prompt corrigé, seuil déplacé, site qui était en
panne. C'est le rôle de `rejouer` — il archive la fiche Notion déjà créée
(corbeille, réversible) **puis** efface la trace du journal, dans cet ordre :
si l'archivage échoue, la trace subsiste et continue de protéger du doublon.

```bash
npm run rejouer -- devflows.eu flowt.fr --dry-run
npm run rejouer -- devflows.eu flowt.fr
npm run rejouer -- --echecs      # tout ce qui est en dead letter
```

Les lignes en `echec` ne sont **pas** couvertes par l'idempotence : un site
momentanément injoignable est automatiquement retenté au run suivant, sans
manipulation.

## Structure

```
workflow/
  pipeline-agences.json    workflow importable (26 nœuds)
  code/*.js                les nœuds Code, en clair et diffables
sql/
  001_journalisation.sql   pipeline_runs + pipeline_items
scripts/
  valider-workflow.mjs     structure, connexions, syntaxe JS, expressions,
                           paramètres obligatoires, globales hors bac à sable
  code-workflow.mjs        synchronisation JSON ↔ .js
  preparer-import.mjs      version locale : identifiants et réglages injectés
  voir-runs.mjs            bilan des exécutions, lu depuis le journal
  rejouer.mjs              remet des domaines en file
  tester-analyse.mjs       rejoue la logique sur un domaine, hors n8n
```

### Sur le validateur

n8n accepte à l'import des workflows qui échoueront à l'exécution, et ses
messages d'erreur ne disent alors ni quel nœud ni quel champ. Chaque famille
d'erreur rencontrée en construisant ce pipeline a donc été ajoutée au
validateur : noms de paramètres attendus par type de nœud, expressions
`{{ }}` syntaxiquement fausses (le double échappement produit par un script
générateur, notamment), et usage de globales absentes du bac à sable des nœuds
Code (`crypto`, `require`, `process`…). C'est une seconde de vérification
contre un aller-retour dans l'interface.

## Adapter à un autre usage

Le pipeline n'a rien de spécifique à la prospection d'agences. Réécrire le champ
`icp` suffit à changer de cible ; remplacer le nœud Notion par un autre CRM ne
touche qu'un nœud, la journalisation et la reprise sur erreur restant en place.

## Honnêteté

Projet conçu et exploité par moi-même, pas une commande client. Il tourne en
conditions réelles sur ma campagne de sous-traitance, et le code est public :
c'est vérifiable, ce qui vaut mieux que des chiffres d'usage invérifiables.

---

Grégoire Long — [noriax.fr](https://noriax.fr) · gregoire@noriax.fr
