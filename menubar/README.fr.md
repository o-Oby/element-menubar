# Element Menu Bar

Application personnelle macOS Apple Silicon, issue d’Element Web/Desktop. Le fork public est
<https://github.com/o-Oby/element-menubar>, branche `codex/macos-menubar`.

## Remplacer l’application Element existante

La variante actuelle, à partir de la révision 2 de `v1.12.33`, est livrée sous le nom **Element.app**.
Elle remplace `/Applications/Element.app` et réutilise le profil
`~/Library/Application Support/Element`. Elle conserve l’identifiant `im.riot.app` et les liens
`io.element.desktop` / `element` pour rester compatible avec les lanceurs macOS existants.
La première livraison `v1.12.33-r1`, nommée **Element Menu Bar.app**, était une application séparée :
ne pas utiliser ce DMG pour ce remplacement.

Le script **Mettre à jour Element Menu Bar.command** effectue désormais ce remplacement, la sauvegarde et
la relance. Il est configuré pour ce Mac Apple Silicon, avec `/Applications/Element.app`, le profil par défaut
et le lanceur `/Applications/Element (Proton).app` déjà installé.

Pour une installation manuelle, quitter complètement Element, sauvegarder l’application et son profil, puis
remplacer **Element.app** depuis le DMG. Relancer avec **Element (Proton)** pour conserver les réglages du tunnel.

Le nom `Element` permet de retrouver le profil et le service existant du trousseau macOS.
La signature du fork étant différente, macOS peut demander à l’utilisateur d’autoriser cet accès.
Ne pas extraire ni déplacer les secrets du trousseau. Si l’application propose d’effacer les données,
de réinitialiser le stockage ou d’utiliser du stockage en clair, annuler et examiner le problème avant de continuer.
La reprise de session dépend de l’accès au trousseau ; elle n’est pas garantie par la seule copie de l’application.

La construction personnelle possède une signature ad hoc, sans notarisation Apple. Si macOS demande une
confirmation à la première ouverture, utiliser clic droit → Ouvrir ou Réglages Système → Confidentialité et sécurité → Ouvrir quand même.

Pour revenir à l’installation sauvegardée, quitter toutes les instances, conserver à part le profil actuel,
puis restaurer **l’application et le profil sauvegardés ensemble**. Une version plus récente peut avoir fait
évoluer les données locales ; remettre uniquement l’ancien `.app` ne suffit pas à garantir un retour en arrière.

## Utilisation

- Fenêtre ouverte : Element figure dans le Dock.
- Bouton rouge ou `⌘W` : la fenêtre disparaît, la connexion reste active et l’icône du Dock disparaît.
- Icône dans la barre de menus → **Afficher/Masquer** : retrouver la fenêtre et le Dock.
- **Quitter** ou `⌘Q` : arrêter réellement l’application.
- Minimiser avec le bouton jaune et masquer avec `⌘H` conservent le comportement macOS habituel.

Le réglage existant d’affichage de l’icône de zone de notification est disponible sur macOS et activé par défaut.
Le désactiver rétablit l’accès par le Dock. Si Element est épinglé au Dock, décocher « Garder dans le Dock »
pour que son icône puisse disparaître à la fermeture. Le démarrage à l’ouverture de session reste facultatif dans les réglages.

## Mettre à jour sans perdre le fork

Double-cliquer **Mettre à jour Element Menu Bar.command** dans le dossier du projet, puis laisser le terminal
travailler. Le script :

1. Récupère la dernière version stable officielle et fusionne ses sources avec celles du fork.
2. Vérifie le client Web signé correspondant, exécute les contrôles et construit le DMG.
3. Publie les sources validées dans le fork GitHub, puis vérifie le DMG et l’application à installer.
4. Demande à Element de quitter, puis sauvegarde et vérifie l’application actuelle et son profil complet.
5. Remplace `/Applications/Element.app`, conserve le profil à sa place et relance **Element (Proton)**.
6. Vérifie les arguments de lancement du proxy, de résolution DNS et de WebRTC, puis ouvre le dossier du DMG.

Element peut rester ouvert pendant la compilation. La fermeture intervient au moment de l’installation :
prévoir la coupure temporaire des conversations et des appels en cours. Si Element affiche une confirmation
de fermeture, la valider pour poursuivre. Le script attend au maximum 45 secondes et ne force jamais l’arrêt
d’un processus. En cas d’annulation ou de délai dépassé, il s’arrête avant le remplacement.

