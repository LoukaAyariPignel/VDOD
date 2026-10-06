# Formats BRV1 à BRV4 : spécification pour le décodeur

Format actuel : **BRV4** (QR code `BRV4:32X18:<CLÉ>`). Image, ouverture et chronologie du son sont communes à tous les formats ; seul le brouillage du son diffère : BRV1 et BRV3 (§5, §5 bis version publiée), BRV2 (§5 bis), BRV4 (§5 ter).

Ce document décrit exactement ce que produit l'encodeur (`brouilleur/`), pour que l'extension puisse le défaire. L'implémentation de référence en Python est `brouilleur/core.py` (clé, tirages), `brouilleur/geometry.py` (`descramble_rgb`) et `brouilleur/audio.py` (`descramble_grid`).

## 1. Clé et QR code

- Contenu du QR code : `BRV2:32X18:<CLÉ>` (ou `BRV1:…` pour les vidéos produites avant le mélange des fréquences), en mode alphanumérique, correction H (QR version 2, 25 × 25 modules pour une clé de 8 caractères).
- BRV1 et BRV2 ne diffèrent que par le son : BRV2 ajoute le mélange des bandes de fréquences (§5 bis).
- `<CLÉ>` : 4 à 16 caractères parmi `A–Z` et `0–9` (8 par défaut).
- Grille `GX × GY` = `32 × 18`.

## 2. Flux pseudo-aléatoire

```
Stream(graine) : pour n = 0, 1, 2, … : SHA-256(ASCII("<graine>:<n>"))
                 → 8 entiers non signés de 32 bits, octet de poids fort en premier, dans l'ordre.
Fisher-Yates(flux, N) : p = [0 … N−1] ; pour i de N−1 à 1 : j = flux.next() mod (i+1) ; échanger p[i], p[j]
```

## 3. Image

Graine : `"<CLÉ>:32X18"`.

1. `perm = Fisher-Yates(flux, 576)` (575 tirages).
2. Puis, pour c = 0 … 575 : `flags[c] = flux.next() & 7`
   - bit 0 (1) : retournement horizontal ; bit 1 (2) : retournement vertical ; bit 2 (4) : négatif.
3. Le bloc brouillé `c` (colonne `c mod 32`, ligne `c div 32`) contient le bloc original `perm[c]`, transformé selon `flags[c]`.

**Géométrie**, en coordonnées normalisées dans l'image (valable à toute résolution), avec la marge `m = 0,06` :

Encodage, pour un point `(u, v) ∈ [0,1]²` du bloc brouillé `c` :
```
u' = clamp((u − m) / (1 − 2m), 0, 1)      v' = idem        (la marge prolonge le bord)
si flags & 1 : u' = 1 − u'                si flags & 2 : v' = 1 − v'
source = ((perm[c] mod 32 + u') / 32, (perm[c] div 32 + v') / 18)
si flags & 4 : valeur = 1 − valeur (en RGB)
```

**Décodage** (ce que fait le shader), pour un pixel affiché de coordonnées normalisées `(X, Y)` :
```
s  = floor(Y·18)·32 + floor(X·32)          bloc original affiché ici
u' = frac(X·32), v' = frac(Y·18)
c  = inverse(perm)[s] ;  f = flags[c]
si f & 1 : u' = 1 − u'                     si f & 2 : v' = 1 − v'
u  = m + u'·(1 − 2m)                       v  = m + v'·(1 − 2m)
lecture à ((c mod 32 + u) / 32, (c div 32 + v) / 18) dans l'image reçue, en bilinéaire
si f & 4 : rgb = 1 − rgb
```
Un lissage léger des jointures peut s'ajouter (plus marqué en 720p, quasi nul à partir de 1440p). La table `(c, f)` indexée par `s` tient dans une texture de 32 × 18.

Autres détails de l'image publiée :
- Toujours en 16:9 exact (1920×1080, 2560×1440 ou 3840×2160), étiquetée BT.709, plage limitée. Une source d'un autre format est centrée avec des bandes noires, qui sont brouillées comme le reste.
- Le négatif est appliqué en YUV comme `Y → 251 − Y`, `U,V → 256 − U,V`, ce qui correspond exactement à `1 − RGB` après la conversion BT.709 du navigateur.

