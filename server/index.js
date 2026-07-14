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

//handling the chunk overlapping
function splitTextIntoChunks(text, maxLen = 1000, overlap = 200) {
  const paragraphs = text
    .split(/\n+/)
    .map(p => p.trim())
    .filter(Boolean);

  const chunks = [];
  let current = "";

  for (const p of paragraphs) {
    const candidate = current ? current + "\n\n" + p : p;
    if (candidate.length <= maxLen) {
      current = candidate;
    } else {
      if (current) chunks.push(current);
      // If single paragraph longer than maxLen, push it alone (still useful)
      if (p.length > maxLen) {
        chunks.push(p);
        current = "";
      } else {
        current = p;
      }
    }
  }
  if (current) chunks.push(current);

  // add overlap by prefixing each chunk with tail of previous chunk
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
    }catch (error) {
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
        
        const chunks = splitTextIntoChunks(pdfData.text, 1000, 200);
        console.log('chunks:', chunks.length);
        console.log('first chunk preview:', chunks[0]?.slice(0, 200));
        
        const embedding = await createEmbedding(chunks[0]);
        console.log(embedding.length);  // Should print: 3072, As of June 2024, Gemini embeddings are 3072 dimensions

        const chunkEmbeddings = [];
        for (const chunk of chunks) {
            const embedding = await createEmbedding(chunk);
            chunkEmbeddings.push({
                text: chunk,
                embedding: embedding,
            });
        }
        /**
         Step by Step 
         Step       Action
         1          Get question from request body
         2          Convert question to a vector
         3          Loop through every chunk vector
         4          Calculate similarity score
         5          If score is better, update best
         6          After loop: bestChunk is the answer
         */
        
         //upsert the chunk embeddings into Qdrant
        const points = chunkEmbeddings.map((item, index) => ({  
            id: index + 1,  
            vector: item.embedding,  
            payload: {    
                text: item.text,  
            },
        }));
        await qdrant.upsert("pdf-docs", { points });


        const question = req.body.question;
        const questionEmbedding = await createEmbedding(question);
        const searchResult = await qdrant.search("pdf-docs", {  
            vector: questionEmbedding,  
            limit: 1,
            /**
             What limit: 1 Means
             limit: 1 returns only the single most similar chunk.
             In production, 
             use limit: 3 or limit: 5 to get multiple relevant chunks and send them all to Gemini — richer context, better answers.
             */
        });
        const bestChunk = searchResult[0].payload.text;


        //sending best chunk to gemini for answer generation
        const response = await ai.models.generateContent({
            model: "gemini-3.5-flash", 
            contents: `Answer the question using only this context: ${bestChunk} 
            Question: ${question}  `,
        });
        res.send(response.text);

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