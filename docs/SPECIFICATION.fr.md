Tu es un agent d’ingénierie chargé de concevoir et d’implémenter un moteur local d’archivage de contexte de développement, inspiré des capacités de DeltaDB. Travaille dans le dépôt fourni et réalise une première version utilisable et testée.

Le produit comporte deux couches strictement indépendantes : un cœur générique qui archive événements, messages, actions et versions de fichiers ; des adaptateurs optionnels qui raccordent des outils comme Cursor. Le cœur doit fonctionner sans Cursor, sans LLM, sans compte, sans réseau et sans service distant.

Ce document est une spécification proposée, pas une reproduction du code privé de DeltaDB. Les interfaces externes mentionnées doivent être vérifiées avant utilisation. Le nom de travail est Context Archive ; choisis un identifiant de paquet adapté au dépôt sans renommer un projet existant.

Commence par inspecter le dépôt, ses instructions et ses conventions. Présente brièvement les décisions, puis implémente. Ne t’arrête pas à un plan ou à des interfaces vides. Si le travail dépasse une session, termine un incrément fonctionnel, garde un état de reprise précis et distingue les critères validés de ceux restant à traiter. Ne sollicite une clarification que pour un blocage réel ; les choix par défaut ci-dessous permettent de commencer.

# 1 Objectif et limites

Livrer une application locale permettant de :

- enregistrer une activité de développement sous forme d’événements immuables ;

- associer messages, appels d’outils, résultats et changements observés ;

- créer des checkpoints restaurables sans commit utilisateur ;

- consulter la chronologie, comparer deux versions et retrouver l’action associée à une modification ;

- matérialiser une version dans un répertoire séparé ;

- explorer une variante dans une nouvelle timeline ;

- préparer un contexte de reprise pour un agent ;

- exporter, importer et sauvegarder ses archives ;

- ajouter Cursor sans modifier le cœur.

Le MVP suppose un écrivain logique par workspace. Plusieurs workspaces peuvent fonctionner en parallèle. Plusieurs producteurs d’événements ne signifient pas plusieurs écrivains simultanés des mêmes fichiers.

Hors périmètre initial : CRDT maison, réplication entre machines, collaboration temps réel, provenance au caractère, suivi sémantique garanti des renommages, interface web complète, orchestration autonome d’agents, exécution automatique des commandes archivées.

Le système archive des observations. Il ne prétend ni récupérer le raisonnement interne d’un modèle, ni reconstituer exactement son contexte effectif, ni rejouer ses décisions à l’identique. Une restauration de fichiers ne restaure pas une base de données externe, un processus, un conteneur, des dépendances exclues ou une conversation interne à un outil tiers.

# 2 Architecture et dépendances autorisées

Si le dépôt impose une stack, respecte-la et documente les adaptations. Sinon, utilise TypeScript strict, une version Node.js LTS maintenue et SQLite avec un binding maintenu compatible avec cette version. Vérifie les versions avant de les figer et fournis un lockfile. Évite les dépendances natives non nécessaires.

Sépare au minimum :

- packages/core : domaine, validation, ingestion, checkpoints, requêtes, export et reprise ;

- packages/storage-sqlite : schéma, migrations, transactions et sauvegarde ;

- packages/workspace-fs : capture et matérialisation des fichiers ;

- packages/protocol : enveloppes versionnées, schémas et erreurs ;

- packages/daemon : sérialisation des accès et transport local ;

- packages/cli : interface utilisateur et sorties JSON ;

- packages/adapter-sdk : file d’attente durable et contrats d’adaptateur ;

- extensions/cursor : traduction et installation des hooks ;

- tests/fixtures et docs.

La séparation peut être organisée autrement si le dépôt l’exige, mais les dépendances doivent rester explicites. Aucun import de extensions/cursor dans le cœur, le stockage, le protocole ou les opérations workspace. Aucun champ obligatoire nommé d’après Cursor dans le domaine.

Le cœur reçoit des événements normalisés. Il ne lit pas une base interne de Cursor. L’adaptateur peut dépendre des contrats publics du cœur, jamais de ses tables privées.

