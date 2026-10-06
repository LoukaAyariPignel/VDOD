# Brouillage de vidéos pour YouTube

Publier une vidéo **brouillée** sur YouTube. Pour tout le monde, l'image ressemble à une mosaïque illisible et le son à un charabia incompréhensible. Les personnes qui ont l'**extension de navigateur** la voient et l'entendent normalement, en direct, dans le lecteur YouTube.

**Priorités, dans l'ordre :**
1. **Rapidité** :
   - **décodage** en temps réel, sans jamais faire baisser la **fréquence d'images d'origine** (24, 30, 60 images par seconde…), même sur un ordinateur modeste ;
   - **encodage** rapide, même pour des vidéos de plusieurs heures, dans une application graphique qui montre l'avancement.
2. **Robustesse aux qualités de YouTube** : le système doit bien fonctionner **à partir du 720p** (720p, 1080p, 1440p, 4K), quelle que soit la qualité choisie par le spectateur dans cette plage, et quel que soit le format servi par YouTube (H.264, VP9 ou AV1 pour l'image ; Opus ou AAC, en haute comme en basse qualité, pour le son).
3. La sécurité passe après : le but est que la vidéo soit inexploitable **sans l'extension**, pas qu'elle résiste à un attaquant déterminé.

**Tout est dans la vidéo publiée** : l'image brouillée, le son brouillé, et la clé, sous forme de QR code sur des images ajoutées avant la vidéo. Rien n'est hébergé ailleurs, et l'utilisateur n'a rien à saisir.

L'inspiration vient des systèmes analogiques de Canal+ (Discret 11) : on ne chiffre pas, on **déplace** des morceaux d'image et de son. Ces opérations survivent à la recompression et ne coûtent presque rien à défaire.

---

## 1. Vue d'ensemble

| | Méthode | Coût du décodage | Retard |
|---|---|---|---|
| **Clé** | QR code sur des images ajoutées avant la vidéo | Une seule lecture, au début | Aucun |
| **Image** | Grands blocs mélangés, retournés et inversés selon la clé | Moins de 1 ms par image, sur la carte graphique | Aucun |
| **Son** | Morceaux de 60 ms mélangés dans le temps selon la clé | Simple copie de mémoire | Compensé à l'encodage |

### La règle qui guide tous les choix

YouTube propose chaque vidéo dans **toutes les résolutions de 144p à la résolution d'envoi**, avec des débits très différents, et plusieurs formats de son, jusqu'à des versions très compressées.

- **L'image** est dimensionnée pour **le 720p**, la plus basse qualité à garantir, et profite simplement d'une meilleure qualité quand elle est là. En dessous de 720p, le décodage fonctionne encore, mais avec des jointures plus visibles : ce n'est pas garanti.
- **Le son** est dimensionné pour **le format le plus compressé**. Le format de son servi par YouTube ne dépend pas de la qualité d'image choisie, mais de la connexion et de l'appareil : même en 1080p, on peut recevoir un son très compressé.

Deux principes en découlent :
- **Ne jamais déplacer le contenu vers ce que YouTube sacrifie en premier.** Pour l'image, ce sont les petits détails. Pour le son, ce sont les aigus. On déplace donc de **gros morceaux**, et le son reste **dans ses fréquences d'origine**.
- **S'aligner sur la façon dont YouTube découpe l'image**, pour que la compression ne mélange pas deux blocs voisins.

---

## 2. La clé : un QR code au début de la vidéo

### Contenu du QR code

Un texte court, écrit uniquement en majuscules, chiffres et deux-points. Ce jeu de caractères réduit (le mode « alphanumérique » des QR codes) permet un QR code plus petit, donc avec des modules plus gros :

```
BRV1:32X18:K7QP2MXE
```

- `BRV1` : identifiant et version du format.
- `32X18` : la grille. L'extension la lit directement, l'utilisateur n'a rien à régler.
- `K7QP2MXE` : la clé, générée au hasard par l'encodeur (8 caractères suffisent, puisque la sécurité n'est pas l'objectif).

Avec la correction d'erreurs maximale, ce texte tient dans un QR code de **25 × 25 modules**, le plus petit possible pour ce contenu.

### Placement

- Le QR code est sur des images **ajoutées avant la vidéo**. **Aucune image de la vidéo d'origine n'est remplacée** : la vidéo commence juste après, en entier.
- Ces images montrent le QR code en plein écran : noir sur fond blanc, centré, sur 90 % de la hauteur, avec une marge blanche tout autour. Elles ne sont **pas brouillées**.
- Elles sont suivies d'un **fond noir**, pour que l'**ouverture** ajoutée dure **0,6 seconde** au total. Cette durée n'est pas liée au QR code mais au son : comme il est avancé de 480 ms (section 4), il doit commencer avant l'image de la vidéo, et il lui faut une place au début.
- Pendant cette ouverture, le son contient le **bip de calage** puis le début du son brouillé (section 4).
- La vidéo publiée dure donc 0,6 seconde de plus que l'originale. L'extension masque toute l'ouverture (écran noir) ; sans l'extension, on voit le QR code un instant, puis du noir.

**Combien d'images ajouter :** **une seule**, par défaut. À partir du 720p, YouTube dispose d'assez de débit pour que cette image, qui est la première de la vidéo et donc une image clé codée entièrement, soit nette. Le nombre est réglable : on peut en ajouter 2 ou 3 par précaution, par exemple si YouTube risque de supprimer la première en convertissant la fréquence d'images.

L'extension n'a besoin de réussir la lecture que sur **une seule** de ces images. Elle les **masque** toutes (écran noir), donc le spectateur ne voit jamais le QR code.

### Robustesse du QR code

- **Correction d'erreurs maximale** (niveau H) : lisible même si environ 30 % de sa surface est abîmée.
- **Gros modules** : sur 90 % de la hauteur, chaque module mesure environ **26 pixels en 720p** et 39 pixels en 1080p : très largement lisible.
- **Noir et blanc purs** : la luminosité est la partie de l'image que YouTube préserve le mieux, et un contraste maximal résiste au flou.
- **Image fixe** : la compression traite très bien une image qui ne bouge pas.

### Lecture par l'extension

1. Quand une vidéo commence, l'extension analyse les images de la **première seconde** à la recherche d'un QR code commençant par `BRV1:`.
2. L'analyse s'arrête dès qu'un QR code est lu. Elle utilise une bibliothèque de lecture intégrée à l'extension et coûte quelques millisecondes par image analysée, uniquement au début de la vidéo.
3. Une fois le QR code trouvé :
   - la clé et la grille sont appliquées à cette vidéo ;
   - elles sont **mémorisées avec l'identifiant de la vidéo YouTube**, pour les rechargements, les retours ultérieurs et les liens qui démarrent au milieu ;
   - les images du QR code sont masquées.
4. Si aucun QR code n'est trouvé et que la vidéo n'est pas mémorisée, l'extension utilise la **clé manuelle** du menu si elle est remplie, sinon elle laisse la vidéo intacte.

**Cas particulier :** si on ouvre une vidéo pour la première fois **directement au milieu** (lien avec un horodatage), l'extension revient un instant au début pour lire le QR code, puis retourne à la position demandée.

### Sécurité

La clé est lisible par n'importe qui avec un lecteur de QR code. Elle ne protège donc pas la vidéo : elle sert à ce que l'extension se configure toute seule.

---

## 3. L'image : grands blocs alignés

### Pourquoi pas un vrai chiffrement

YouTube **réencode** toutes les vidéos avec une compression avec pertes. Un vrai chiffrement des pixels donnerait un bruit pur, que la compression détruirait. On ne modifie donc pas la **valeur** des pixels de façon aléatoire, seulement leur **position** et leur **orientation** : chaque bloc reste un morceau d'image « naturel », que la compression traite correctement.

### Une grille de 32 × 18 blocs

La vidéo est envoyée en **16:9 exact**. L'image est découpée en **32 colonnes × 18 lignes = 576 blocs carrés**.

Ce choix n'est pas arbitraire : c'est une grille dont les blocs **tombent pile sur le découpage de la compression** dans toutes les résolutions à partir de 720p. Les formats de compression (H.264, VP9, AV1) découpent l'image en carrés de 4, 8, 16, 32 ou 64 pixels. Quand les frontières de nos blocs coïncident avec les leurs, la compression ne mélange jamais deux blocs voisins.

| Qualité YouTube | Résolution | Taille d'un bloc | Aligné sur la compression |
|---|---|---|---|
| 720p | 1280 × 720 | 40 px | Oui (8) |
| 1080p | 1920 × 1080 | 60 px | Oui (4) |
| 1440p | 2560 × 1440 | 80 px | Oui (16) |
| 2160p (4K) | 3840 × 2160 | 120 px | Oui (8) |

En 720p, les blocs font 40 pixels : assez gros pour survivre à la compression, et assez petits pour que l'image brouillée soit bien mélangée. En 1080p, l'alignement ne se fait que sur les plus petits carrés de la compression (4 pixels) : la marge de sécurité et le lissage (voir plus bas) compensent.

Le 720p étant la qualité minimale, on peut se permettre 4 fois plus de blocs qu'une grille pensée pour le 144p (576 au lieu de 144) : l'image brouillée est beaucoup moins reconnaissable.

### Des transformations gratuites pour compenser la taille des blocs

Même avec 576 blocs, on peut encore reconnaître des fragments d'image dans certains blocs. Pour rendre l'image vraiment illisible **sans coût supplémentaire**, chaque bloc subit aussi, selon la clé :

- un **retournement** : horizontal, vertical, les deux, ou aucun ;
- une **inversion des couleurs**, en négatif, pour environ un bloc sur deux.

Ces opérations résistent parfaitement à la compression : un bloc retourné ou en négatif reste une image « naturelle ». Et au décodage, elles ne coûtent rien : la carte graphique lit simplement le pixel à une position retournée, et calcule `1 − valeur` pour un négatif.

### Calcul des transformations

Tout doit être **identique à l'octet près** dans l'encodeur et dans le décodeur :

1. **Graine** : le texte `clé:grille`, par exemple `K7QP2MXE:32X18`.
2. **Flux de nombres aléatoires** : SHA-256 de `graine:0`, puis de `graine:1`, etc. Chaque empreinte donne 8 entiers de 32 bits (octet de poids fort en premier).
3. **Permutation par mélange de Fisher-Yates** : on part de la liste 0, 1, …, 575. Pour i allant de 575 jusqu'à 1, on tire le nombre suivant r, on calcule j = r mod (i+1) et on échange les éléments i et j. Le bloc brouillé n°c contient le bloc original n°p[c].
4. **Transformations** : pour chaque bloc, dans l'ordre, un nombre de plus : ses 2 bits de poids faible donnent le retournement, le 3e bit donne le négatif.

Le tout est **fixe pour toute la vidéo** et calculé **une seule fois**, dès que la clé est connue. Le résultat est une petite table de 576 entrées, envoyée une fois à la carte graphique.

### Marge de sécurité et lissage

Là où l'alignement est le plus faible (1080p), et à cause des filtres d'adoucissement que les formats de compression appliquent aux frontières, les bords de chaque bloc peuvent être contaminés par ses voisins. Deux parades :

- **Marge, à l'encodage** : chaque bloc est légèrement réduit (6 % de sa taille de chaque côté), et la marge libérée est remplie en **prolongeant les pixels de son bord**. Les bavures tombent dans cette marge, qui ne contient que des doublons. Au décodage, on ne lit que l'intérieur de chaque bloc, agrandi à sa taille d'origine. Coût : environ 12 % de résolution.
- **Lissage des jointures, au décodage** : dans la même passe sur la carte graphique, les quelques pixels de chaque côté d'une jointure sont légèrement adoucis. Son intensité est réglée selon la résolution reçue : plus marqué en 720p, presque nul en 1440p et au-delà.

---

## 4. Le son : morceaux mélangés dans le temps

### Pourquoi pas l'inversion du spectre

L'inversion du spectre envoie la voix et les graves dans les aigus. Or YouTube sert aussi des versions **très compressées** du son (vers 48 kbit/s), qui sacrifient justement les aigus : elles les coupent, ou les **reconstituent artificiellement** à partir des graves (c'est le principe du format HE-AAC). La voix, déplacée dans les aigus, serait détruite.

