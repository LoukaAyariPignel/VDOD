# Brouilleur de vidéos pour YouTube — encodeur

Application de bureau qui brouille une vidéo selon le principe décrit dans [IDEE.md](IDEE.md) : image en 576 blocs mélangés, retournés et inversés, son en morceaux de 60 ms mélangés, et la clé dans un QR code ajouté au début. Le format exact, pour écrire l'extension, est dans [SPEC.md](SPEC.md).

## Installation

1. Python 3.10 ou plus récent.
2. `pip install -r requirements.txt`
3. ffmpeg : `winget install Gyan.FFmpeg` sous Windows, `sudo apt install ffmpeg` sous Ubuntu. L'application le trouve aussi dans un dossier `ffmpeg/` placé à côté d'elle, ou via la variable `BRV_FFMPEG_DIR`.

## Lancement

- Windows : double-cliquer sur `Brouilleur.pyw`. L'onglet « Encoder » brouille, l'onglet « Lire / Décoder » lit et débrouille.
- Ou bien : `python -m brouilleur [vidéos…]`.

Au premier lancement, l'application détecte le matériel puis fait un essai de vitesse d'une vingtaine de secondes. Le résultat est mémorisé dans `%APPDATA%\Brouilleur` (ou `~/.config/brouilleur`), et l'essai n'est refait que si ffmpeg change ou si on clique sur « Refaire l'essai de vitesse ».

## Fonctionnement