Ne crée pas de plugin loader exécutant des modules arbitraires. Pour le MVP, un adaptateur est un producteur externe qui utilise le protocole local. Aucune installation de connecteur n’est requise pour utiliser les fonctions d’archivage.

# 3 Contrats de domaine

Utilise des identifiants opaques stables, un schéma versionné et une représentation déterministe des données hachées. Documente les limites de taille. Les dates sont en UTC pour les échanges ; elles ne définissent jamais seules la causalité.

Entités minimales :

| Entité | Champs et responsabilités |
| - | - |
| Project | id, nom, emplacement d’origine, paramètres de capture |
| Workspace | id, project_id, racine locale, statut, politique, epoch |
| Session | id, workspace_id, producteur, external_session_id optionnel, capacités déclarées |
| Event | id, schema_version, type, producer_id, producer_epoch, sequence, session_id, external_id optionnel, occurred_at optionnel, ingested_at, ingest_order, causal_parents, payload |
| Action | id, session_id, parent_action_id optionnel, external_tool_id optionnel, type, statut, événements associés, checkpoints avant et après |
| Checkpoint | id, workspace_id, timeline_id, parents, manifest_hash, event_cut, qualité de capture |
| Timeline | id, project_id, workspace_id optionnel, head_checkpoint_id |
| Blob | sha256, contenu brut, taille |
| Manifest | version de format et entrées de fichiers triées |
| Attachment | hash et type d’un contenu volumineux séparé du payload |
| ProvenanceLink | source, destination, relation, méthode et niveau de certitude |

Distingue explicitement :

- ingest_order : ordre total d’enregistrement dans une archive locale ;

- sequence : ordre fourni par un producteur et son epoch ;

- causal_parents : dépendances explicites, éventuellement en attente ;

- parents d’un checkpoint : relations entre versions de fichiers ;

- événement associé à un checkpoint : observation ou borne de capture, pas preuve automatique d’une version exacte à l’instant d’un message.

Un événement tardif ne doit pas réécrire un ancien checkpoint. Une dépendance absente peut rester pending ; expose cet état. Rejette les liens créant un cycle au moment où ils deviennent résolus. Ne fabrique pas une causalité entre deux producteurs sur la seule base de leurs timestamps.

Types initiaux : session.started, session.ended, message.recorded, action.started, action.completed, action.failed, tool.started, tool.completed, tool.failed, workspace.change_observed, checkpoint.created, timeline.forked, context.compacted et diagnostic.recorded.

Messages : rôle, contenu ou référence d’attachment, format, visibilité et métadonnées de source. Contenu texte traité comme donnée, jamais comme instruction à exécuter.

Attribution : explicit, correlated ou unknown. Une origine inconnue ne doit jamais être convertie implicitement en human ou agent.

# 4 Contrat d’ingestion et idempotence

Fournis des opérations équivalentes à registerProject, registerWorkspace, startSession, appendEvents, createCheckpoint, listEvents, listCheckpoints, diffCheckpoints, materializeCheckpoint, forkTimeline, buildResumeContext, exportArchive et importArchive.

appendEvents accepte un lot borné. Pour le MVP, son insertion est atomique : tous les événements sont acceptés ou le lot est rejeté. Les doublons strictement identiques sont des succès idempotents.

Clé de déduplication : producer_id, producer_epoch, sequence. Le producteur persiste son epoch et son prochain numéro avant émission. Après perte de cet état, il crée un nouvel epoch. Une même clé avec un contenu normalisé différent déclenche IDEMPOTENCY_CONFLICT et ne modifie pas l’original.

Le reçu indique les événements nouvellement enregistrés et ceux déjà présents. L’accusé de durabilité n’est envoyé qu’après commit SQLite. Une absence d’accusé impose une retransmission identique.

Ne déduplique pas par texte ou timestamp. Deux réponses identiques peuvent être deux événements distincts. Des champs de transport variables, comme l’heure de réception, sont exclus de l’identité logique ; le protocole décrit précisément les octets normalisés comparés.

