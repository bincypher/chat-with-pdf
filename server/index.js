require("dotenv").config();
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const _pdfParseModule = require('pdf-parse');
const pdfParse = _pdfParseModule && _pdfParseModule.default ? _pdfParseModule.default : _pdfParseModule;
const fs = require("fs");
const { GoogleGenAI } = require("@google/genai");
const { QdrantClient } = require("@qdrant/js-client-rest");


const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY
});

const qdrant = new QdrantClient({
    url: process.env.QDRANT_URL,
    apiKey: process.env.QDRANT_API_KEY
});

/* 
What Each Line Does
Code                            What It Does
require("dotenv").config()      Loads your .env variables into process.env
new GoogleGenAI(...)            Creates your Gemini client
process.env.GEMINI_API_KEY      Reads your key from environment safely
*/

const app = express(); //creates you express application
const upload = multer({ dest: "uploads/" }); //creates a multer instance to handle file uploads
app.use(cors()); //Allows browser requests from any origin
app.use(express.json()); // Parses inoming json request bodies
app.use(express.static("public")); // Serves static files from the public folder
/*
Two Different Models — Never Mix Them
Model                       Use For                  Method
gemini-3.5-flash       Generate text answers    generateContent()
gemini-embedding-2          Convert text to vectors  embedContent()
*/


async function createEmbedding(text) {
    const response = await ai.models.embedContent({
        model: "gemini-embedding-2",
        contents: text
    });
    return response.embeddings[0].values;
}

function cosineSimilarity(vecA, vecB) {
    let dotProduct = 0;
    for (let i = 0; i < vecA.length; i++) {
        dotProduct += vecA[i] * vecB[i];
    }
    return dotProduct;
}

// helper: chunk a single text into overlapped chunks (returns array of strings)
function chunkTextWithOverlap(text, maxLen = 1000, overlap = 200) {
    const paragraphs = text.split(/\n+/).map(p => p.trim()).filter(Boolean);

    const chunks = [];
    let current = "";
    for (const p of paragraphs) {
        const candidate = current ? current + "\n\n" + p : p;
        if (candidate.length <= maxLen) {
            current = candidate;
        } else {
            if (current) chunks.push(current);
            if (p.length > maxLen) {
                chunks.push(p);
                current = "";
            } else {
                current = p;
            }
        }
    }
    if (current) chunks.push(current);

    const overlapped = [];
    for (let i = 0; i < chunks.length; i++) {
        let chunk = chunks[i];
        if (i > 0) {
            const prev = overlapped[overlapped.length - 1];
            const tail = prev.slice(-overlap);
            chunk = tail + "\n\n" + chunk;
        }
        overlapped.push(chunk);
    }
    return overlapped.map(c => c.trim()).filter(Boolean);
}

// new metadata-aware chunker: returns [{ text, docName, page, chunkIndex }]
function splitTextIntoChunksWithMeta(pdfData, fileName, maxLen = 1000, overlap = 200) {
    const raw = pdfData && pdfData.text ? pdfData.text : "";
    // pdf-parse often separates pages with form-feed '\f'; fallback to whole text if not present
    const pages = raw.includes("\f") ? raw.split(/\f/) : [raw];
    const result = [];
    for (let p = 0; p < pages.length; p++) {
        const pageText = pages[p].trim();
        if (!pageText) continue;
        const pageChunks = chunkTextWithOverlap(pageText, maxLen, overlap);
        for (let ci = 0; ci < pageChunks.length; ci++) {
            result.push({
                text: pageChunks[ci],
                docName: fileName,
                page: p + 1,
                chunkIndex: ci,
            });
        }
    }
    return result;
}


//create a route for the home page
app.get("/", async (req, res) => {
    res.send("AI backend is running!"); // sends a response back to the browser
});

//create a route for creating a collection in Qdrant
app.get("/create-collection", async (req, res) => {
    try {
        await qdrant.createCollection("pdf-docs", {
            vectors: { size: 3072, distance: "Cosine" },
        });
        res.send("Collection created");
    } catch (error) {
        res.status(500).send("Error creating collection: " + error.message);
    };
});

//create a route for file uploads
app.post("/upload", upload.single("pdf"), async (req, res) => {
    try {
        const dataBuffer = fs.readFileSync(req.file.path); //reads the uploaded file from the uploads folder
        // console.log('dataBuffer',dataBuffer);
        const pdfData = await pdfParse(dataBuffer);
        // console.log(pdfData.text);

        const chunks = splitTextIntoChunksWithMeta(pdfData, req.file.originalname, 1000, 200);
        console.log('chunks:', chunks.length);


        const embedding = await createEmbedding(chunks[0].text);
        console.log(embedding.length);  // Should print: 3072, As of June 2024, Gemini embeddings are 3072 dimensions

        // create embeddings for each chunk
        const chunkEmbeddings = [];
        for (const chunk of chunks) {
            const emb = await createEmbedding(chunk.text);
            chunkEmbeddings.push({ ...chunk, embedding: emb });
        }


        // create stable numeric ids for this upload (use timestamp + index)
        const baseId = Date.now();
        const points = chunkEmbeddings.map((item, i) => ({
            id: baseId + i,
            vector: item.embedding,
            payload: {
                text: item.text,
                docName: item.docName,
                page: item.page,
                chunkIndex: item.chunkIndex,
            },
        }));
        await qdrant.upsert("pdf-docs", { points });


        // handle the question
        const question = req.body.question;
        const questionEmbedding = await createEmbedding(question);

        // top-k search (try 3 or 5)
        const TOP_K = 3;
        const searchResult = await qdrant.search("pdf-docs", {
            vector: questionEmbedding,
            limit: TOP_K,
        });

        // build citations and combined context
        const citations = searchResult.map(r => ({
            docName: r.payload.docName,
            page: r.payload.page,
            chunkIndex: r.payload.chunkIndex,
            snippet: (r.payload.text || "").slice(0, 300),
        }));
        const combinedContext = searchResult.map(r => r.payload.text).join("\n\n---\n\n");


        // prompt the LLM with multiple chunks and ask for citations
        const response = await ai.models.generateContent({
            model: "gemini-3.5-flash",
            contents: `Answer the question using ONLY the following context. When you reference facts, add citations in the format (doc: <docName>, page: <page>). Context:\n\n${combinedContext}\n\nQuestion: ${question}\n\nProvide a concise answer and list your citations at the end.`,
        });

        // return structured JSON
        res.json({
            answer: response.text,
            citations,
        });

        /*        
        Understanding the Code
        Part                             Meaning
        ai.models.generateContent()   Calls Gemini to generate text
        model: "gemini-3.5-flash"     Which Gemini model to use
        contents:                     The full prompt including your PDF content
        response.text                 The generated answer from Gemini
        */

    } catch (error) {
        console.error(error);
        res.status(500).send("Error reading PDF");
    }
});

/* After a file is uploaded, the req.file object will contain information about the uploaded file. Here are some of the properties you can access:
Property                         Value
req.file.path	                 Where the file was saved
req.file.originalname	         Original filename from user
req.file.size	                 File size in bytes
req.file.mimetype	             File type (e.g. application/pdf)


KEY TERMS
Term                   Meaning
fs                     File System — Node.js module for reading/writing files
Buffer                 Raw binary data stored in memory
pdfData.text           The extracted plain text from the PDF
async/await            Waits for PDF parsing to finish before continuing
*/

//starts the server and listens on port 3003
app.listen(3003, () => {
    console.log("Server running on http://localhost:3003");
});