La seule méthode robuste à toutes les qualités est de **laisser chaque son dans ses fréquences d'origine** et de brouiller **dans le temps**. Le son brouillé a alors exactement le même spectre qu'un son normal, et YouTube le traite comme tel, quelle que soit la qualité.

### Le principe

1. Le son est découpé en **morceaux de 60 ms**.
2. Les morceaux sont regroupés par **fenêtres de 8** (480 ms).
3. Dans chaque fenêtre, les 8 morceaux sont **mélangés** selon une permutation tirée de la clé, et certains sont **joués à l'envers**, également selon la clé.

Le résultat est un son qui a le timbre de l'original, mais où les syllabes sont hachées, désordonnées et en partie à l'envers : c'est incompréhensible. Des morceaux de 60 ms mélangés sur une demi-seconde suffisent à rendre la parole inintelligible.

La permutation et les retournements sont **fixes** (les mêmes pour chaque fenêtre) et tirés du même flux SHA-256 que l'image, avec la graine `clé:grille:SON`.

### Pourquoi la qualité reste bonne

La compression audio cache ses erreurs là où l'oreille ne les entend pas, **en fonction du contenu voisin**. Ici, chaque morceau garde son propre contenu, et les erreurs de compression d'un morceau restent cachées par ce même contenu quand on le remet en place. Le son décodé a donc la même qualité qu'une vidéo YouTube normale dans la même qualité de lecture.