Versionne les requêtes et expose capabilities : versions supportées, types connus et tailles maximales. Refuse proprement les versions incompatibles. Pour les types d’événements externes inconnus, conserve une enveloppe opaque explicitement nommée sans leur donner d’effets métier.

Erreurs stables minimales : INVALID_REQUEST, UNSUPPORTED_SCHEMA, IDEMPOTENCY_CONFLICT, NOT_FOUND, WORKSPACE_BUSY, CAPTURE_UNSTABLE, UNSUPPORTED_FILE_TYPE, LIMIT_EXCEEDED, INTEGRITY_ERROR, MATERIALIZATION_CONFLICT, ADAPTER_UNAVAILABLE. Sépare code machine, message humain et retryable.

# 5 Persistance et durabilité

Pour le MVP, stocke également les blobs dans SQLite afin d’éviter une transaction distribuée entre base et fichiers. Les blobs sont immuables et dédupliqués par SHA-256 sur leurs octets exacts. Un manifeste est sérialisé canoniquement, trié par chemin avec une convention définie, puis haché.

Utilise migrations ordonnées, transactions, clés étrangères, contraintes uniques et index sur les principaux parcours : session et ordre, workspace et checkpoints, identifiant externe d’outil, clé d’idempotence. Vérifie explicitement la configuration SQLite de durabilité retenue ; ne promets pas de résistance à une panne électrique sans hypothèses documentées.

La transaction publiant un checkpoint contient toutes ses références valides vers les blobs et le manifeste. Aucun checkpoint visible ne référence un contenu manquant. Les lectures ne doivent jamais observer une publication partielle.

Une capture de fichiers se déroule avant la transaction courte de publication. Évite de garder le verrou d’écriture SQLite pendant un scan complet du disque. Ne confonds pas atomicité de publication et atomicité de lecture du filesystem.

Conserve les événements sources nécessaires au diagnostic avec une politique explicite de minimisation. Les grosses sorties et pièces jointes deviennent des attachments. Les limites produisent soit une omission explicitement signalée pour une capture partielle, soit un rejet en mode strict ; jamais une troncature silencieuse.

Pas de suppression automatique de blobs au MVP. Fournis statistiques et vérification d’intégrité. Si un garbage collector est ajouté, il doit tenir compte des checkpoints, attachments et opérations en cours, avec période de grâce et tests de crash.

Les sauvegardes utilisent une méthode SQLite cohérente, par exemple son API de backup. Ne copie pas naïvement le seul fichier principal d’une base active en mode WAL.

# 6 Capture des fichiers et politique de couverture

Le système capture les octets de fichiers réguliers, y compris binaires, les créations et suppressions, ainsi que le bit exécutable lorsque pertinent. Politique MVP pour les liens symboliques : ne jamais les suivre ; les signaler comme non pris en charge et les traiter selon le mode strict ou partiel. Les autres fichiers spéciaux sont également rejetés ou omis explicitement.

Définis un périmètre : fichiers suivis par Git et fichiers non suivis non ignorés, plus règles d’exclusion propres à l’archive. Un fichier suivi reste inclus même s’il correspond désormais à une règle ignore, sauf exclusion explicite de notre produit. Hors Git, utilise une politique déclarée et testable.

Exclus le stockage du moteur, .git et les chemins sensibles configurés. Prévois un affichage de la couverture avant le premier checkpoint. Les règles ont une empreinte enregistrée dans chaque checkpoint.

Valeurs de départ configurables : limite par fichier 32 Mio et limite de capture totale 512 Mio. Ces valeurs sont des choix du projet, à documenter et ajuster après mesure. Aucune exclusion volumétrique silencieuse.

Le manifeste contient au minimum chemin relatif, type, mode utile, hash et taille. Il enregistre aussi les exclusions et anomalies de couverture de façon exploitable. Les fins de ligne et encodages sont préservés octet pour octet.

Les chemins sont relatifs à la racine et validés. Rejette les chemins absolus, traversées, NUL, collisions de normalisation et collisions de casse sur une cible qui ne peut pas les représenter. Ne modifie pas silencieusement les noms. Prends en compte les remplacements de répertoires et les liens introduits pendant une opération.