Les sauvegardes datées se trouvent dans
`~/Library/Application Support/Element Fork Backups/<date-identifiant>`.
Chaque sauvegarde contient l’ancienne application, le profil complet et les informations de l’installation.
Le dossier est privé, accessible uniquement à votre compte. Son emplacement est indiqué dans le terminal ;
les sauvegardes restent sur ce Mac et ne sont jamais publiées sur GitHub. Elles sont conservées pour permettre
un retour en arrière et peuvent prendre de la place.

Si la livraison vérifiée est déjà installée, le script évite une nouvelle sauvegarde et un remplacement
inutile ; il s’assure qu’Element est lancé via Proton. Une livraison déjà construite et encore valide est
réutilisée. Deux lancements simultanés du script ne peuvent pas installer en parallèle.

Le programme de mise à jour officiel intégré à Element reste désactivé dans cette variante, même en présence
d’une configuration utilisateur. Les nouvelles versions passent par ce script afin de conserver les modifications
du fork. Le script n’exporte aucun secret du trousseau et ne réinitialise pas les données Matrix.
Une éventuelle demande macOS d’accès au trousseau doit être traitée par vous ; aucun mot de passe Matrix
ni clé de récupération n’est nécessaire pour compiler ou installer la mise à jour.

En cas de réussite, le script se termine. En cas d’erreur, le terminal reste ouvert avec le diagnostic et attend
Entrée avant de se fermer. Aucun déplacement manuel du fichier `.app` n’est nécessaire lors d’une mise à jour réussie.

Pré-requis : Xcode et ses outils de ligne de commande, Git, GnuPG (`brew install gnupg`) et un accès GitHub
en écriture au fork (`gh auth setup-git` si nécessaire). Node et pnpm sont téléchargés aux versions prescrites
par le dépôt dans `~/Library/Caches/ElementMenuBar/toolchains`, sans changer les versions système.
Les dépendances sont installées avec le fichier de verrouillage officiel.

## Si une mise à jour échoue

Un conflit de fusion ou un échec de compilation ne modifie pas l’application installée et ne publie pas une
nouvelle branche validée. Un conflit nécessite une adaptation du fork ; il n’est jamais résolu en écrasant
automatiquement nos modifications.

Le terminal indique le dossier de préparation conservé. Ses journaux et son emplacement sont enregistrés dans
`.git/menubar-updates`. Partager ces diagnostics pour faire corriger le conflit ou l’échec, puis relancer le script.
Un échec de publication GitHub conserve aussi la préparation validée. Ne pas utiliser `git reset --hard`,
un push forcé ou une réinitialisation du profil pour résoudre un problème de préparation.

Une erreur de sauvegarde empêche le remplacement. Si le remplacement échoue avant la relance, le script remet
l’ancienne application en place. Si la relance ou la vérification Proton échoue, il conserve les sauvegardes et
le profil actuel et indique le problème : une nouvelle application peut déjà avoir fait évoluer le profil.
Il ne restaure donc pas automatiquement d’anciennes données par-dessus ce profil.

À ce stade, les sources validées peuvent déjà être publiées sur GitHub et le nouveau DMG reste disponible.
Corriger le problème signalé, puis double-cliquer à nouveau : le script peut reprendre avec la livraison vérifiée,
sans reconstruire inutilement. Pour un retour en arrière après lancement, quitter Element, conserver le profil
actuel à part et restaurer ensemble l’application et le profil de la sauvegarde choisie. Relancer ensuite
**Element (Proton)**. Ne jamais remplacer un profil pendant qu’Element est en cours d’exécution.

Pour reconstruire explicitement la version courante depuis un dépôt enregistré et propre :

```sh
bash scripts/menubar/build.sh
```

Le DMG apparaît dans `apps/desktop/dist`. Le script de mise à jour archive les livraisons avec leur manifeste
et leurs empreintes SHA-256 sous `dist/menubar`, et vérifie ces empreintes avant de réutiliser une livraison.

## Développement et vérifications

- Base officielle et révision du fork : `menubar/release.json`.
- Identité de l’application : `menubar/build.json`.
- Les mises à jour sont intégrées par fusion Git, sans réécriture de l’historique.
- Les sources publiques conservent les licences et attributions du projet d’origine.
- Les constructions sont limitées à macOS arm64 et aux versions stables officielles.

```sh
source scripts/menubar/bootstrap.sh
menubar_bootstrap
pnpm --dir apps/desktop exec vitest run --config vitest.config.ts
node --test scripts/menubar/*.test.ts
```

Le build vérifie également les types TypeScript, l’identité de l’application, le canal manuel, les ressources
Retina, la correspondance des versions Web/Desktop, la signature du bundle et l’intégrité du DMG.
Les validations de connexion réelle, de notifications et d’appel demandent une session Matrix de test.