Le seul point faible, ce sont les **jointures** entre morceaux : le son brouillé y présente des sauts, que la compression étale un peu. Parade : chaque morceau porte une **marge de 4 ms** à chaque bout, qui se recouvre avec ses voisins par un **fondu croisé**, comme la marge des blocs d'image. Au décodage, les jointures sont refaites par fondu croisé et restent inaudibles.

### Le retard, compensé à l'encodage

Pour remettre une fenêtre en ordre, le décodeur doit l'avoir reçue en entier : il a donc toujours **une fenêtre de retard** (480 ms). Pour que le son reste synchronisé avec l'image, l'encodeur **avance le son de 480 ms** par rapport à l'image. Une fois décodé, il retombe exactement au bon moment.

### Retrouver le début des morceaux (calage)

Le décodeur doit savoir précisément où commence chaque fenêtre dans le son qu'il reçoit. Il procède en deux temps :

1. **Estimation grossière** à partir de la position de lecture de la vidéo. Le navigateur la connaît à quelques dizaines de millisecondes près, à cause du traitement interne du son.
2. **Calage fin** : le décodeur essaie les décalages possibles autour de cette estimation et garde celui qui produit un son **continu** aux jointures. Un mauvais décalage crée des sauts nets entre les morceaux, et un bon décalage n'en crée aucun. Ce calcul se fait une seule fois, sur une demi-seconde de son, en quelques millisecondes.