Git est une intégration workspace optionnelle : relève HEAD, l’état utile et les limites du périmètre ; ne modifie ni index ni branches utilisateur pendant une capture. Le moteur doit pouvoir archiver un dossier sans Git.

La surveillance filesystem sert à repérer des candidats, pas à établir une vérité exhaustive. Ajoute une réconciliation complète au démarrage, après débordement du watcher et aux bornes de capture demandées. Ne capture pas chaque frappe non sauvegardée par ce seul mécanisme.

# 7 Cohérence des checkpoints

Expose au moins deux niveaux honnêtes :

- observed : état constitué des fichiers lus pendant une fenêtre de capture, sans garantie d’instantané global ;

- quiescent : état obtenu alors que les écrivains connus sont arrêtés, avec inventaire et vérifications répétées stables.

En l’absence de snapshot filesystem ou de contrôle de tous les écrivains, même quiescent dépend d’une hypothèse de coopération. Indique cette hypothèse dans les métadonnées et la documentation.

Pendant une capture : inventorie, lis en vérifiant la stabilité des fichiers, refais l’inventaire et les contrôles nécessaires, puis retente de façon bornée si la source change. Le simple couple taille/mtime ne prouve pas l’absence de modification ; utilise les hashes aux bornes où une garantie plus forte est demandée. Après dépassement, retourne CAPTURE_UNSTABLE ou publie un checkpoint observed seulement si le demandeur l’a explicitement autorisé.

Enregistre début et fin de capture, borne d’événements ingérés, actions connues en cours, exclusions et anomalies. Une borne d’ingestion ne garantit pas que tous les événements externes précédents ont été livrés.

Autorise des checkpoints au début et à la fin d’un tour. Les checkpoints par outil sont optionnels : plusieurs outils parallèles ne doivent pas recevoir des états avant/après fictivement exclusifs.

Les changements sur disque non corrélés à un outil restent d’origine inconnue. La provenance doit pouvoir être raffinée par un lien ultérieur sans réécrire le fait source.

# 8 Restauration et branches

La matérialisation dans un nouveau répertoire est la voie par défaut. L’opération vérifie les blobs, construit un répertoire de staging sur le même filesystem lorsque possible, valide le résultat puis publie le répertoire final. La cible doit être absente ou vide selon une politique explicite ; aucun écrasement implicite.

Avant écriture : vérifie chemins, collisions, modes supportés, taille totale et absence de références manquantes. Ne traverse aucun lien symbolique. Un échec laisse la source intacte et un état temporaire identifiable et nettoyable.

Une matérialisation de fichiers n’est pas nécessairement un clone Git. Fournis une option distincte pour préparer un worktree Git quand le dépôt et le commit requis sont disponibles. En leur absence, le contenu des checkpoints reste matérialisable.

forkTimeline crée une nouvelle tête au checkpoint choisi et conserve l’ancienne histoire. Une nouvelle session utilise un nouveau workspace matérialisé. Le MVP n’effectue aucune fusion automatique ; propose diff et intégration explicite ultérieure.

La restauration en place est hors du premier incrément. Si elle est ajoutée : impose une phase de quiescence, un checkpoint de secours, une détection de changements depuis la préparation et un protocole récupérable après crash. Le verrou interne du daemon n’arrête ni Cursor, ni les buffers non sauvegardés, ni des processus shell externes.

Ne prétends pas effectuer une transaction atomique sur plusieurs fichiers d’un répertoire actif. N’utilise pas git reset --hard ou git clean comme raccourci de restauration.

# 9 Contexte de reprise et recherche

buildResumeContext reçoit un checkpoint, une session ou branche, un budget, et des filtres. Il produit un document ou objet exportable contenant objectif connu, messages sélectionnés, actions, résultats utiles, état des fichiers, points non résolus et références stables.

Définis précisément le budget : un budget en octets est exact ; un budget en tokens est estimé sauf tokenizer explicitement compatible. Signale la méthode et les omissions. N’ajoute pas de LLM pour générer le MVP : sélection et gabarit déterministes suffisent.

