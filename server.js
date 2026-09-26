// StudyDeck: a local web app over your own notes. All inference runs on this
// machine through the QVAC SDK (embed for retrieval, completion for answers/quiz).
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
    loadModel, embed, completion, close,
    QWEN3_1_7B_INST_Q4, EMBEDDINGGEMMA_300M_Q4_0,
} from '@qvac/sdk';

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const MAX_PDF_BYTES = 20 * 1024 * 1024;
const MAX_PDF_PAGES = 200;
let chunks = []; // [{ text, vec }]
const models = {}; // name -> Promise<modelId>, each model is loaded once

const getModel = (name, src) => (models[name] ??= loadModel({
    modelSrc: src,
    onProgress: (() => {
        let lastPercentage = -1;
        return (p) => {
            const percentage = Math.floor(p.percentage);
            if (percentage > lastPercentage) {
                lastPercentage = percentage;
                process.stdout.write(`[${name}] downloading ${percentage}%\n`);
            }
        };
    })(),
}).catch((error) => {
    delete models[name];
    throw error;
}));

function splitNotes(text, max = 600) {
    const out = [];
    let cur = '';
    for (const para of text.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean)) {
        let part = '';
        for (const word of para.split(/\s+/)) {
            if (part && part.length + word.length + 1 > max) {
                if (cur && cur.length + part.length + 2 > max) { out.push(cur); cur = ''; }
                cur += (cur ? '\n\n' : '') + part;
                part = '';
            }
            part += (part ? ' ' : '') + word;
        }
        if (part) {
            if (cur && cur.length + part.length + 2 > max) { out.push(cur); cur = ''; }
            cur += (cur ? '\n\n' : '') + part;
        }
    }
    if (cur) out.push(cur);
    return out;
}

function readPdfBody(req) {
    return new Promise((resolve, reject) => {
        const parts = [];
        let size = 0;
        let tooLarge = false;
        req.on('data', (part) => {
            size += part.length;
            if (size > MAX_PDF_BYTES) {
                tooLarge = true;
                parts.length = 0;
            } else if (!tooLarge) {
                parts.push(part);
            }
        });
        req.on('end', () => {
            if (tooLarge) {
                const error = new Error('PDF is too large. Choose a file smaller than 20 MB.');
                error.statusCode = 413;
                reject(error);
            } else {
                resolve(Buffer.concat(parts));
            }
        });
        req.on('error', reject);
    });
}

async function extractPdfPages(bytes) {
    if (!bytes.length || bytes.subarray(0, 1024).indexOf(Buffer.from('%PDF-')) === -1) {
        const error = new Error('This does not look like a valid PDF file.');
        error.statusCode = 400;
        throw error;
    }

    const loadingTask = getDocument({ data: new Uint8Array(bytes), useSystemFonts: true });
    const pdf = await loadingTask.promise;
    try {
        if (pdf.numPages > MAX_PDF_PAGES) {
            const error = new Error(`This PDF has ${pdf.numPages} pages. The limit is ${MAX_PDF_PAGES} pages.`);
            error.statusCode = 413;
            throw error;
        }

        const pages = [];
        for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
            const page = await pdf.getPage(pageNumber);
            const content = await page.getTextContent();
            const text = content.items
                .map((item) => `${typeof item.str === 'string' ? item.str : ''}${item.hasEOL ? '\n' : ' '}`)
                .join('')
                .replace(/[ \t]+\n/g, '\n')
                .trim();
            if (text) pages.push({ page: pageNumber, text });
        }
        return { pageCount: pdf.numPages, pages };
    } finally {
        await loadingTask.destroy();
    }
}

const cosine = (a, b) => {
    let d = 0, x = 0, y = 0;
    for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; x += a[i] ** 2; y += b[i] ** 2; }
    return d / (Math.sqrt(x * y) || 1);
};

async function topChunks(question, k = 3) {
    const { embedding } = await embed({ modelId: await getModel('embed', EMBEDDINGGEMMA_300M_Q4_0), text: question });
    return chunks
        .map((c, i) => ({ i, text: c.text, page: c.page, score: cosine(embedding, c.vec) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, k);
}

function parseMultipleChoice(text) {
    const cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/<think>[\s\S]*$/, '').trim();
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start < 0 || end < start) throw new Error('The response did not contain a JSON object.');
    const generated = JSON.parse(cleaned.slice(start, end + 1));
    const ids = ['A', 'B', 'C', 'D'];
    if (typeof generated.question !== 'string' || !generated.question.trim()
        || !Array.isArray(generated.options) || generated.options.length !== ids.length
        || typeof generated.explanation !== 'string' || !generated.explanation.trim()) {
        throw new Error('The response is missing quiz fields.');
    }
    const options = generated.options.map((option, index) => ({
        id: typeof option === 'string' ? ids[index] : option?.id,
        text: typeof option === 'string' ? option.trim() : option?.text?.trim(),
    }));
    if (options.some((option) => !option.text)
        || options.some((option) => !ids.includes(option.id))
        || new Set(options.map((option) => option.text.toLocaleLowerCase())).size !== ids.length
        || new Set(options.map((option) => option.id)).size !== ids.length) {
        throw new Error('The response has invalid answer options.');
    }
    const answer = typeof generated.correctAnswer === 'string' ? generated.correctAnswer.trim() : '';
    const answerIndex = generated.options.findIndex((option, index) => (
        options[index].id === answer.toUpperCase()
        || (typeof option === 'string' ? option : option?.text)?.trim() === answer
    ));
    if (answerIndex < 0) throw new Error('The response does not identify a valid correct answer.');
    const explanation = generated.explanation.trim()
        .replace(/\b(?:option|choice)\s+[A-D]\b/gi, 'this answer')
        .split(/(?<=[.!?])\s+/)
        .filter((sentence) => !/\b(?:other options|distractors|incorrect options|this answer is (?:incorrect|wrong)|(?:statement|answer) is [A-D])\b/i.test(sentence))
        .join(' ')
        .trim() || 'The cited passage supports this answer.';
    return {
        question: generated.question.trim(),
        options,
        correctAnswer: options[answerIndex].id,
        explanation,
    };
}