Pour faciliter le tout premier calage, l'encodeur place un **court signal de repère** (un « bip » glissant de 50 ms) tout au début de l'ouverture, à un moment précis. Le décodeur l'utilise pour mesurer une fois pour toutes le retard interne du navigateur. Ce bip est masqué, comme le QR code : le spectateur ne l'entend pas.

### Coût

Le décodage revient à **copier des morceaux de mémoire** dans un autre ordre, avec un fondu aux jointures. C'est encore plus léger que l'inversion du spectre. Le calage fin ne se fait qu'au début et après chaque saut dans la vidéo.

### Pause, sauts et vitesse de lecture

- **Pause** : le son s'arrête et reprend normalement, le calage est conservé.
- **Saut dans la vidéo** : le décodeur vide sa réserve et refait le calage. Il y a environ **une demi-seconde de silence** après chaque saut, le temps de recevoir une fenêtre complète.
- **Vitesse différente de ×1** : les navigateurs, par défaut, accélèrent le son **sans changer sa hauteur**, en le redécoupant eux-mêmes, ce qui détruirait la structure des morceaux. Quand le décodage est actif, l'extension désactive donc cette option : le son est simplement accéléré (et devient plus aigu), et le décodeur ajuste la durée des morceaux à la vitesse. Le son reste compréhensible, un peu comme une cassette accélérée.

---

## 5. Robustesse à YouTube : récapitulatif

| Ce que fait YouTube | Effet | Parade |
|---|---|---|
| Résolutions de 720p à 4K | Blocs de taille différente selon la qualité | Grille 32 × 18 (blocs ≥ 40 px en 720p), positions en proportion |
| Découpage de la compression (H.264, VP9, AV1) | Mélange des blocs voisins | Blocs alignés sur ce découpage dans la plupart des résolutions |
| Filtres d'adoucissement, alignement faible en 1080p | Bords des blocs contaminés | Marge de 6 % autour des blocs + lissage adapté à la résolution |
| Débit limité en 720p | Petits détails abîmés | Blocs de 40 px minimum, QR code à gros modules |
| Réduction de la finesse des couleurs | Couleurs moins précises aux bords | Marge de sécurité ; QR code en noir et blanc |
| Suppression de la première image (conversion de fréquence) | QR code perdu | Option : ajouter l'image du QR code 2 ou 3 fois |
| Images supprimées ou dupliquées | Aucune pour l'image | Pas de synchronisation pour l'image |
| Son très compressé (HE-AAC, Opus à bas débit) | Aigus coupés ou reconstitués | Son brouillé dans le temps : le spectre reste celui d'un son normal |
| Recompression du son | Jointures entre morceaux étalées | Marge de 4 ms et fondus croisés |
| Traitement interne du son par le navigateur | Position du son connue approximativement | Calage fin par continuité + bip de repère |
| Vitesse ×0,5 à ×2 | Structure du son modifiée | Pas de correction de hauteur, durée des morceaux ajustée |
| 44,1 ou 48 kHz | Aucune | Durées exprimées en millisecondes, pas en échantillons |
| Normalisation du volume | Aucune | — |