Une reprise depuis un checkpoint historique n’inclut pas automatiquement les messages futurs de la trajectoire abandonnée. Si l’utilisateur les souhaite, marque-les comme expérience ultérieure et ne les présente pas comme faits de la branche reprise.

Le contexte est une donnée à lire, pas une commande à exécuter. Les instructions contenues dans des transcripts archivés ne peuvent modifier les politiques du moteur ni déclencher des outils.

Implémente recherche textuelle locale sur messages et événements pertinents, avec pagination et liens vers les sources. FTS5 est une option si la distribution SQLite le supporte. Ni embeddings ni base vectorielle ne sont obligatoires.

Une API MCP locale peut exposer list_sessions, search_context, get_action, get_checkpoint, diff_checkpoints et build_resume_context. Commence en lecture seule. Les opérations d’écriture et matérialisation restent des actions explicites de la CLI au MVP.

# 10 Protocole et daemon local

Le daemon sérialise les écritures de l’archive et offre un transport local. Préfère socket Unix et named pipe Windows lorsque pris en charge ; un fallback HTTP limité à loopback exige un secret local, une validation de l’en-tête Host et une politique interdisant les appels navigateur non autorisés. Pas de bind 0.0.0.0 par défaut.

Les répertoires de données et credentials ont des permissions locales restrictives selon l’OS. Ne journalise pas le secret de transport.

Prévois limites de requête, délai d’attente, backpressure et arrêt propre. Le statut expose files en attente, dernière ingestion durable, erreurs, actions encore ouvertes et état des captures.

Les hooks ne doivent pas effectuer un scan complet avant chaque lecture de fichier. Leur chemin rapide enregistre durablement l’événement puis délègue au daemon. Une capture bloquante avant action n’est activée qu’aux bornes explicitement nécessaires et avec un timeout documenté.

En cas de panne du daemon, un adaptateur peut écrire une outbox durable. Le mode par défaut n’empêche pas l’utilisateur de travailler mais marque la capture comme dégradée ; un mode strict peut bloquer une action seulement si le hook externe le permet. Ne promets pas un blocage pour les hooks fire-and-forget.

Évite deux chemins d’écriture concurrents vers l’archive : CLI et adaptateurs passent par le service propriétaire, ou un mode hors ligne explicite obtient une exclusivité vérifiable.

# 11 SDK des adaptateurs

Fournis un SDK léger et un adaptateur de référence synthétique sans dépendance à un éditeur. L’adaptateur annonce son nom, sa version, sa version de protocole et ses capacités réelles : prompts, réponses, outils, fichiers, résultats, sous-agents, annulation ou reprise.

Le SDK gère validation des enveloppes, attribution des séquences, outbox persistante, retransmission, reçus, délais et rotation des journaux. Pour un MVP, une petite base SQLite d’outbox peut être préférable à un JSONL partagé sans verrou ; si JSONL est utilisé, démontre sa résistance aux écritures concurrentes et aux interruptions.

L’état source brut utile est conservé dans une extension namespacée ou un attachment ; les métadonnées Cursor restent sous un namespace de producteur. Les vues du cœur consomment les champs normalisés.

Chaque adaptateur dispose de fixtures versionnées, tests de traduction et document de capacités. Une fonctionnalité externe absente doit être déclarée absente, jamais simulée comme garantie.

Le cœur et ses tests doivent fonctionner quand toutes les extensions sont supprimées du build. Ajoute un contrôle automatisé des frontières d’import.

# 12 Extension Cursor

Cette étape commence après le premier parcours complet du cœur avec l’adaptateur synthétique. Vérifie la documentation officielle et la version installée ; ne suppose pas une parité entre IDE, CLI, SDK et ACP.

Explore d’abord les hooks publics. Cartographie les événements disponibles vers le domaine : prompt vers message utilisateur, réponse vers message assistant, pré/post outil vers action, édition vers observation, arrêt vers fin de tour. Déduplique les événements génériques et spécialisés sans perdre leur payload source.

