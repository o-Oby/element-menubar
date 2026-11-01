# Element Menu Bar

Application personnelle macOS Apple Silicon, issue d’Element Web/Desktop. Le fork public est
<https://github.com/o-Oby/element-menubar>, branche `codex/macos-menubar`.

## Première installation

1. Ouvrir le DMG `Element-Menu-Bar-<version>-r<révision>-arm64.dmg` livré dans le dossier `dist/menubar`.
2. Glisser **Element Menu Bar.app** dans Applications, puis l’ouvrir.
3. Se connecter à Matrix et vérifier cette nouvelle session depuis un appareil déjà connecté ou avec la clé de récupération.

L’application et son profil sont distincts d’Element officiel. Les données du fork sont conservées dans
`~/Library/Application Support/Element Menu Bar`. Ne copiez pas le profil de l’application officielle.
La construction personnelle possède une signature ad hoc, sans notarisation Apple. Si macOS demande une
confirmation à la première ouverture, utiliser clic droit → Ouvrir ou Réglages Système → Confidentialité et sécurité → Ouvrir quand même.

## Utilisation

- Fenêtre ouverte : Element figure dans le Dock.
- Bouton rouge ou `⌘W` : la fenêtre disparaît, la connexion reste active et l’icône du Dock disparaît.
- Icône dans la barre de menus → **Afficher/Masquer** : retrouver la fenêtre et le Dock.
- **Quitter** ou `⌘Q` : arrêter réellement l’application.
- Minimiser avec le bouton jaune et masquer avec `⌘H` conservent le comportement macOS habituel.

Le réglage existant d’affichage de l’icône de zone de notification est disponible sur macOS et activé par défaut.
Le désactiver rétablit l’accès par le Dock. Le démarrage à l’ouverture de session reste facultatif dans les réglages.

## Mettre à jour sans perdre le fork

Fermer l’application n’est nécessaire qu’au moment de remplacer son fichier `.app`.

1. Dans le dossier du projet, double-cliquer **Mettre à jour Element Menu Bar.command**.
2. Attendre les vérifications et la compilation. Le dossier contenant le DMG s’ouvre à la fin.
3. Quitter **Element Menu Bar**, installer le nouveau `.app` au même emplacement et le rouvrir.

Le script récupère la dernière version stable officielle, fusionne ses sources avec la branche du fork,
vérifie le client Web signé correspondant, exécute les tests et construit le DMG. Il publie la branche du fork
après validation. Aucun binaire officiel n’est installé automatiquement : le programme de mise à jour interne
est désactivé pour cette variante, même en présence d’une configuration utilisateur.

Le profil Matrix reste en place. Une éventuelle demande macOS d’accès au trousseau concerne l’application
personnelle qui vient d’être reconstruite. Aucun mot de passe Matrix ni clé de récupération n’est nécessaire
pour construire ou mettre à jour les sources.

Pré-requis : Xcode et ses outils de ligne de commande, Git, GnuPG (`brew install gnupg`) et un accès GitHub
en écriture au fork (`gh auth setup-git` si nécessaire). Node et pnpm sont téléchargés aux versions prescrites
par le dépôt dans `~/Library/Caches/ElementMenuBar/toolchains`, sans changer les versions système.
Les dépendances sont installées avec le fichier de verrouillage officiel.

## Si une préparation échoue

Le script ne remplace pas l’application installée. Un conflit avec une nouvelle version nécessite une adaptation
du fork ; il n’est jamais résolu en écrasant automatiquement nos modifications.

Le terminal indique le dossier de préparation conservé. Ses journaux et son emplacement sont enregistrés dans
`.git/menubar-updates`. Partager ces diagnostics pour faire corriger le conflit ou l’échec, puis relancer la préparation.
Un échec de publication GitHub conserve aussi la préparation validée. Ne pas utiliser `git reset --hard`,
un push forcé ou un remplacement du profil pour résoudre un problème de mise à jour.

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
node --test scripts/menubar/update.test.ts
```

Le build vérifie également les types TypeScript, l’identité de l’application, le canal manuel, les ressources
Retina, la correspondance des versions Web/Desktop, la signature du bundle et l’intégrité du DMG.
Les validations de connexion réelle, de notifications et d’appel demandent une session Matrix de test.