**Conseil pour la mise en ligne :** envoyer la vidéo en **1440p ou 4K**, même si la source est en 1080p (en l'agrandissant à l'encodage). YouTube utilise alors un meilleur format de compression et plus de débit **pour toutes les qualités**, y compris celles que choisissent les spectateurs. C'est l'astuce la plus efficace contre la compression. Elle coûte du temps d'encodage : l'encodeur ne l'applique que si le matériel permet de tenir l'objectif de rapidité (section 6.1).

---

## 6. L'encodeur (application sur l'ordinateur)

L'encodeur est une **application avec interface graphique**. Il doit rester **rapide même pour des vidéos de plusieurs heures**, et montrer en permanence où en est l'encodage.

### 6.1 Rapidité

**Objectif : environ 10 minutes pour 1 heure de vidéo**, soit **6 fois plus vite que le temps réel**. Pour une vidéo à 30 images par seconde, il faut traiter **180 images par seconde** ; à 60 images par seconde, 360.

Pour une vidéo de plusieurs heures, ce qui prend du temps n'est pas le brouillage : c'est la **lecture** de la vidéo d'origine et surtout la **compression** de la vidéo brouillée. Tout est donc organisé autour de ces deux étapes.

**Un seul passage, sans fichier intermédiaire**

La vidéo n'est lue qu'**une fois** et écrite qu'**une fois**, en flux continu :

```
lecture (ffmpeg) ──► brouillage ──► compression (ffmpeg) ──► fichier final
     image n+2          image n+1          image n
```

- **Les trois étapes tournent en même temps**, chacune sur sa propre image : pendant que l'image n est compressée, l'image n+1 est brouillée et l'image n+2 est lue. La vitesse totale est celle de l'étape la plus lente, en pratique la compression.
- **Aucun fichier temporaire** pour l'image : pas de vidéo brute de plusieurs centaines de gigaoctets sur le disque.
- **Mémoire constante** : seules quelques images sont en mémoire à la fois, que la vidéo dure 5 minutes ou 5 heures.

**La carte graphique partout où c'est possible**

- **Lecture** : décodage matériel de la vidéo d'origine (NVDEC chez NVIDIA, VA-API chez AMD et Intel sous Linux, Quick Sync chez Intel).
- **Brouillage** : sur la carte graphique, avec **le même programme** que celui de l'extension, appliqué dans l'autre sens. Les images restent dans la mémoire de la carte graphique entre la lecture, le brouillage et la compression, sans aller-retour vers le processeur.
- **Compression** : encodeur matériel (NVENC, VA-API, Quick Sync, AMF). Il compresse de la 4K à **plusieurs centaines d'images par seconde**, contre quelques dizaines au mieux pour un encodeur logiciel.

L'application **détecte automatiquement** le matériel disponible. S'il n'y a pas d'accélération matérielle, elle passe en mode logiciel (voir plus bas).

**Ce qui permet d'atteindre l'objectif**

Pour une vidéo d'**1 heure à 30 images par seconde** (108 000 images), les ordres de grandeur sont les suivants :

| Matériel | Sortie 1080p | Sortie 1440p | Sortie 4K |
|---|---|---|---|
| Carte graphique récente (NVIDIA, AMD, Intel Arc) | ≈ 3 min | ≈ 5 min | ≈ 10 à 12 min |
| Processeur graphique intégré Intel ancien | ≈ 8 à 12 min | ≈ 15 à 20 min | ≈ 35 à 45 min |
| Processeur seul, 8 cœurs, compression rapide | ≈ 10 à 15 min | ≈ 25 à 35 min | plus d'1 h |
| Processeur seul, 2 cœurs (ordinateur portable ancien) | ≈ 40 à 60 min | — | — |

Ce sont des estimations à confirmer par des essais. On en tire trois règles :

- **L'encodage matériel est indispensable** pour tenir l'objectif sur un ordinateur ordinaire. Le processeur seul n'y arrive qu'avec beaucoup de cœurs, et seulement en 1080p.
- **La résolution de sortie est le levier principal.** Passer de 4K à 1080p divise environ par quatre le travail de compression.
- **Une vidéo à 60 images par seconde demande deux fois plus de travail** qu'à 30.

Sur un ordinateur portable, la chaleur peut aussi faire baisser la vitesse au bout de quelques dizaines de minutes.

**Réglages de compression pour la vitesse :**
- encodeur matériel dans son mode le plus rapide (sur Intel, le mode « basse consommation », qui utilise un circuit dédié) ;
- débit élevé et fixe, qui compense la compression moins soignée des modes rapides ;
- aucune analyse en deux passes.

