# StudyDeck

StudyDeck is a local-first study partner for your own notes. Ask a question and get an answer grounded in relevant passages, or take a five-question multiple-choice quiz with a score and answer review. AI inference runs on your computer through [QVAC](https://qvac.tether.io/)—there is no AI API key or hosted inference service.

## What it does

- Paste notes into the app, load a `.txt` or `.md` file, or import a text-based PDF.
- Index notes into passages using a local embedding model.
- Ask questions and get answers with the source passages shown.
- Take five-question multiple-choice rounds with a score and review of every correct answer, explanation, and source.
- Open an instant presentation demo with a preloaded five-question photosynthesis quiz and sample answers.
- Stream generated answers into the page as the model responds.
- PDF answers and quiz sources include the original PDF page number.

Notes and embeddings are kept in the running server's memory and are cleared when you stop or restart it. QVAC downloads model files the first time you use each model; inference then runs locally. The web app itself listens only on `127.0.0.1`.

PDF import extracts selectable text locally with PDF.js and indexes it with QVAC. Slide decks exported as text-based PDFs work as well, with PDF page numbers (typically slide numbers) shown for sources. It accepts PDFs up to 20 MB and 200 pages. It does not upload documents to a service. Scanned/image-only pages need OCR, which this version does not provide; a PDF with no selectable text is rejected with an explanation, and pages without text are skipped.

## Requirements

- Node.js **22.17 or newer** and npm.
- Internet access on first use so QVAC can download its models.
- Several gigabytes of free disk space for the models, plus enough available memory to run them. The exact requirements depend on your operating system and hardware.

The first indexing or question request can take a while: it may need to download and initialize the embedding model, and answering or quizzing also loads the language model. The app shows which stage is running; model download percentages appear in the terminal where `npm start` is running. Keep that terminal open while using the app.

## Install

Clone this repository (replace the example owner with the GitHub account or organization that hosts it), then install the dependencies:

```bash
git clone https://github.com/YOUR-USERNAME/studydeck.git
cd studydeck
npm install
```

The app declares [`@qvac/sdk`](https://www.npmjs.com/package/@qvac/sdk) with the `^0.20.0` version range in `package.json`; `package-lock.json` currently resolves it to **0.20.0**.

## Start the app

```bash
npm start
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000) in your browser. To use another local port:

```bash
PORT=3001 npm start
```

Then visit `http://127.0.0.1:3001`.

## Use it

1. Paste notes into **Your notes**, or choose **Upload file** to load a `.txt`, `.md`, or PDF. A PDF is extracted and indexed when selected.
2. For pasted or loaded text, select **Index notes**, or simply enter a question or start a quiz; StudyDeck prepares changed notes automatically. On first use, QVAC may download the embedding model.
3. Under **Ask your notes**, enter a question and select **Ask** (or press Enter). The response streams into the page, with the retrieved passages displayed below it.
4. For a fast walkthrough, select **Try the 5-question demo**. It opens a ready-to-submit sample quiz with answers preselected; change any answer and submit to show the score and full review. This presentation demo is fixed sample content and does not run model inference.
5. To study your own material, choose **Quiz**, then **Build a quiz from my notes**. StudyDeck generates a full round locally in one go. Answer the questions and submit once to see your score, correct answers, explanations, and source passages together.

There is a small example in [`sample-notes.md`](./sample-notes.md) about photosynthesis. Try asking what happens in the light-dependent reactions or where the Calvin cycle occurs. PDF source passages identify their page; pasted and text-file notes do not have page numbers.

## How QVAC is used

The QVAC integration is in [`server.js`](./server.js):

1. For a PDF, PDF.js extracts selectable text locally and keeps its page number with each passage. Text files and pasted notes are split into passages directly.
2. `loadModel` loads `EMBEDDINGGEMMA_300M_Q4_0` for note and question embeddings.
3. `embed` turns note passages into vectors. When you ask a question, the app embeds it too and selects the three closest passages by cosine similarity.
4. `loadModel` loads `QWEN3_1_7B_INST_Q4` when a generated response is needed.
5. `completion` generates and streams answers using selected note passages, or generates multiple-choice questions with options, correct answers, and explanations. Quiz answers stay hidden until the full five-question round is submitted; answer scoring itself is local. Quiz question output uses QVAC's JSON-schema-constrained generation and retries internally if the returned structure is malformed. The presentation demo uses fixed sample content instead of model inference.

The browser talks to the local Node.js server. It does not call an AI cloud API. Model downloads are the exception to being offline: they require network access the first time (or again if the local model cache is missing).

## Troubleshooting

- **`npm start` says the QVAC package cannot be found:** run `npm install` from the project directory.
- **The page does not load:** make sure the server is still running in the terminal, then open the exact local address printed there. If port 3000 is already in use, set `PORT=3001`.
- **The first request appears stalled:** model downloads and initialization can take time. Keep the process running and check its terminal for download progress.
- **Asking or quiz generation takes time:** the first use loads the local chat model. StudyDeck reports search, model loading, and generation progress in the status line; keep the server terminal open to see model download percentages.
- **Quiz generation does not complete:** the app retries malformed model output internally against other note passages. Add more notes and try again if the round still cannot be prepared.
- **Model download or inference fails:** confirm you have internet access for the initial model download, enough disk space, and a supported Node.js version. QVAC's [system requirements](https://docs.qvac.tether.io/system-requirements/) may help diagnose hardware-specific issues.
- **A PDF is rejected as having no selectable text:** it may be scanned or image-only. This version does not run OCR; use a text-based PDF or OCR/export it to text before importing.
- **Some PDF pages are missing from sources:** pages without selectable text are skipped. The status message reports how many pages contained text.
- **A PDF is too large:** this version accepts files up to 20 MB and 200 pages.
- **The app forgets indexed notes:** this version stores notes and vectors in memory only. Index them again after restarting the server.

## Development

Check the server file's JavaScript syntax:

```bash
node --check server.js
```

There is no automated test suite configured yet. A successful syntax check and server startup do not verify model inference; to verify inference, run the app and complete the indexing and question steps above.

## License

This project is licensed under the [MIT License](./LICENSE).
