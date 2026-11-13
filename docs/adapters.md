# Adaptateur synthétique et SDK

`npm run demo` est le producteur de référence, indépendant de tout éditeur. Il décrit
ses événements normalisés et utilise Outbox puis le protocole local. Capacités exercées :
messages explicites, début/fin d’outil synthétique et résultat volumineux en pièce jointe. Il ne prétend pas observer un vrai
agent, des sous-agents, une annulation ou la conversation interne d’un éditeur.

`Outbox(filename, producer)` crée une petite base SQLite séparée. L’epoch et le prochain
numéro sont persistés avec l’événement dans la même transaction AVANT tout envoi.
Une perte de ce fichier conduit à un nouvel epoch. L’outbox ne connaît aucune table du
cœur. `flush(send)` transmet un lot borné, vérifie le reçu durable et ne supprime les
lignes qu’après accusé. L’accusé perdu laisse les événements à retransmettre. Limite
10 000 événements en attente ; pas de journal additionnel à faire tourner. Le compactage
de la base outbox et une stratégie automatique de retry/backoff restent à ajouter.

Le SDK n’envoie aucun trafic à lui seul : la fonction send fournie par l’appelant
utilise le transport choisi. La démonstration utilise le socket Unix. Les hooks futurs
ne doivent pas appeler createCheckpoint pour chaque lecture de fichier. Les effets
externes resteront associés avec une certitude explicite, sans attribution inventée.

`tests/fixtures/ingest-v1.json` est une fixture de forme ; remplacer son session_id par
celui d’une session créée avant usage CLI. Le contenu de payload reste une donnée.

Le SDK produit des événements v2. Pour les pièces jointes, appeler putAttachment avant
d’enregistrer l’événement référent dans l’outbox. Cette préparation n’est pas encore
encapsulée dans le SDK : un producteur hors connexion doit conserver son contenu brut
jusqu’au retour du daemon. Un événement référant un contenu absent est rejeté atomiquement.
Le daemon maintient son statut et applique la backpressure pendant les captures ; une
outbox conserve les événements lorsque le transport répond WORKSPACE_BUSY.
