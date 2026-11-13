# Architecture et décisions

Les dossiers `packages/*` sont des modules TypeScript d’un build unique, pas encore
sept paquets npm publiables. Le graphe est explicite :

```text
cli -> daemon -> core -> storage-sqlite -> protocol
                     -> workspace-fs  -> protocol
adapter-sdk --------------------------> protocol
extensions/cursor : aucune dépendance du cœur, non implémenté
```

Le test de frontières interdit les imports d’extensions et de modules réseau depuis
le cœur, le stockage, le protocole et les opérations filesystem. Aucun plugin loader,
aucune télémétrie et aucun exécuteur de commandes archivées. Le seul programme externe
appelé par workspace-fs est Git pour déterminer le périmètre des fichiers.

## ADR 001 : Node 24 et SQLite intégré

Node 24 est la ligne LTS retenue ; version effectivement testée 24.22.1. `node:sqlite`
évite un binding natif npm supplémentaire et fournit DatabaseSync et backup. Son API
lie cette version à Node 24 ; les autres versions ne sont pas validées. TypeScript
7.0.2 et @types/node 24.19.2 ont été vérifiés auprès du registre avant verrouillage.

## ADR 002 : un propriétaire par archive

Le daemon acquiert un fichier verrou exclusif, configure WAL, synchronous=FULL et
foreign_keys=ON et vérifie ces valeurs. Le mode offline prend exactement le même verrou.
Il n’existe pas de deuxième chemin d’écriture contournant ce propriétaire. La protection
est plus stricte que le besoin « un écrivain par workspace » : une archive est sérialisée.
Une outbox séparée utilise ses propres transactions SQLite et ne modifie pas l’archive.

Les opérations synchrones s’exécutent dans un worker Node qui possède seul la connexion
SQLite et le verrou. Le thread de transport accepte les requêtes et conserve une file
bornée : 128 opérations actives/en attente, 32 Mio de requêtes en attente, 256 connexions.
Il envoie une opération à la fois au worker, y compris pour backup asynchrone.
Le scan précède toujours la transaction courte de publication SQLite.

`status` et `capabilities` ne passent pas derrière une capture. Le statut expose opération
active, taille de file, capture_active, date du dernier instantané et
snapshot_may_be_stale. Les compteurs d’archive sont le dernier état reçu du worker, pas
une lecture temps réel pendant une écriture. Les autres lectures attendent leur tour.
Un arrêt normal refuse les nouvelles opérations, termine celles acceptées et ferme la base.
Un worker défaillant met le daemon en échec ; il ne redémarre pas automatiquement une
écriture dont l’issue est incertaine. Arrêter le processus et suivre le guide de récupération.

Un timeout ne prouve pas l’annulation. appendEvents reste idempotent. Pour createCheckpoint,
un operation_id explicite associe requête normalisée et résultat dans la transaction même
qui publie le checkpoint. La retransmission retrouve ce résultat sans rescanner le dossier.
Les autres écritures n’ont pas toutes de reçus d’opération : inspecter avant de réessayer.

## ADR 003 : événements et contenu immuables dans la même base

Migrations 1 et 2 transactionnelles, `PRAGMA user_version=2`, dans storage-sqlite :

- projects : identité, nom, origine ; workspaces : projet, racine, politique, epoch.
- sessions : workspace, producteur et capacités déclarées.
- events : enveloppe canonique, réception UTC, ingest_order autoincrémenté, contrainte
  unique producteur/epoch/séquence et index session/ordre.
- causal : enfant existant, parent éventuellement absent ; l’absence est exposée.
- blobs : hash primaire, octets, taille ; manifests : hash primaire, JSON canonique.
- manifest_entries : références étrangères vers manifeste et blob.
- checkpoints : workspace, timeline, parent, manifeste, borne d’ingestion, métadonnées.
- timelines : projet, workspace optionnel, tête.

Des triggers interdisent update/delete sur événements, liens causaux, blobs,
manifests, entrées et checkpoints. Les timelines évoluent explicitement. Le créateur
publie blobs, manifeste, références, checkpoint et tête en une transaction courte.
Aucun GC. La migration 2 ajoute :

- attachments : hash référençant blobs, type MIME ; event_attachments : références
  contrôlées des événements v2 vers les contenus existants.
- actions : projection persistée des événements action/tool, clé session/id et index
  external_tool_id. Elle est recalculable ; les événements sources restent immuables.
- provenance : événement source, checkpoint/fichier destination, relation, méthode et
  certitude explicit/correlated/unknown. Ces liens sont append-only.
- operations : reçu immuable d’un checkpoint publié, avec identité de la requête.

Les projections d’actions existantes sont créées dans la même transaction que la
migration. Une interruption laisse le schéma précédent ou le nouveau, jamais la moitié.
La version 2 d’export inclut ces tables ; l’import v1 reconstruit les projections anciennes.
Les actions tardives ne rouvrent pas un résultat terminal. Deux résultats contradictoires
produisent conflicted ; une attribution contradictoire reste unknown. Un parent absent
reste pending. Les cycles résolus sont rejetés avec rollback du lot.

## ADR 004 : Linux d’abord et matérialisation séparée

La lecture utilise des descripteurs de répertoire Linux et O_NOFOLLOW à chaque étape
pour éviter une redirection de contenu via un parent remplacé par un symlink.
La cible de restauration est toujours nouvelle. Pas de reset Git, pas de restauration
en place, pas de worktree implicite. Le diff décrit ajouts/suppressions/modifications ;
il ne prétend pas reconnaître l’identité d’un renommage.