**Le mode logiciel, découpé en tranches parallèles**

Sans accélération matérielle, un seul encodeur logiciel n'utilise pas bien tous les cœurs du processeur. La vidéo est alors découpée en **tranches de quelques minutes**, encodées **en parallèle** (une par groupe de cœurs), puis **recollées sans réencodage**. La permutation étant fixe, les tranches sont indépendantes : n'importe quelle tranche peut être traitée n'importe quand.

**Deux réglages de sortie**

- **Rapide** (par défaut) : l'application choisit **la plus haute résolution qui tient l'objectif de 10 minutes par heure** sur l'ordinateur utilisé. Pour le savoir, elle fait un **essai de 5 secondes** au premier lancement (puis à chaque changement de matériel), dans chaque résolution, et mémorise les vitesses mesurées. Sur une carte graphique récente, ce sera 4K ou 1440p ; sur un ordinateur modeste, 1080p.
- **Qualité maximale** : sortie en **4K** (ou 1440p), quel que soit le temps nécessaire. L'application affiche la durée estimée avant de lancer.

**Ce que coûte la sortie en 1080p :** on perd l'astuce qui consiste à envoyer en 1440p ou 4K pour que YouTube utilise un meilleur format de compression. La vidéo reste robuste (les blocs sont alignés dans toutes les qualités à partir de 720p), mais un peu moins nette en 720p. C'est le prix de la rapidité.

**Débit de sortie**

Assez élevé pour que YouTube parte d'une bonne source, mais pas au point de produire des fichiers ingérables : environ **30 Mbit/s en 1440p** et **60 Mbit/s en 4K**. Pour 3 heures, ça donne un fichier de 40 à 80 Go, sous la limite de YouTube (256 Go ou 12 heures).

**Le son, traité à part et en premier**

Le brouillage du son revient à recopier des morceaux de mémoire : c'est quasi instantané. Avec la lecture et la compression du son, compter **une à deux minutes pour 3 heures**. Il est fait **avant** l'image, en flux continu (sans charger des heures de son en mémoire), dans un fichier temporaire (AAC à 320 kbit/s, environ 400 Mo pour 3 heures). La compression de l'image l'intègre ensuite directement au fichier final.

**Reprise après interruption**

Pour une vidéo de plusieurs heures, une coupure (mise en veille, plantage, fermeture par erreur) ne doit pas faire tout perdre. La vidéo est écrite par **tranches de 10 minutes** :
- à la relance, l'application repère les tranches déjà terminées et **reprend à la suivante** ;
- à la fin, les tranches sont **recollées sans réencodage** en un seul fichier, ce qui prend quelques secondes.

**Pendant l'encodage**, l'application **empêche la mise en veille** de l'ordinateur.

### 6.2 Interface graphique

L'interface est une application de bureau native. Sur GNOME, GTK 4 avec libadwaita donne une application parfaitement intégrée ; si elle doit aussi tourner sous Windows ou macOS, on utiliserait Qt à la place.

**Avant l'encodage**

- **Choix de la vidéo** : bouton « Ouvrir » ou **glisser-déposer**. L'application affiche aussitôt une vignette, la durée, la résolution, la fréquence d'images et la taille.
- **Réglages**, avec des valeurs par défaut qui conviennent dans la plupart des cas :
  - sortie **Rapide** (résolution choisie automatiquement pour tenir 10 minutes par heure) ou **Qualité maximale** (4K) ;
  - **clé** : générée automatiquement, ou saisie ;
  - **nombre d'images de QR code** (1 par défaut) ;
  - **dossier de destination** (par défaut, à côté de la vidéo d'origine).
- **Matériel détecté**, par exemple « Carte graphique NVIDIA : encodage accéléré ».
- **Estimation** de la durée d'encodage (issue de l'essai de vitesse) et de la taille du fichier final, avec la résolution choisie, par exemple « 1080p — environ 11 min ».
- **Aperçu** : une image de la vidéo, brouillée et débrouillée, pour vérifier le résultat avant de lancer.
- **File d'attente** : on peut ajouter plusieurs vidéos, traitées l'une après l'autre.

**Pendant l'encodage**

- **Étape en cours** : « Son » → « Image » → « Assemblage ».
- **Barre de progression** en pourcentage, calculée sur le nombre d'images traitées par rapport au total.
- **Chiffres en direct**, mis à jour plusieurs fois par seconde :
  - images traitées sur le total (« 142 350 / 324 000 ») ;
  - vitesse (« 186 images/s — ×6,2 le temps réel ») ;
  - temps écoulé et **temps restant estimé** ;
  - taille actuelle du fichier.