function shuffleQuestionOptions(question) {
    const options = [...question.options];
    for (let index = options.length - 1; index > 0; index--) {
        const swap = Math.floor(Math.random() * (index + 1));
        [options[index], options[swap]] = [options[swap], options[index]];
    }
    const correctText = question.options.find((option) => option.id === question.correctAnswer)?.text;
    const ids = ['A', 'B', 'C', 'D'];
    const shuffled = options.map((option, index) => ({ id: ids[index], text: option.text }));
    return {
        ...question,
        options: shuffled,
        correctAnswer: ids[shuffled.findIndex((option) => option.text === correctText)],
    };
}

async function generateMultipleChoice(modelId, passages) {
    let lastError;
    const maxAttempts = Math.min(3, passages.length);
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const passage = passages[attempt];
        const formatReminder = attempt
            ? '\n\nFormatting check: return complete valid JSON with four distinct options and the correctAnswer matching the right option.'
            : '';
        const prompt = `Create one multiple-choice study question using ONLY the source passage below. Test an explicit fact stated in the passage. Exactly one option must be correct, and correctAnswer must identify that option by its id. The explanation must state the source fact that supports the correct option. Do not refer to option letters or discuss why other options are wrong. Make the other three options plausible but clearly incorrect.\n\nSource passage:\n<<<\n${passage.text}\n>>>${formatReminder}`;
        try {
            const run = completion({
                modelId, stream: true,
                history: [{ role: 'user', content: `${prompt}\n\n/no_think` }],
                responseFormat: {
                    type: 'json_schema',
                    json_schema: {
                        name: 'study_question',
                        strict: true,
                        schema: {
                            type: 'object',
                            additionalProperties: false,
                            required: ['question', 'options', 'correctAnswer', 'explanation'],
                            properties: {
                                question: { type: 'string' },
                                options: {
                                    type: 'array',
                                    minItems: 4,
                                    maxItems: 4,
                                    items: {
                                        type: 'object',
                                        additionalProperties: false,
                                        required: ['id', 'text'],
                                        properties: {
                                            id: { type: 'string', enum: ['A', 'B', 'C', 'D'] },
                                            text: { type: 'string' },
                                        },
                                    },
                                },
                                correctAnswer: { type: 'string', enum: ['A', 'B', 'C', 'D'] },
                                explanation: { type: 'string' },
                            },
                        },
                    },
                },
                generationParams: { temp: 0.1, predict: 600 },
            });
            let full = '';
            for await (const token of run.tokenStream) full += token;
            const generated = parseMultipleChoice(full);
            return { ...shuffleQuestionOptions(generated), passage };
        } catch (error) {
            lastError = error;
            console.warn(`Quiz generation attempt ${attempt + 1} failed: ${error.message}`);
        }
    }
    throw new Error(`Quiz question generation failed after ${maxAttempts} attempts: ${lastError?.message || 'invalid response'}`);
}

// Streams: first line is JSON metadata, then a blank line, then the model text.
async function stream(res, prompt, meta, { predict = 400 } = {}) {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.write(JSON.stringify(meta) + '\n\n');
    const modelId = await getModel('llm', QWEN3_1_7B_INST_Q4);
    const run = completion({
        modelId, stream: true,
        history: [{ role: 'user', content: `${prompt}\n\n/no_think` }],
        generationParams: { temp: 0.3, predict },
    });
    let full = '', sent = 0;
    for await (const token of run.tokenStream) {
        full += token;
        const visible = full.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/<think>[\s\S]*$/, '');
        res.write(visible.slice(sent));
        sent = visible.length;
    }
    res.end();
}

const body = (req) => new Promise((ok) => {
    let s = '';
    req.on('data', (d) => (s += d));
    req.on('end', () => ok(s ? JSON.parse(s) : {}));
});