Si des identifiants de session, génération ou outil manquent, conserve l’événement comme non corrélé et émet un diagnostic. Ne rattache pas automatiquement l’événement à la dernière conversation ouverte.

Les commandes shell peuvent modifier un nombre inconnu de fichiers et lancer des processus qui survivent au hook de fin. afterFileEdit ne constitue donc pas une capture exhaustive. Utilise la réconciliation workspace ; documente les garanties d’attribution plus faibles en cas de concurrence.

Le transcript est une source optionnelle : chemin explicitement fourni ou sélectionné, lecture autorisée, parsing versionné et tolérant aux ajouts. Ne parcours pas les bases privées de Cursor, ne les modifie jamais et n’utilise pas leur format interne comme fondation. Ne suis pas un chemin arbitraire contenu dans un événement non authentifié.

Un installateur de hooks doit :

- présenter les changements en dry-run ;

- préserver les hooks existants ;

- sauvegarder la configuration originale ;

- être idempotent ;

- permettre une désinstallation ne retirant que nos entrées ;

- utiliser des chemins correctement échappés ;

- ne jamais envoyer de prompt ni lancer un agent lors de l’installation.

Prévois un mode facultatif CLI stream-json si les hooks IDE ne couvrent pas un usage. ACP ou SDK sont des adaptateurs distincts, pas une dépendance du cœur. Ils peuvent faciliter le contrôle des sessions, mais ne prouvent pas la restauration arbitraire d’un état de conversation.

Une reprise depuis une ancienne version doit préparer un nouveau workspace et un contexte explicite. N’annonce jamais que la conversation Cursor active a été rembobinée.

Le système d’archive reste local ; le traitement des requêtes LLM par Cursor suit ses propres modalités. Ne présente pas cette extension comme une garantie d’inférence hors ligne.

# 13 CLI et parcours attendus

Nom indicatif de commande : ctxarchive. Ajuste-le au dépôt si nécessaire.

Commandes minimales :

- init et workspace add : initialiser une archive et enregistrer un dossier ;

- ingest --input : ingérer un lot JSON versionné ;

- checkpoint create : capturer un workspace avec mode strict ou partiel explicite ;

- sessions list et events list : consulter avec pagination ;

- history : lister les checkpoints et leur qualité ;

- diff : comparer deux checkpoints ;

- materialize : reconstruire dans une nouvelle cible ;

- timeline fork : créer une branche historique ;

- context build : produire le contexte d’une reprise ;

- search : rechercher localement ;

- status et doctor : diagnostiquer ;

- export et import : transférer une archive ;

- backup et verify : sauvegarder et vérifier ;

- cursor install, cursor uninstall et cursor doctor : commandes optionnelles de l’extension.

Chaque commande documente effets, codes de sortie, format JSON stable et mode humain. Les commandes de lecture n’écrivent pas dans les workspaces. Les diagnostics ne doivent pas exposer les transcripts ou secrets par défaut.

Parcours de démonstration obligatoire : créer V0, ingérer un prompt synthétique, modifier deux fichiers, ingérer un résultat de test, créer V1, comparer V0 et V1, matérialiser V0, créer une variante, générer son contexte de reprise, exporter puis importer l’ensemble dans une archive vierge.

# 14 Export import sauvegarde et confidentialité

L’export est autonome pour le périmètre annoncé : événements, manifests, blobs et schémas nécessaires. Il ne dépend pas de l’existence future du dépôt Git source pour restaurer les fichiers inclus.

Format versionné avec inventaire, tailles et checksums. L’import valide l’ensemble avant publication, rejette les références manquantes et conflits d’identité et limite tailles, nombre de fichiers et décompression. Un hash prouve l’intégrité, pas l’identité d’un auteur ni l’authenticité d’un export.

Pour le MVP, importe dans une nouvelle archive vide. La fusion d’archives existantes peut être reportée : ne remappe pas silencieusement les identifiants.

