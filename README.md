# DAE Analyzer

App Next.js: trascini un file COLLADA (`.dae`) e ottieni l'elenco dei dati che contiene,
con anteprima 3D. L'analisi avviene tutta nel browser.

```bash
npm install
npm run dev
```

Apri http://localhost:3000 e trascina un `.dae` (c'è un esempio in `public/esempio-cubo.dae`).

Mostra in card i dati principali (versione, software, unità, asse verticale, conteggi di
vertici, triangoli, materiali, texture, nodi, luci, camere, animazioni, ingombro) e il modello 3D.

Lista componenti: ogni pezzo del modello (figli del nodo radice, es. componenti SketchUp) con nome,
ruolo stimato (fianco, ripiano, anta, schiena…), quantità, misure in mm, spessore e quota da terra.
Hover su una riga → il pezzo si evidenzia nel 3D; hover sul 3D → tooltip e riga evidenziata.
Logica in `lib/components.ts`.

Codice: `lib/collada.ts` (parser), `app/page.tsx` (interfaccia), `components/Preview.tsx` (three.js).

Esporta preventivo Excel: compila il foglio "materiali" del template `public/templates/preventivo-template.xlsx`
a partire dalla sezione 9 (le sezioni 1–8 restano intatte): una sezione "DIMENSIONI PEZZI mm" per ogni colore +
spessore, con titolo, descrizione, spessore e pezzi h × l × qtà (h = lato lungo). Gli altri campi restano quelli del
template. Oltre la sezione 10 ne vengono create di nuove copiando la 10, e vengono aggiunte al totale nel foglio "totali". Esclusi ferramenta,
blocchi spessi, superfici senza spessore e accessori. Logica in `lib/preventivo.ts`.
Il template fa parte del progetto: per cambiarlo sostituisci quel file.