## 4. Ouverture

- `N_open = ceil(0,6 × fps)` images ajoutées avant la vidéo (18 à 30 img/s, 36 à 60 img/s) : les `n_qr` premières (3 par défaut, de 1 à 3) montrent le QR code (noir sur blanc, centré, 90 % de la hauteur), les autres sont noires. Elles ne sont pas brouillées.
- `O = N_open / fps` : durée de l'ouverture (≥ 0,6 s). La vidéo d'origine commence à l'instant `O` du fichier publié.
- Le décodeur masque tout ce qui précède `O` ; il peut retrouver `O` à partir du `fps` de la vidéo.

## 5. Son

Graine : `"<CLÉ>:32X18:SON"`.

1. `order = Fisher-Yates(flux, 8)` (7 tirages).
2. Puis, pour i = 0 … 7 : `reverse[i] = flux.next() & 1`.
3. Dans chaque fenêtre, la position `i` contient le morceau original `order[i]`, joué à l'envers si `reverse[i]`.

Durées (exprimées en millisecondes, à convertir à la fréquence d'échantillonnage du décodeur) :
- morceau `L` = 60 ms ; fenêtre `W` = 8 × L = 480 ms ; marge `M` = 4 ms.
- Début de la grille : `G` = 120 ms dans le son publié. La fenêtre k occupe `[G + k·W, G + (k+1)·W)`.
- Bip de repère : glissando linéaire de 500 Hz à 5000 Hz, 50 ms, enveloppe de Hann, amplitude 0,5, qui commence à l'instant 0 du son publié (avant la grille).

Signal « virtuel » brouillé : `d = O − 0,6 s` de silence, puis le son original, puis du silence jusqu'à la fin de la dernière fenêtre. Pour chaque fenêtre k et position i (j = order[i]) :
```
extrait = virtuel[k·W + j·L − M, k·W + (j+1)·L + M)        (L + 2M échantillons)
si reverse[i] : extrait retourné dans le temps
extrait × trapèze (rampes linéaires de 2M, w[n] = min(1, (n+½)/2M, (L+2M−n−½)/2M))
ajouté au son publié à G + k·W + i·L − M
```
Les rampes de deux morceaux voisins se recouvrent sur 2M et leur somme vaut 1 (fondu croisé).

**Décodage** : opération symétrique. Le morceau de la position `i` est lu à `G + k·W + i·L − M` (L + 2M échantillons), retourné si `reverse[i]`, pondéré par le même trapèze et ajouté à la position `j = order[i]` de la fenêtre dans la sortie. La fenêtre k décodée (instants virtuels `[k·W, (k+1)·W)`) doit être jouée à l'instant `G + (k+1)·W + t` du fichier, soit une fenêtre de retard : le son original d'instant τ sort alors exactement à `O + τ`, en phase avec l'image.

Hors des zones de fondu (± 4 ms autour de chaque jointure), la reconstruction est exacte à l'échantillon près. Dans ces zones, le son reconstitué mélange un peu de contenu voisin : c'est le prix de la marge.

## 5 bis. Son BRV2 : mélange des bandes de fréquences

En BRV2, le signal virtuel est d'abord transformé par bandes, **puis** mélangé dans le temps comme au §5. Le décodeur fait l'inverse : il remet d'abord les morceaux en ordre (§5), puis les bandes.

- MDCT de pas N = 256 échantillons (à 48 kHz), trames de 2N, fenêtre sinus `w[n] = sin(π(n+½)/2N)`. La trame m couvre les indices virtuels `[(m−1)N, (m+1)N)`.
  - analyse : `X[m,k] = Σ w[n] x[(m−1)N+n] cos(π/N (n + ½ + N/2)(k + ½))`
  - synthèse : `y[(m−1)N+n] += (2/N) w[n] Σ X[m,k] cos(…)`.
- Seuls les coefficients 0 à 31 (0 – 3 kHz) sont touchés : 8 bandes de 4 coefficients (375 Hz).
- La trame m appartient à la fenêtre `k = floor(m·N / W)` (W = 23 040 échantillons). Permutation des bandes de cette fenêtre : `q = Fisher-Yates(Stream("<CLÉ>:32X18:BANDES:<k>"), 8)`. La bande brouillée j contient la bande originale q[j].
- Les trames m ≤ 0 ne sont jamais permutées ; la sortie de l'encodeur est prolongée de N échantillons après la fin du son.

La MDCT étant orthogonale, le décodage est exact **à condition d'être aligné au sous-échantillon près** : un écart de 1 échantillon fait déjà perdre de la qualité, 3 échantillons la dégradent fortement. Le décodeur mesure donc le décalage du son sur le bip de repère (corrélation limitée à 0 – 3 kHz, pic interpolé) et le compense par interpolation sinc. Opus à ≤ 48 kbit/s fait varier son retard en cours de lecture (−2,4 → +1 échantillon) : un écart mesuré entre 0,75 et 3 échantillons est ignoré (voir `decoder.calibrate`).

Pour l'extension : ajouter un retard de N échantillons (5,3 ms) au décodage des bandes, en plus de la fenêtre de 480 ms.

## 5 ter. Son BRV4 (format par défaut) : brouillage dans le domaine MDCT

BRV1 à BRV3 mélangent des morceaux de son bruts, reliés par des fondus de 4 ms : dans ces fondus, le son débrouillé perd jusqu'à la moitié de son amplitude et reçoit un peu du morceau voisin (≈ 18 dB de rapport signal/bruit, même sans recompression). BRV4 mélange à la place les **trames d'une MDCT orthonormée** : le débrouillage est exact, et le bruit d'une recompression n'est pas amplifié (mesuré : autant de fidélité que la vidéo originale passée par le même codec).

Chronologie inchangée : bip de repère à 0, grille à partir de `G` = 120 ms, son joué avec W = 480 ms de retard. Le virtuel v (défini au §5) est à la position publiée `G + v`.

- MDCT de pas `N` = 2048 (42,7 ms), trames de 2N, fenêtre sinus `w[n] = sin(π(n+½)/2N)`, orthonormée :
  - analyse : `X[m,k] = √(2/N) Σ w[n] x[(m−1)N+n] cos(π/N (n + ½ + N/2)(k + ½))` ; la trame m couvre les virtuels `[(m−1)N, (m+1)N)` ;
  - synthèse : `y[(m−1)N+n] += √(2/N) w[n] Σ X[m,k] cos(…)`.
- La trame 0 n'est pas brouillée. Les trames m ≥ 1 forment des fenêtres de 8 : la fenêtre w contient les trames `8w+1 … 8w+8` (341,3 ms).
- Dans la fenêtre w, la position i (trame `8w+1+i` du son publié) contient la trame virtuelle `8w+1+order[i]` (order, reverse : §5), transformée ainsi :
  1. si `reverse[i]` : coefficients impairs changés de signe (`X[k] × (−1)^k`, l'équivalent d'un retournement dans le temps) ;
  2. 16 bandes de 32 coefficients (0 – 6 kHz, 375 Hz chacune) : `q = Fisher-Yates(Stream("<CLÉ>:32X18:BANDES:<w>"), 16)`, la bande publiée b contient la bande q[b].
- Son publié = bip, puis synthèse de toutes les trames (placée en `G + v`) × **0,7** (marge contre la saturation : le mélange fait monter les crêtes). Il s'arrête à la fin de la dernière fenêtre utile, plus une trame.

**Décodage** : analyse du son publié (aligné à l'échantillon près) aux mêmes trames, opérations inverses (bandes, puis signes, puis place), synthèse, × 1/0,7. Il faut les 8 trames d'une fenêtre, plus la suivante pour le recouvrement : 384 ms d'avance, moins que les 480 ms de retard prévus.

Implémentations : `brouilleur/mdct4.py` (référence), `extension/src/dsp.js` (`start4`, `run4`).

## 6. Fichier publié

- Conteneur MP4 (faststart). Image H.264 (1080p) ou HEVC (1440p et 4K) quand l'encodeur matériel le permet, à cadence constante égale à celle de la source. Son AAC 48 kHz (320 kbit/s en stéréo, 192 kbit/s en mono).
- Durée = durée d'origine + O.
