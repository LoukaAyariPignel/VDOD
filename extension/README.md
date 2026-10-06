# Débrouilleur BRV — extension de navigateur

Décode en direct, dans le lecteur YouTube, les vidéos produites par le Brouilleur (formats BRV1 à BRV4) : image et son. En BRV4 (format actuel), le son débrouillé est aussi fidèle que celui d'une vidéo normale sur YouTube.

## Installer (non empaquetée)

**Chrome, Edge, Brave, Opera**
1. Ouvrir `chrome://extensions` (ou `edge://extensions`).
2. Activer le **mode développeur** (en haut à droite).
3. **Charger l'extension non empaquetée** → choisir ce dossier `extension`.
4. Après une modification des fichiers : bouton ↻ de l'extension, puis recharger l'onglet YouTube.

**Firefox** (128 ou plus récent)
1. Ouvrir `about:debugging#/runtime/this-firefox` → **Charger un module complémentaire temporaire** → choisir `manifest.json`.
2. Autoriser l'accès à youtube.com dans les permissions du module si demandé.
Une extension temporaire disparaît au redémarrage ; pour une installation durable, la faire signer (gratuitement) sur addons.mozilla.org.

## Utiliser

- Menu de l'icône : **Décodage actif**, **Clé manuelle** (seulement si le QR code est illisible), état de la vidéo de l'onglet et journal du calage du son.
- La clé est lue dans le QR code au début de la vidéo, puis mémorisée pour cette vidéo.
- Première ouverture d'une vidéo au milieu : l'extension revient un instant au début pour lire le QR code.
- Publicités : laissées intactes.
- Aperçus de la barre de lecture (survol, glissement, recherche précise) : débrouillés aussi. YouTube les découpe dans des planches d'images tirées de la vidéo brouillée ; `src/preview.js` débrouille chaque planche une fois (même plan que la vidéo) et la substitue à l'originale. En attendant, l'aperçu reste noir.

## Comment le son est débrouillé

1. `src/page-hook.js` (exécuté dans la page, avant YouTube) copie les morceaux de **son que le lecteur transmet au navigateur** (Media Source Extensions), sans rien changer à la lecture. `src/early.js` les reçoit dès le début du chargement.
2. `src/refaudio.js` lit ces morceaux (WebM/Opus, MP4/AAC ; mono ou stéréo ; 44,1 ou 48 kHz) et les **décode avec WebCodecs** hors du fil de la page, seulement autour de la position de lecture. Chaque échantillon de cette « référence » a son instant exact (les horodatages WebM, arrondis à la milliseconde, sont recalés sur la grille des trames Opus).
3. Ce son de référence est fourni **en avance** (2,5 s) au module audio, qui le débrouille : BRV1 à BRV4 (BRV4 : trames MDCT remises en ordre, exact à l'échantillon près).
4. Le son réellement joué ne sert qu'à savoir où l'on en est : après chaque reprise (début, saut, pause), 0,3 s de son joué est comparé à la référence, puis un contrôle toutes les 5 s suit les éventuelles dérives.
5. La seule constante, l'amorce du codec (−312 échantillons pour Opus, −1024 pour AAC dans les essais), est mesurée **une fois par format** sur le bip de repère du début, puis mémorisée. Si le début de la vidéo n'a jamais été reçu, l'extension y revient un instant pour la mesurer.

Sans ces données (fichier lu directement, autre site), l'ancienne méthode sert de secours : le son joué est débrouillé directement, calé sur le bip puis sur les reprises du son (BRV1, BRV3 et BRV4 ; BRV2 exige le son de référence).

Coût mesuré : aucune image perdue en lecture continue. Au démarrage, une quinzaine d'images sont perdues pendant l'ouverture, qui est masquée en noir. Elles viennent du basculement du son vers l'extension.

## Tester en local, sans YouTube

Dans le dossier `exemples`, lancer un serveur, puis ouvrir :
- http://localhost:8000/test_mse.html : lecture « comme YouTube » (image et son séparés, par morceaux), en Opus. Ajouter `?audio=mse_audio.m4a` pour l'AAC ;
- http://localhost:8000/test.html : lecture directe d'un fichier (méthode de secours).

Le serveur de Python (`python -m http.server 8000`) ne permet pas de se déplacer dans un fichier lu directement ; la page MSE, elle, charge tout d'avance.

## Fichiers

- `src/brv-core.js` : clé, tirages, plans (identiques à `brouilleur/core.py`)
- `src/dsp.js` : débrouillage du son en direct ; `src/processor.js` : module audio
- `src/worklet.js` : **généré** par `python build.py` (brv-core + dsp + processor)
- `src/page-hook.js`, `src/early.js`, `src/refaudio.js` : son de référence ; `src/sync.js` : FFT et secours par les copies des jointures
- `src/video.js` : calque WebGL ; `src/preview.js` : aperçus de la barre de lecture ; `src/audio.js` : branchement du son et calage ; `src/content.js` : pilotage
- `lib/jsQR.js` : lecture des QR codes (licence Apache 2.0)