- **Aperçu vivant** : la dernière image brouillée, rafraîchie chaque seconde.
- Boutons **Pause** / **Reprendre** et **Annuler**. En cas d'annulation, l'application propose de garder les tranches terminées pour reprendre plus tard.
- **Progression visible hors de la fenêtre** : dans le dock d'Ubuntu (barre sur l'icône) et dans le titre de la fenêtre (« 44 % — Encodage »).
- **Journal détaillé**, replié par défaut, pour diagnostiquer un problème.

**À la fin**

- **Notification** du bureau : « Encodage terminé — 2 h 47 min de vidéo en 38 min ».
- **Vérification automatique** : l'application débrouille une dizaine d'images prises au hasard dans le fichier final et les compare à l'original. Ça prend quelques secondes et confirme que le fichier sera bien décodé par l'extension.
- **Récapitulatif** : fichier produit, taille, durée, clé utilisée et son QR code.
- Boutons **Ouvrir le dossier** et **Encoder une autre vidéo**.

**En cas d'erreur**, un message clair en français (« Pas assez d'espace disque : il faut environ 60 Go, il en reste 23 ») plutôt qu'une erreur technique brute, avec le journal détaillé disponible.

**Fluidité de l'interface :** l'encodage tourne dans un **processus séparé**. L'interface reste réactive en permanence, et ne reçoit que de courts messages de progression.

### 6.3 Étapes de l'encodage

