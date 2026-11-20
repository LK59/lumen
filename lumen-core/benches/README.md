# Bancs d'identité

Ils répondent à une seule question : **ce moteur produit-il les mêmes octets que celui dont il vient ?**
Ce ne sont pas des tests — ils ne jugent pas une sortie, ils en comparent deux — et ils sont sautés sans
leurs variables d'environnement.

| Banc | Ce qu'il empreinte |
|---|---|
| `remux-hash-bench.spec.ts` | Les segments d'initialisation et douze segments fMP4 depuis le début, puis douze après un saut à 30 % et à 60 % du film (SHA-256 de chaque segment vidéo et son, et l'instant de fin) |
| `audio-ref-bench.spec.ts` | Par piste son, en cinq points du film : les paquets lus (octets et instants) et, pour ce que Node décode (AC-3, E-AC3, DTS, FLAC, PCM, TrueHD), trente secondes de son décodé (plans Float32, instants, canaux) |
| `pistes.spec.ts` | Rien : il dresse la liste des pistes son au format qu'attend le précédent |

## Comparer à l'original

`LUMEN_REF` désigne la racine d'une copie de Laterna montée en lecture seule : son moteur prend alors la
place de `src/engine/` sous le même banc (voir `vitest.config.ts`). On lance deux fois, on compare.

```sh
bench() {  # $1 : nom de la sortie ; le reste : options de docker
  out=$1; shift
  docker run --rm --cpus=6 --name "lumen-bench-$out" --user "$(id -u):$(id -g)" -e HOME=/tmp \
    -v "$PWD":/app -v "$MEDIAS":"$MEDIAS":ro "$@" -w /app \
    -e REMUX_FILES=/app/benches/out/titres.txt -e REMUX_OUT=/app/benches/out/remux-$out.jsonl \
    -e AR_TRACKS=/app/benches/out/pistes.tsv   -e AR_OUT=/app/benches/out/son-$out.jsonl \
    node:26-alpine npx vitest run benches/remux-hash-bench.spec.ts benches/audio-ref-bench.spec.ts
}
bench origine -e LUMEN_REF=/ref -v /chemin/de/laterna:/ref:ro
bench lumen

cmp benches/out/remux-origine.jsonl benches/out/remux-lumen.jsonl
diff <(jq -c 'del(.. | .ms?)' benches/out/son-origine.jsonl) <(jq -c 'del(.. | .ms?)' benches/out/son-lumen.jsonl)
```

`benches/out/titres.txt` : un chemin de fichier par ligne. `benches/out/pistes.tsv` s'obtient avec
`PISTES_FILES=…/titres.txt PISTES_OUT=…/pistes.tsv npx vitest run benches/pistes.spec.ts`. `benches/out/`
n'entre pas dans le dépôt : ses fichiers nomment ceux d'une bibliothèque.

Les sorties s'ajoutent à la fin du fichier (`appendFileSync`) : effacer celles d'un passage précédent.
