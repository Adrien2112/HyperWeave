# Durabilité et récupération

SQLite WAL + synchronous=FULL + foreign_keys=ON sont activés et relus au démarrage.
La durabilité suppose un filesystem local respectant fsync et les garanties SQLite.
Pas de revendication supplémentaire de résistance matérielle aux pannes électriques.
Ne placer ni l’archive ni l’outbox sur un partage réseau non validé.

Un SIGKILL avant commit annule la transaction ; après commit, une retransmission
identique reçoit un succès idempotent. Ces deux frontières sont testées avec un vrai
processus tué, pas seulement des mocks. Le processus mort laisse `writer.lock`.
Après vérification de sa mort, `recover-lock --archive PATH` refuse un PID encore
présent et enlève le verrou seulement si le PID est absent. La réutilisation de PID
peut imposer une inspection manuelle. Ne lancer qu’une récupération à la fois.
Un verrou illisible reste bloqué pour inspection. Aucune suppression aveugle au startup.

Après récupération : démarrer le daemon, exécuter `verify`, retransmettre l’outbox.
Les actions dont aucun résultat terminal n’a été archivé restent `open-or-interrupted` ;
le moteur ne fabrique pas de résultat. Les processus et fichiers externes ne sont pas
contrôlés par le verrou d’archive.

`backup --target nouveau.sqlite` utilise l’API SQLite de sauvegarde d’une base active,
WAL inclus de façon cohérente. Ne copier jamais seulement archive.sqlite pendant
l’activité. Pour examiner une sauvegarde arrêtée, créer un répertoire privé, y placer
le backup comme `archive.sqlite`, puis utiliser `verify --offline` sur ce répertoire.
La cible de backup doit être absente. Le résultat est écrit dans un staging privé,
fsync, puis publié exclusivement par lien dur sur le même filesystem. Un crash avant
publication peut laisser `.hyperweave-file-*`, à inspecter hors activité ; il ne publie
pas une sauvegarde partielle sous le nom final. Même protocole pour les exports.
Le nom final, s’il est présent après une interruption, doit être vérifié avant réessai.

`verify` contrôle SQLite, clés étrangères, hashes/tailles de blobs, manifests,
références, enveloppes/index et graphes causaux. Une corruption ne déclenche pas une
réparation silencieuse. Conserver l’archive et restaurer une sauvegarde vérifiée
vers un emplacement séparé. Aucun garbage collector ni suppression automatique.

La suite teste également les SIGKILL avant/après commit de la migration v1→v2 et de
la réservation d’outbox, ainsi qu’un crash après commit d’archive avant retrait de
l’outbox. Quatre processus produisent simultanément dans la même outbox pour vérifier
l’unicité des séquences. Les checkpoints avec operation_id retrouvent leur reçu après
redémarrage. Les reçus sont inclus dans l’export et contrôlés par verify.

Les points de publication de backup/export sont testés sur erreur injectée et conflit
de destination. Un SIGKILL à chaque frontière de publication de ces fichiers reste un
test à ajouter ; ne confondre ni ces tests ni ceux de SQLite avec une coupure électrique.