**Préparation :**
1. Analyser la vidéo (durée, nombre d'images, fréquence, présence de son) avec ffprobe.
2. Générer la clé si elle n'est pas fournie, et calculer la permutation et les transformations.
3. Créer le **QR code** `BRV1:32X18:CLÉ`, en mode alphanumérique et en correction maximale, noir sur blanc, sur 90 % de la hauteur.

**Son (une à deux minutes pour 3 heures) :**
1. **Ajouter au début** 0,6 seconde d'ouverture, commençant par le **bip de repère**.
2. **Brouiller** : découper en morceaux de 60 ms avec leurs marges, mélanger et retourner dans chaque fenêtre de 8, recoller par fondus croisés.
3. **Avancer le son de 480 ms** par rapport à l'image.

**Image (l'essentiel du temps) :**
1. **Ajouter** l'ouverture **avant** la première image de la vidéo, sans rien remplacer : les images du QR code (1 par défaut, réglable), puis du noir jusqu'à 0,6 seconde.
2. Pour chaque image de la vidéo : **mettre en 16:9 exact** à la résolution de sortie, **brouiller** (576 blocs, marge de sécurité, retournements, négatifs, permutation), **compresser**.
3. **Garder exactement la fréquence d'images d'origine.**

**Assemblage (quelques secondes) :** recoller les tranches et y joindre le son, sans réencodage.

**Mise en ligne :** publier de préférence en **non répertorié**, pour éviter les signalements sur une vidéo « illisible ».

---

## 7. Le décodeur (extension de navigateur)

C'est une extension pour Firefox et Chrome.

### Interface

Un petit menu, accessible depuis l'icône de l'extension, contient :
- une case **« Décodage actif »** ;
- un champ **Clé manuelle**, facultatif : il ne sert que pour une vidéo dont le QR code serait illisible.

**Il n'y a pas de détection automatique de l'activation.** C'est l'utilisateur qui active ou désactive le décodage. Quand il est actif, il s'applique à **toutes les vidéos** qu'il regarde. La clé, elle, est trouvée automatiquement grâce au QR code.

### L'image

1. **Repérer les vidéos** : le script de l'extension cherche les éléments `<video>` de la page, au chargement puis régulièrement, car YouTube change de vidéo sans recharger la page.
2. **Trouver la clé** : QR code, mémoire de l'extension, ou clé manuelle (section 2).
3. **Poser un calque** : un **canvas par-dessus** le lecteur, qui laisse passer les clics. Les commandes (pause, barre de progression, plein écran, choix de la qualité) restent utilisables.
4. **Débrouiller chaque image** en un seul passage sur la carte graphique. Pour chaque pixel affiché :
   - trouver son bloc et sa position dans le bloc ;
   - lire dans la table l'emplacement du bloc brouillé et ses transformations ;
   - lire le pixel correspondant, à l'intérieur de la marge, à la position retournée si besoin ;
   - appliquer le négatif si besoin ;
   - adoucir si le pixel est près d'une jointure.

Les positions sont calculées **en proportion de l'image**, donc le décodage fonctionne quelle que soit la qualité choisie, et suit automatiquement les changements de qualité en cours de lecture.

### Garder la fréquence d'images d'origine

C'est le point central. Les règles :

- **Une image traitée exactement une fois.** Le navigateur signale chaque nouvelle image de la vidéo (`requestVideoFrameCallback`). L'extension la traite à ce moment-là : elle n'en saute aucune et ne retraite jamais la même.
- **Tout sur la carte graphique.** Envoi de l'image et remise en ordre des blocs en un seul passage (WebGL, ou WebGPU quand il est disponible, qui évite même la copie de l'image). En 4K, c'est **environ une milliseconde** par image, alors qu'on dispose de 16 ms à 60 images par seconde.
- **Rien sur le processeur pendant la lecture.** Pas de boucle en JavaScript sur les pixels ou les blocs, pas de relecture des pixels vers le processeur, aucune allocation de mémoire à chaque image. Seule exception : la lecture du QR code, limitée au début de la vidéo.
- **Pas de calcul pour les vidéos cachées.** Les vidéos hors écran ou en pause ne sont pas retraitées tant que leur image ne change pas.

### Le son

1. **Créer un contexte audio** (Web Audio).
2. **Faire passer le son de la vidéo par l'extension** : il ne sort plus directement vers les haut-parleurs.
3. **Désactiver la conservation de la hauteur** du son de la vidéo (section 4, vitesse de lecture).
4. **Débrouiller dans un AudioWorklet**, un petit module qui tourne en temps réel à part de la page : il accumule une fenêtre, remet les morceaux dans l'ordre et à l'endroit, et refait les jointures par fondus croisés.
5. **Caler** au démarrage et après chaque saut (section 4).
6. **Envoyer le résultat** vers les haut-parleurs.

Le volume et la sourdine du lecteur YouTube continuent de fonctionner normalement, puisque le son passe toujours par l'élément vidéo.

**Points délicats :**
- **Un branchement est définitif.** Une fois le son d'une vidéo détourné, on ne peut plus le rebrancher directement. Quand le décodage est désactivé, ou pour une vidéo sans clé, le module passe donc en mode **transparent** (il laisse passer le son tel quel, sans retard).
- **Démarrage du son.** Les navigateurs bloquent le son tant que l'utilisateur n'a pas interagi avec la page. Le contexte audio est relancé quand la lecture démarre.
- **Sites où l'image est illisible** (vidéo chargée depuis un autre domaine sans autorisation) : le son détourné deviendrait un silence. L'extension vérifie donc d'abord qu'elle peut lire l'image ; sinon, elle ne touche ni à l'image ni au son.

### Pourquoi ça marche sur YouTube

Le script de l'extension s'exécute **dans la page YouTube** : il a donc le droit de lire l'image et le son de la vidéo, contrairement à un site tiers qui intégrerait le lecteur. Les vidéos protégées par DRM (films loués…) donnent une image noire, mais ça ne concerne pas les vidéos qu'on publie soi-même.

---

## 8. Limites

- **Sécurité quasi nulle** : la clé est lisible par tous dans le QR code. Le système empêche seulement de regarder et d'écouter la vidéo sans l'extension.
- **Qualités inférieures à 720p** : le décodage fonctionne encore, mais les jointures entre blocs deviennent visibles. Elles ne sont pas garanties.
- **Fragments reconnaissables** : on devine parfois des textures ou des couleurs dominantes dans l'image brouillée, malgré les 576 blocs, les retournements et les négatifs.
- **Une demi-seconde de silence** au démarrage et après chaque saut dans la vidéo, le temps de recevoir une fenêtre de son.
- **Vitesse différente de ×1** : le son devient plus aigu ou plus grave.
- **Premier visionnage commencé au milieu de la vidéo** : l'extension doit revenir un instant au début pour lire le QR code.
- **Qualité d'image légèrement réduite** : une image brouillée se compresse un peu moins bien, et la marge coûte environ 12 % de résolution. En 720p, l'image décodée est un peu moins nette qu'une vidéo normale dans la même qualité.
- **Copie de l'image sur Firefox sous Linux** : selon la configuration, l'envoi de l'image à la carte graphique peut passer par le processeur et coûter quelques millisecondes par image. Ça reste compatible avec 60 images par seconde en 1080p, mais c'est le premier endroit à surveiller si la fluidité baisse.
- **Tout reste théorique** : les chiffres (taille des blocs, marges, durée des morceaux) sont des valeurs de départ raisonnables, à ajuster après de vrais essais sur YouTube dans chaque qualité.
- **Installation** : sur Firefox, une extension non signée disparaît à chaque redémarrage. Pour une installation durable, il faut la faire signer par Mozilla, gratuitement via addons.mozilla.org, sans obligation de la publier.