Les payloads peuvent contenir du code et des secrets. Fournis des règles d’exclusion et un mode de capture minimal ; n’affirme pas détecter tous les secrets. Une transformation de masquage appliquée avant archivage doit être explicitement indiquée et ne doit pas corrompre les blobs nécessaires à une restauration annoncée exacte.

Si un fichier ne peut être archivé pour raison de politique, marque la couverture partielle ou échoue en mode strict. Un export de partage peut être expurgé, mais doit être distinct d’un export de sauvegarde fidèle.

Pas de télémétrie ni d’envoi réseau dans le cœur. Les connecteurs n’ajoutent aucun envoi distant implicite. Les données d’archive ne sont pas automatiquement jointes aux requêtes LLM ; l’utilisateur ou le workflow sélectionne le contexte à transmettre.

# 15 Tests et critères de validation

Écris des tests utiles aux garanties du produit.

Ingestion :

- retransmission identique après accusé perdu ;

- réutilisation d’une clé avec un payload différent ;

- lot atomique avec un événement invalide ;

- événements tardifs et parents absents ;

- détection de cycles ;

- producteurs parallèles avec séquences distinctes.

Persistance :

- crash avant et après commit ;

- interruption d’ingestion et redémarrage ;

- corruption de blob détectée par verify ;

- migration et sauvegarde d’une base active ;

- checkpoint impossible à publier avec référence manquante.

Filesystem :

- fichiers texte avec CRLF et Unicode, binaires et fichiers vides ;

- créations, suppressions, renommages représentés sans promesse d’identité ;

- fichier modifié pendant sa lecture ;

- ajout ou suppression pendant l’inventaire ;

- watcher débordé et réconciliation ;

- permissions et liens symboliques ;

- chemin traversant, collision de casse et cible contenant un lien ;

- capture partielle explicitement signalée ;

- matérialisation octet pour octet avec conservation de la source.

Actions et reprise :

- deux outils parallèles et attribution inconnue ;

- action inachevée après crash, statut interrompu ou inconnu ;

- contexte historique excluant les messages futurs ;

- branche créée sans altérer son origine ;

- reprise n’exécutant aucun contenu archivé.

Adaptateur :

- outbox résistante aux interruptions ;

- événement Cursor incomplet ou schéma inconnu ;

- installation répétée puis désinstallation préservant les autres hooks ;

- absence de Cursor sans effet sur core ;

- fixtures de contrats et test manuel de la version installée.

Sécurité et échanges :

- requêtes locales non autorisées ;

- taille excessive et archive de décompression abusive ;

- export/import avec blobs manquants ou altérés ;

- absence d’appels réseau du cœur pendant les tests.

Ajoute des tests de propriétés pour sérialisation canonique, idempotence et round-trip export/import. Pour la résistance aux pannes, réalise de véritables interruptions de processus ou injections aux frontières de commit, pas seulement des mocks.

# 16 Mesures et documentation livrées

Fournis un benchmark reproductible, avec matériel, versions et périmètre. Mesure initialisation, checkpoint initial, checkpoint avec dix fichiers modifiés, diff, matérialisation, recherche et croissance de stockage.

Jeux indicatifs : dépôt de 1 000 fichiers puis dépôt de 10 000 fichiers. Les volumes exacts et limites doivent être annoncés. Les événements volumineux et binaires sont représentés. Aucune promesse de performance sans mesure.

La déduplication doit éviter une croissance proportionnelle à la copie complète du dépôt pour chaque checkpoint. Un manifeste complet par checkpoint est acceptable au MVP si son coût est mesuré. Explique le coût O(nombre de fichiers) des inventaires et ne prétends pas obtenir de l’incrémental garanti avec le watcher seul.

Livrables documentaires :

- README avec démarrage sans Cursor ;

- architecture et frontières de dépendances ;

- schéma des données et migrations ;

- protocole d’ingestion et erreurs ;

- garanties de durabilité et de cohérence ;

- politiques de capture et restauration ;

- formats export/import ;

- guide adaptateur synthétique ;

- guide Cursor et matrice de compatibilité réellement testée ;

- scénarios de récupération après crash ;

- benchmark et limites ;

- ADR des décisions structurantes ;