const routes = {
    'POST /api/notes': async (req, res) => {
        const parts = splitNotes((await body(req)).text || '');
        if (!parts.length) return json(res, 400, { error: 'Paste some notes first.' });
        const { embedding } = await embed({ modelId: await getModel('embed', EMBEDDINGGEMMA_300M_Q4_0), text: parts });
        chunks = parts.map((text, i) => ({ text, vec: embedding[i], page: null }));
        json(res, 200, { chunks: chunks.length });
    },
    'POST /api/pdf': async (req, res) => {
        const { pageCount, pages } = await extractPdfPages(await readPdfBody(req));
        const passages = pages.flatMap(({ page, text }) => splitNotes(text).map((passage) => ({ text: passage, page })));
        if (!passages.length) {
            const error = new Error('No selectable text was found. This may be a scanned or image-only PDF; OCR is not supported.');
            error.statusCode = 422;
            throw error;
        }
        const { embedding } = await embed({
            modelId: await getModel('embed', EMBEDDINGGEMMA_300M_Q4_0),
            text: passages.map((passage) => passage.text),
        });
        chunks = passages.map((passage, i) => ({ ...passage, vec: embedding[i] }));
        json(res, 200, {
            chunks: chunks.length,
            pages: pageCount,
            pagesWithText: pages.length,
            skippedPages: pageCount - pages.length,
        });
    },
    'POST /api/ask': async (req, res) => {
        const { question } = await body(req);
        if (typeof question !== 'string' || !question.trim()) return json(res, 400, { error: 'Enter a question first.' });
        if (!chunks.length) return json(res, 400, { error: 'Index your notes first.' });
        const hits = await topChunks(question);
        const context = hits.map((h, n) => `[${n + 1}] ${h.page ? `(PDF page ${h.page}) ` : ''}${h.text}`).join('\n\n');
        await stream(res, `Answer the question using ONLY the notes below. Cite passages like [1]. If the notes do not contain the answer, say so.\n\nNotes:\n${context}\n\nQuestion: ${question}`,
            { sources: hits.map(({ text, page }) => ({ text, page })) });
    },
    'POST /api/quiz-round': async (req, res) => {
        if (!chunks.length) return json(res, 400, { error: 'Index your notes first.' });
        await body(req);
        const order = chunks.map((_, index) => index);
        for (let index = order.length - 1; index > 0; index--) {
            const swap = Math.floor(Math.random() * (index + 1));
            [order[index], order[swap]] = [order[swap], order[index]];
        }
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' });
        res.flushHeaders?.();
        try {
            const modelId = await getModel('llm', QWEN3_1_7B_INST_Q4);
            for (let index = 0; index < 5; index++) {
                const candidates = order.slice(index).concat(order.slice(0, index));
                const generated = await generateMultipleChoice(modelId, candidates.map((chunkIndex) => chunks[chunkIndex]));
                res.write(`${JSON.stringify({
                    type: 'question',
                    question: {
                        question: generated.question,
                        options: generated.options,
                        correctAnswer: generated.correctAnswer,
                        explanation: generated.explanation,
                    },
                    source: { text: generated.passage.text, page: generated.passage.page },
                })}\n`);
                res.write(`${JSON.stringify({ type: 'progress', completed: index + 1, total: 5 })}\n`);
            }
            res.end(`${JSON.stringify({ type: 'complete', total: 5 })}\n`);
        } catch (error) {
            console.error(error);
            res.end(`${JSON.stringify({ type: 'error' })}\n`);
        }
    },
    'POST /api/grade': async (req, res) => {
        const { chunk, question, answer } = await body(req);
        if (!Number.isInteger(chunk) || !chunks[chunk]) return json(res, 400, { error: 'Generate a quiz question first.' });
        if (typeof answer !== 'string' || !answer.trim()) return json(res, 400, { error: 'Write your answer first.' });
        await stream(res, `A student answered a quiz question. Using the passage, say if the answer is correct, partly correct or wrong, then give the correct answer in one or two sentences.\n\nPassage:\n${chunks[chunk]?.text}\n\nQuestion: ${question}\nStudent answer: ${answer}`, {});
    },
};

const json = (res, code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
};

http.createServer(async (req, res) => {
    const handler = routes[`${req.method} ${req.url}`];
    try {
        if (handler) return await handler(req, res);
        const file = req.url === '/' ? 'index.html' : req.url.slice(1);
        if (file.includes('..')) return json(res, 400, {});
        res.writeHead(200, { 'Content-Type': file.endsWith('.html') ? 'text/html' : 'text/plain' });
        res.end(await readFile(path.join(PUBLIC, file)));
    } catch (e) {
        console.error(e);
        if (res.headersSent) {
            if (res.getHeader('Content-Type')?.toString().includes('application/x-ndjson')) {
                return res.end(`${JSON.stringify({ type: 'error' })}\n`);
            }
            return res.end(`\n[error: ${e.message}]`);
        }
        json(res, e.statusCode || 500, { error: e.message });
    }
}).listen(PORT, '127.0.0.1', () => console.log(`StudyDeck running at http://127.0.0.1:${PORT}`));

process.on('SIGINT', async () => { await close().catch(() => { }); process.exit(0); });
