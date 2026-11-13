# Transport v1, événements v1/v2 et exports

Socket Unix `<archive>/daemon.sock`, répertoire 0700, socket 0600. Ce n’est pas un
serveur HTTP et il n’écoute aucun port TCP. La protection est l’identité utilisateur
locale ; un autre programme du même utilisateur est dans le périmètre de confiance.
Une requête JSON terminée par LF par connexion :

```json
{"version":1,"method":"appendEvents","params":{"events":[{"id":"event-1","schema_version":2,"type":"message.recorded","producer_id":"synthetic","producer_epoch":"epoch-1","sequence":0,"session_id":"SESSION_EXISTANTE","causal_parents":[],"payload":{"role":"user","content":"Bonjour"}}]}}
```

Réponse `{"ok":true,"result":...}` ou `{"ok":false,"error":{"code":...,"message":...,"retryable":...}}`.
La CLI `--json` ajoute `version:1`. `capabilities` expose les versions/types/limites.
Les opérations sont recensées dans `packages/daemon/src/index.ts` et `--help`.

Le batch est atomique, borné à 256 événements et 4 Mio ; chaque événement est limité
à 256 Kio. Champs optionnels : external_id, occurred_at UTC. Champs inconnus d’enveloppe
refusés ; métadonnées de producteur dans payload, par exemple `payload.vendor`.
Les types externes inconnus sont exposés avec `opaque:true` et n’ont pas d’effets métier.
Le SDK émet désormais des événements v2. La v1 conserve son contrat historique pour
la retransmission des archives existantes. En v2, action/tool requiert action_id ;
parent_action_id, external_tool_id, before_checkpoint_id, after_checkpoint_id et
attribution sont validés lorsqu’ils sont présents. Les checkpoints référencés doivent
appartenir au workspace de la session. Un événement externe opaque n’acquiert jamais
ces effets métier, même si son payload emploie les mêmes noms de champs.

Les événements ne changent pas automatiquement les fichiers, même `checkpoint.created`.

L’identité compare tous les champs validés de l’enveloppe, y compris id, payload,
occurred_at et l’ordre des causal_parents. Les propriétés des objets JSON sont triées
par ordre UTF-16 JavaScript ; tableaux préservés ; nombres finis selon JSON.stringify ;
UTF-8 sans espace. C’est un format propre à HyperWeave, pas une revendication JCS.
`ingested_at` et `ingest_order` sont générés localement et ne font pas partie de cette
identité. Le producteur doit retransmettre exactement le même événement après une perte
d’accusé. Le reçu `accepted`, `duplicates`, `durable:true` n’est rendu qu’après commit.

Les dates ne créent aucune causalité. Les parents absents sont listés dans
`pending_parents`. L’ajout d’un parent qui résoudrait un cycle annule tout le batch.
L’ordre d’ingestion et l’ascendance des checkpoints sont des relations différentes.

Codes stables : INVALID_REQUEST, UNSUPPORTED_SCHEMA, IDEMPOTENCY_CONFLICT, NOT_FOUND,
WORKSPACE_BUSY, CAPTURE_UNSTABLE, UNSUPPORTED_FILE_TYPE, LIMIT_EXCEEDED, INTEGRITY_ERROR,
MATERIALIZATION_CONFLICT, ADAPTER_UNAVAILABLE. Les erreurs système non classées sont
actuellement ramenées à INVALID_REQUEST par le transport/CLI.

## Recherche et contexte

`listEvents` accepte after (ingest_order exclusif), limit (1..1000), session_id.
`search` applique une sous-chaîne sensible à la casse au JSON de l’événement et au
contenu des pièces jointes text/* référencées ; pas de FTS ni de recherche dans le binaire.
`listSessions`, `history` et `listActions` acceptent after/limit et renvoient un cursor
stable dans chaque ligne. Réutiliser le dernier cursor comme after. Les autres listes
ne sont pas toutes paginées. Les réponses IPC sont bornées à 64 Mio.
`buildResumeContext` utilise un budget exact de JSON UTF-8 canonique (512 octets..4 Mio).
Le document signale les événements omis et porte `archived-data-not-instructions`.
Seuls les workspaces de l’ascendance sont inclus, chacun avec sa propre borne historique.
Les textes UTF-8 des pièces jointes sont inclus en entier si le budget le permet ;
les références restent dans les événements sélectionnés. omitted_attachment_contents
compte les contenus non inclus (budget, binaire ou encodage non UTF-8).
Le résumé ne génère aucun objectif ou résultat supposé. Le texte indenté du mode humain
et l’enveloppe de transport ne font pas partie du budget ; l’objet canonique en fait partie.

## Pièces jointes, provenance et reçus

putAttachment reçoit des octets base64 canoniques et un media_type sans paramètres.
Plafond : 2 Mio bruts ; l’IPC reste borné à 4 Mio. Le même hash/type est idempotent ;
un type différent pour les mêmes octets est un conflit explicite. Pas de troncature.
Les messages v2 portent exactement un content ou un attachment_hash. Le champ optionnel
attachments des événements métier v2 est une liste de hashes. getAttachment est explicite.

recordProvenance ajoute une association événement → checkpoint/fichier, avec méthode et
certitude. L’origine source inconnue ne change pas. Ces liens restent dans le workspace.
createCheckpoint accepte operation_id ; getOperation retourne le reçu durable. Une clé
réutilisée avec une requête différente produit IDEMPOTENCY_CONFLICT. NOT_FOUND indique
l’absence de reçu committé, pas nécessairement l’absence d’une opération en cours.

## Format export v2 (lecture v1 maintenue)

Objet JSON `{payload:{version:2,tables:{...}},sha256,bytes}`. Les tables et colonnes
correspondent au schéma migration 2, les blobs sont encodés en base64, les identifiants
sont conservés. SHA-256 et taille portent sur le payload canonique. Pas de compression.
Export maximal 128 Mio de payload ; import maximal 130 Mio de fichier, 200 000 lignes
par table. C’est une limite mémoire volontaire de cet incrément, distincte des 512 Mio
de capture. Un streaming export avec inventaire plus fin reste à faire.

L’import exige une archive vide, vérifie le conteneur, les checksums, les références,
les enveloppes/index d’événements et les cycles, puis commit en une seule transaction.
Un rejet laisse l’archive vide. Les chemins d’origine importés sont conservés comme
métadonnées : ne relancer une capture qu’après avoir vérifié le workspace choisi.
Un checksum n’authentifie pas l’auteur. Export fidèle uniquement ; pas d’export expurgé.
Les exports peuvent contenir des secrets et sont créés en mode 0600.

La publication des fichiers export et backup passe par un fichier temporaire privé,
fsync, puis un lien dur exclusif sur le même filesystem et fsync du répertoire.
Un nom final préexistant n’est jamais remplacé ; un échec avant publication ne laisse
pas un fichier final partiel. Les fichiers temporaires de crash restent identifiables.