| Étape | Ce qui se passe |
|---|---|
| Son | Lecture en flux, brouillage (numpy), compression AAC dans un fichier temporaire |
| Image | Tranches de 10 min : décodage matériel → brouillage par un noyau OpenCL sur la carte graphique (`program_opencl` d'ffmpeg) → encodeur matériel (NVENC, Quick Sync, AMF) |
| Assemblage | Ouverture + tranches + son recollés sans réencodage |
| Vérification | 10 images au hasard débrouillées et comparées à l'original, lecture du QR code, corrélation du son débrouillé |

- **Rapide** : la plus haute résolution qui tient 6 fois le temps réel d'après l'essai de vitesse. **Qualité maximale** : 4K.
- **Reprise** : l'encodage est découpé en tranches dans un dossier caché `.<nom>_brouille.travail` à côté de la sortie. Si on l'interrompt, relancer la même vidéo avec les mêmes réglages reprend à la tranche suivante, avec la même clé.
- **Sans carte graphique** : brouillage par le filtre `remap` d'ffmpeg et encodage libx264, plusieurs tranches en parallèle.
- **Mise en veille** : elle est empêchée pendant l'encodage.
- L'encodage tourne dans un processus séparé (`python -m brouilleur.worker travail.json`, messages JSON sur stdout), donc l'interface reste réactive.

Fichiers produits à côté de la vidéo : `<nom>_brouille.mp4`, `<nom>_brouille_qr.png` (le QR code de la clé) et `<nom>_brouille_verification.jpg` (originale | brouillée | débrouillée).

## Décodeur (onglet « Lire / Décoder »)

Il fait la même chose que l'extension prévue, mais dans l'application, sur un fichier (par exemple une vidéo téléchargée depuis YouTube) :

- **Clé** : cherchée dans le QR code de la première seconde (OpenCV), puis mémorisée pour ce fichier. Si le QR code est illisible, on peut saisir la clé à la main.
- **Image** : ffmpeg décode la vidéo en YUV 4:2:0 (réduite à 1080p au-delà), et un seul shader OpenGL remet les 576 blocs en place, les retourne, applique les négatifs, convertit en RGB et adoucit les jointures. Le rendu prend 1 à 2 ms par image.
- **Son** : débrouillé en flux, fenêtre par fenêtre (`audio.descramble_stream`), puis joué par la carte son. L'horloge du son cadence l'affichage des images.
- **Ouverture** : masquée (écran noir, bip muet). « Décodage actif » se coupe et se remet pendant la lecture, et on peut se déplacer dans la vidéo.
- **Exporter débrouillée…** : recrée un fichier normal `<nom>_debrouille.mp4`, sans l'ouverture, avec le noyau OpenCL inverse et l'encodeur matériel.

Le shader (`player.py`) est écrit en GLSL simple, donc directement réutilisable en WebGL pour l'extension. La différence : un fichier local donne la position exacte de chaque échantillon de son, donc le lecteur n'a pas besoin du calage fin décrit dans IDEE.md §4, alors que l'extension en aura besoin.

## Son BRV4 (format actuel) : débrouillage exact

BRV1 à BRV3 mélangeaient des morceaux de son bruts reliés par des fondus de 4 ms ; dans ces fondus, le son débrouillé perdait de l'amplitude et recevait un peu du morceau voisin, même sans aucune recompression (rapport signal/bruit plafonné à 18 dB). BRV4 mélange les **trames d'une MDCT** (la transformée qu'utilisent Opus et AAC) : trames de 42,7 ms permutées dans des fenêtres de 341 ms, certaines retournées, et 16 bandes de 375 Hz (0 – 6 kHz) mélangées (`mdct4.py`, SPEC.md §5 ter). La transformée étant orthogonale, le débrouillage est exact et n'amplifie pas le bruit des compressions de YouTube.

Bande-son test (parole, sonneries, explosion, pas) ; à écouter dans `exemples/son/` (`6_brouille_BRV4.wav`, `7_debrouille_BRV4_apres_opus_128k.wav`) :

| | Original (même compression) | BRV3 | **BRV4** |
|---|---|---|---|
| Ressemblance du timbre du son brouillé (plus bas = mieux brouillé) | 1,00 | 0,40 | **0,21** |
| Son débrouillé, sans recompression (rapport signal/bruit) | — | 18 dB | **exact** |
| après Opus 128 kbit/s (itag 251, le plus courant) | 0,988 | 0,988 | **0,997** |
| après Opus 64 kbit/s (itag 250) | 0,984 | 0,982 | **0,990** |
| après Opus 48 kbit/s (itag 249) | 0,933 | 0,796 | **0,954** |
| après AAC 128 kbit/s à 44,1 kHz (itag 140) | 0,999 | 0,991 | **0,999** |

(corrélation avec le son d'origine.) Le son débrouillé est donc aussi fidèle qu'une vidéo normale mise sur YouTube, parfois plus. Les vidéos BRV1, BRV2 et BRV3 déjà publiées restent lisibles.

## Son : mélange dans le temps et en fréquences (BRV2)

Le mélange des morceaux de 60 ms laissait les bruitages reconnaissables, car chaque morceau garde son timbre. En BRV2, les fréquences de 0 à 3 kHz sont aussi découpées en 8 bandes de 375 Hz, mélangées selon la clé, avec un mélange qui change toutes les 480 ms (`bands.py`, SPEC.md §5 bis). Rien n'est déplacé au-dessus de 3 kHz, là où les versions compressées de YouTube perdent de la précision.

Mesures sur une bande-son test (parole, sonneries, explosion, pas), dans `exemples/son/` pour les écouter :

| | Original | BRV1 | BRV2 |
|---|---|---|---|
| Ressemblance du timbre du son brouillé avec l'original | 1,00 | 0,85 | **0,40** |
| Son débrouillé après Opus 128 kbit/s (itag 251) | 0,988 | 0,981 | 0,988 |
| après Opus 64 kbit/s (itag 250) | 0,984 | 0,977 | 0,982 |
| après Opus 48 kbit/s (itag 249) | 0,953 | 0,948 | 0,906 |
| après AAC 128 kbit/s à 44,1 kHz (itag 140) | 0,999 | 0,991 | 0,991 |
| après HE-AAC 48 kbit/s simulé (itag 139) | 0,971 | 0,966 | 0,960 |

(corrélation avec le son d'origine ; la colonne « Original » est le son normal passé par la même compression.)

Seul Opus à 48 kbit/s perd un peu plus qu'un son normal : son retard interne varie en cours de route, et le mélange des fréquences exige un alignement au sous-échantillon près. Les vidéos BRV1 déjà produites restent lisibles.

## Vitesses mesurées (Intel Core Ultra 7 268V, Arc 140V)

| Sortie | Images/s | Pour 1 h à 30 img/s |
|---|---|---|
| 1080p | 366 | ≈ 5 min |
| 1440p | 312 | ≈ 6 min |
| 4K | 175 | ≈ 10 min |

## Écarts par rapport à IDEE.md

- Interface en Qt (PySide6), comme le prévoit IDEE.md pour Windows. La progression s'affiche sur l'icône de la barre des tâches sous Windows, et dans le dock sous Ubuntu (Unity LauncherEntry).
- Les images passent par la mémoire principale entre le décodage, le brouillage OpenCL et l'encodeur : sur une puce graphique intégrée, c'est la même mémoire, et le goulot reste l'encodeur.
- L'ouverture dure `ceil(0,6 × fps)` images, donc un peu plus de 0,6 s à 23,976 img/s. Le son est décalé en conséquence (voir SPEC.md §4 et §5).