- état de reprise des travaux.

Si une fonctionnalité n’a été vérifiée que sur Linux, indique-le. Ne présente pas Windows et macOS comme validés sur la seule base d’abstractions multiplateformes.

# 17 Ordre de réalisation

Phase 0 : inspection du dépôt, décisions et contrats. Produis une courte architecture, les ADR indispensables et les schémas. Établis un exécutable de test sans Cursor.

Phase 1 : cœur vertical. Implémente stockage, ingestion idempotente, adaptateur synthétique, capture, deux checkpoints, diff et matérialisation. Le parcours bout en bout doit fonctionner avant tout connecteur réel.

Phase 2 : fiabilité et usages. Ajoute outbox, reprise après crash, branches, contexte de reprise, recherche, export/import et backup. Termine les tests d’intégrité et de frontières d’import.

Phase 3 : extension Cursor. Vérifie les capacités disponibles, crée les fixtures, implémente hooks et installation réversible, puis teste le parcours avec un vrai agent. Si Cursor est absent, livre l’extension testée sur fixtures et identifie le test réel restant, sans bloquer le cœur.

Phase 4 : consolidation. Benchmarks, documentation, packaging et commandes de diagnostic. N’ajoute ni réplication réseau ni CRDT avant validation du besoin.

Continue les phases réalisables dans l’environnement autorisé. Un manque d’accès à Cursor ou au réseau ne justifie pas l’arrêt des travaux indépendants.

Pour chaque phase, précise ce qui fonctionne, les commandes de reproduction et les limites restantes. Mets à jour le plan si l’inspection du dépôt révèle une contrainte réelle.

# 18 Définition de terminé

Le MVP est terminé lorsque :

- une installation propre lance la CLI et le daemon ;

- toutes les fonctions du cœur fonctionnent sans extension et sans réseau ;

- la démonstration synthétique archive messages et changements puis restaure les fichiers inclus à l’identique ;

- une retransmission n’ajoute aucun doublon ;

- les captures partielles ou instables sont visibles ;

- un crash ne laisse aucun checkpoint publié invalide ;

- une branche et son contexte de reprise n’altèrent pas l’historique initial ;

- export et import recréent les versions dans une archive vierge ;

- les tests essentiels et le contrôle des dépendances passent ;

- l’extension Cursor est installable séparément et annonce ses capacités réelles ;

- les limites de restauration de la conversation et des effets externes sont documentées ;

- les mesures et instructions de reproduction sont fournies.

La réponse finale de l’agent doit présenter implémentation réalisée, commandes de lancement, tests exécutés avec résultats, limites, fonctionnalités non terminées et prochaine action concrète. Ne dis pas « prêt pour la production » sans critères supplémentaires définis et vérifiés.

# 19 Références de conception

Ces sources sont des pistes de vérification, pas des dépendances obligatoires ni une garantie que les interfaces restent identiques.

- Architecture DeltaDB : [https://delta.dev/blog/fine-grained-version-control-for-agents](https://delta.dev/blog/fine-grained-version-control-for-agents)

- Hooks Cursor : [https://cursor.com/docs/hooks](https://cursor.com/docs/hooks)

- Format de sortie CLI Cursor : [https://cursor.com/docs/cli/reference/output-format](https://cursor.com/docs/cli/reference/output-format)

- ACP Cursor : [https://cursor.com/docs/cli/acp](https://cursor.com/docs/cli/acp)

- SDK Cursor : [https://cursor.com/docs/sdk/typescript](https://cursor.com/docs/sdk/typescript)

- Eg-walker : [https://arxiv.org/abs/2409.14252](https://arxiv.org/abs/2409.14252)

- Référence pédagogique Eg-walker : [https://github.com/josephg/eg-walker-reference](https://github.com/josephg/eg-walker-reference)

Si tu consultes ces références, ne transforme pas une capacité documentée pour un runtime en garantie pour tous les runtimes. Conserve les versions testées et les observations dans la matrice de compatibilité.

Démarre maintenant par l’inspection du dépôt, puis réalise la première tranche verticale du cœur.
